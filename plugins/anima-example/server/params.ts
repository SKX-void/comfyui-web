/**
 * 表单参数的三个纯函数：上游选项（带缓存）、请求校验、把值写进工作流图。
 *
 * 校验的上下限直接引用 `safety.js` 的 SAFETY —— 与提交前的最终闸门用的是同一份常量，
 * 所以"校验放过去了但闸门拦下来"这种事不可能发生（反过来才会：闸门还查工作流自带的默认值）。
 */
import { SAFETY } from './safety.js';
import { joinPrompt, randomSeed } from './util.js';
import type { ComfyClient } from './comfy.js';
import type { OptionsPayload, RequestBody, ValidatedValues } from './types.js';
import type {
  Graph,
  GraphNode,
  JobValues,
  ResolvedSettings,
  WorkflowBindings,
} from './model.js';

export function createParams({
  comfy,
  settings,
  bindings,
  workflow,
  log,
}: {
  comfy: ComfyClient;
  settings: ResolvedSettings;
  bindings: WorkflowBindings;
  workflow: Graph;
  log: (msg: string) => void;
}) {
  /** 本次装载真正生效的设置（越界已收敛，见 settings.ts） */
  const config = settings.values;
  /** /options 的上游缓存 */
  let optionsCache: { at: number; value: OptionsPayload | null } = { at: 0, value: null };

  async function options(): Promise<OptionsPayload> {
    if (optionsCache.value && Date.now() - optionsCache.at < 60_000) return optionsCache.value;
    let info = null;
    try {
      info = await comfy.objectInfo();
    } catch (err) {
      log(`/object_info 拉取失败（表单只能用手填值）：${err}`);
    }
    const enumOf = (node: string, key: string): string[] => {
      const spec = info?.[node]?.input?.required?.[key] ?? info?.[node]?.input?.optional?.[key];
      const first = Array.isArray(spec) ? spec[0] : null;
      return Array.isArray(first) ? first.map(String) : [];
    };
    const value = {
      reachable: info !== null,
      unet: enumOf('UNETLoader', 'unet_name'),
      clip: enumOf('CLIPLoader', 'clip_name'),
      clipType: enumOf('CLIPLoader', 'type'),
      vae: enumOf('VAELoader', 'vae_name'),
      lora: enumOf('LoraLoader', 'lora_name'),
      sampler: enumOf('KSampler', 'sampler_name'),
      scheduler: enumOf('KSampler', 'scheduler'),
      rotation: enumOf('LatentRotate', 'rotation'),
      defaults: {
        ...bindings.current,
        // 描述词默认留空：工作流里那串文本是质量/风格词，归"正向提示词"（与负向词对称）
        description: '',
        negative: config.negativePrompt,
        steps: config.defaultSteps,
        cfg: config.defaultCfg,
        width: config.defaultWidth,
        height: config.defaultHeight,
        hasRotateNode: bindings.rotateId !== null,
        hasLoraNode: bindings.loraId !== null,
      },
      workflow: { nodes: Object.keys(workflow).length, file: 'workflow.json' },
      bindings: {
        sampler: bindings.samplerId,
        positive: bindings.positiveId,
        negative: bindings.negativeId,
        latent: bindings.latentId,
        rotate: bindings.rotateId,
        lora: bindings.loraId,
        unet: bindings.unetId,
        clip: bindings.clipId,
        vae: bindings.vaeId,
        save: bindings.saveId,
      },
    };
    optionsCache = { at: Date.now(), value };
    return value;
  }

  /** 宁可 400，也不把越界值打到 GPU（上下限见 safety.js） */
  function validate(raw: unknown, opts?: OptionsPayload): ValidatedValues {
    // 请求体是外部输入：不是对象就当成空表单（下面每个字段各自现查）
    const body: RequestBody = raw !== null && typeof raw === 'object' ? (raw as RequestBody) : {};
    const errors: string[] = [];
    const current = bindings.current;
    const pickEnum = (value: unknown, list: string[], fallback: string): string => {
      if (value === undefined || value === null || value === '') return fallback;
      const v = String(value);
      if (list.length > 0 && !list.includes(v)) {
        errors.push(`不是可选值: ${v}`);
        return fallback;
      }
      return v;
    };
    const int = (
      value: unknown,
      fallback: number,
      min: number,
      max: number,
      label: string,
    ): number => {
      if (value === undefined || value === null || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        errors.push(`${label} 必须是 ${min}~${max} 的整数`);
        return fallback;
      }
      return n;
    };
    const float = (
      value: unknown,
      fallback: number,
      min: number,
      max: number,
      label: string,
    ): number => {
      if (value === undefined || value === null || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) {
        errors.push(`${label} 必须是 ${min}~${max} 的数`);
        return fallback;
      }
      return n;
    };

    // 描述词 = 主输入框。兼容旧字段名 prompt（等价于描述词）
    const description =
      typeof body?.description === 'string'
        ? body.description
        : typeof body?.prompt === 'string'
          ? body.prompt
          : '';
    const positive = typeof body?.positive === 'string' ? body.positive : '';
    const negative = typeof body?.negative === 'string' ? body.negative : config.negativePrompt;
    if (description.trim() === '' && positive.trim() === '') {
      errors.push('描述提示词与正向提示词不能同时为空');
    }
    if (description.length > 8000) errors.push('描述提示词过长（>8000）');
    if (positive.length > 8000) errors.push('正向提示词过长（>8000）');
    if (negative.length > 8000) errors.push('负向提示词过长（>8000）');

    const o: Partial<OptionsPayload> = opts ?? {};
    const values = {
      description,
      positive,
      negative,
      seed:
        body?.seed === undefined || body?.seed === null || body?.seed === '' || body?.seed === -1
          ? randomSeed()
          : int(body.seed, randomSeed(), 0, Number.MAX_SAFE_INTEGER, '种子'),
      steps: int(body?.steps, config.defaultSteps, SAFETY.minSteps, SAFETY.maxSteps, '步数'),
      cfg: float(body?.cfg, config.defaultCfg, 0, 30, 'CFG'),
      sampler: pickEnum(body?.sampler, o.sampler ?? [], current.sampler),
      scheduler: pickEnum(body?.scheduler, o.scheduler ?? [], current.scheduler),
      width: int(body?.width, config.defaultWidth, SAFETY.minSide, SAFETY.maxSide, '宽度'),
      height: int(body?.height, config.defaultHeight, SAFETY.minSide, SAFETY.maxSide, '高度'),
      batch: int(body?.batch, 1, 1, 8, '批量'),
      rotation: bindings.rotateId ? pickEnum(body?.rotation, o.rotation ?? [], current.rotation ?? 'none') : null,
      lora: bindings.loraId ? pickEnum(body?.lora, o.lora ?? [], current.lora ?? '') : null,
      loraStrength: bindings.loraId ? float(body?.loraStrength, current.loraStrength ?? 1, 0, 2, 'LoRA 强度') : null,
      unet: pickEnum(body?.unet, o.unet ?? [], current.unet),
      clip: pickEnum(body?.clip, o.clip ?? [], current.clip),
      vae: pickEnum(body?.vae, o.vae ?? [], current.vae),
    };
    return { values, errors };
  }

  /** 把表单值写进工作流图（深拷贝，绝不改内存里的模板） */
  function buildGraph(values: JobValues): Graph {
    const graph = structuredClone(workflow);
    // 绑定是从这张图推导出来的，缺节点说明两者已经不一致 —— 立刻抛，别静默出一张废图
    const nodeAt = (nodeId: string): GraphNode => {
      const node = graph[nodeId];
      if (!node) throw new Error(`图里没有节点 ${nodeId}（绑定与图不一致）`);
      return node;
    };
    // 「手工拼接」就发生在这一行：描述词在前、正向词（质量/风格）在后
    nodeAt(bindings.positiveId).inputs.text = joinPrompt(values.description, values.positive);
    nodeAt(bindings.negativeId).inputs.text = values.negative;
    const sampler = nodeAt(bindings.samplerId).inputs;
    sampler.seed = values.seed;
    sampler.steps = values.steps;
    sampler.cfg = values.cfg;
    sampler.sampler_name = values.sampler;
    sampler.scheduler = values.scheduler;
    const latent = nodeAt(bindings.latentId).inputs;
    latent.width = values.width;
    latent.height = values.height;
    latent.batch_size = values.batch;
    if (bindings.rotateId && values.rotation) {
      nodeAt(bindings.rotateId).inputs.rotation = values.rotation;
    }
    if (bindings.loraId && values.lora) {
      nodeAt(bindings.loraId).inputs.lora_name = values.lora;
      nodeAt(bindings.loraId).inputs.strength_model = values.loraStrength;
    }
    nodeAt(bindings.unetId).inputs.unet_name = values.unet;
    nodeAt(bindings.clipId).inputs.clip_name = values.clip;
    nodeAt(bindings.vaeId).inputs.vae_name = values.vae;
    return graph;
  }

  return { options, validate, buildGraph };
}
