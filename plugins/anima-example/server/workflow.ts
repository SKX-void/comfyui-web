/**
 * 工作流：载入 `workflow.json` + 把「表单字段」绑定到「工作流节点」。
 *
 * 产物在 tab 根，所以 `import.meta.url` 定位到的 `./workflow.json` 就是
 * `tabs/anima-example/workflow.json`（pack.mjs 拷过去的运行期资产）。
 */
import fs from 'node:fs';

import type { Graph, GraphNode, NodeRef, WorkflowBindings } from './model.js';

export const WORKFLOW_FILE = new URL('./workflow.json', import.meta.url);

export function loadWorkflow(): Graph {
  return JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8')) as Graph;
}

/** 按 class_type 找唯一节点；找不到直接抛——配置错要立刻炸，而不是静默出一张废图 */
function byClass(graph: Graph, classType: string): NodeRef {
  for (const [nodeId, node] of Object.entries(graph)) {
    if (node && node.class_type === classType) return [nodeId, node];
  }
  throw new Error(`工作流里找不到 ${classType} 节点`);
}

/** 顺着连线往上游走一步：node.inputs[key] === [nodeId, slotIndex] */
function upstream(graph: Graph, node: GraphNode | null | undefined, key: string): NodeRef | null {
  const link = node?.inputs?.[key];
  if (!Array.isArray(link)) return null;
  const nodeId = String(link[0]);
  const target = graph[nodeId];
  return target ? [nodeId, target] : null;
}

/**
 * 解析绑定关系。
 *
 * **全部靠 class_type + 连线推导，一个节点号都不写死** —— 在 ComfyUI 里拖动节点、
 * 重新导出、换一个同构的工作流，这里都不会失效。节点号只在同一次会话里当索引使。
 */
export function resolveBindings(graph: Graph): WorkflowBindings {
  const [samplerId, sampler] = byClass(graph, 'KSampler');

  const positive = upstream(graph, sampler, 'positive');
  const negative = upstream(graph, sampler, 'negative');
  if (!positive || !negative) throw new Error('KSampler 的 positive/negative 没有连线');

  // 潜空间：sampler.latent_image → 可能是 LatentRotate → 再到 EmptyLatentImage
  let latent = upstream(graph, sampler, 'latent_image');
  let rotate: NodeRef | null = null;
  if (latent && latent[1].class_type === 'LatentRotate') {
    rotate = latent;
    latent = upstream(graph, latent[1], 'samples');
  }
  if (!latent || latent[1].class_type !== 'EmptyLatentImage') {
    throw new Error('找不到 EmptyLatentImage（KSampler.latent_image 的源头）');
  }

  // LoRA：从 sampler.model 往上游找第一个 LoraLoader
  let cursor = upstream(graph, sampler, 'model');
  let lora: NodeRef | null = null;
  while (cursor) {
    if (cursor[1].class_type === 'LoraLoader') {
      lora = cursor;
      break;
    }
    cursor = upstream(graph, cursor[1], 'model');
  }

  const [unetId, unet] = byClass(graph, 'UNETLoader');
  const [clipId, clip] = byClass(graph, 'CLIPLoader');
  const [vaeId, vae] = byClass(graph, 'VAELoader');
  const [saveId] = byClass(graph, 'SaveImage');

  return {
    samplerId,
    positiveId: positive[0],
    negativeId: negative[0],
    latentId: latent[0],
    rotateId: rotate ? rotate[0] : null,
    loraId: lora ? lora[0] : null,
    unetId,
    clipId,
    vaeId,
    saveId,
    // 工作流自带的当前值 = 表单的初始值
    // 工作流自带的正向文本（本插件里它是"质量/风格"串，不是描述）+ 负向文本
    current: {
      positive: String(positive[1].inputs?.text ?? ''),
      negative: String(negative[1].inputs?.text ?? ''),
      seed: Number(sampler.inputs?.seed ?? 0),
      steps: Number(sampler.inputs?.steps ?? 20),
      cfg: Number(sampler.inputs?.cfg ?? 7),
      sampler: String(sampler.inputs?.sampler_name ?? 'euler'),
      scheduler: String(sampler.inputs?.scheduler ?? 'normal'),
      width: Number(latent[1].inputs?.width ?? 1024),
      height: Number(latent[1].inputs?.height ?? 1024),
      batch: Number(latent[1].inputs?.batch_size ?? 1),
      rotation: rotate ? String(rotate[1].inputs?.rotation ?? 'none') : null,
      lora: lora ? String(lora[1].inputs?.lora_name ?? '') : null,
      loraStrength: lora ? Number(lora[1].inputs?.strength_model ?? 1) : null,
      unet: String(unet.inputs?.unet_name ?? ''),
      clip: String(clip.inputs?.clip_name ?? ''),
      clipType: String(clip.inputs?.type ?? 'stable_diffusion'),
      vae: String(vae.inputs?.vae_name ?? ''),
    },
  };
}
