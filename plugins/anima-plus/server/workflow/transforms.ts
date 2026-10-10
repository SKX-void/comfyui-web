import type { LoraRef, TagRef, TransformName } from '@comfyui-web/shared';
import { AppError } from '../errors.js';

export interface TransformContext {
  args?: Record<string, unknown>;
  /**
   * 本次提交解析出的触发词前缀（`词:权重`，见 server/triggers/resolve.ts）。
   *
   * 由 manager.submit 在 render **之前**解析并传入：它是运行期数据，不是表单值，
   * 所以走 ctx 而不是 `values`（用户送来的 values 里伪造不了它）。
   */
  triggerPrefix?: string;
}

function asNumber(v: unknown, what: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw AppError.workflowValidation(`${what} 必须是数字，收到: ${JSON.stringify(v)}`);
  }
  return n;
}

function asArray<T>(v: unknown, what: string): T[] {
  if (!Array.isArray(v)) {
    throw AppError.workflowValidation(`${what} 必须是数组，收到: ${JSON.stringify(v)}`);
  }
  return v as T[];
}

/** 去掉扩展名，WeiLin 的 <wlr:> 标签与 name 字段都不带 .safetensors */
function stripExt(name: string): string {
  return name.replace(/\.safetensors$/i, '');
}

/**
 * 归一化 LoRA 引用：补齐 lora 字段（含扩展名）。
 *
 * `clipWeight` / `triggerWeight` 缺省为 **1**（与 WeiLin 前端一致：
 * 两者各自独立，都默认 1，不是从 weight 推导）。
 * 前端现在不再暴露这两个权重，依赖这里的默认值。
 *
 * 注意：LoRA 名可能含反斜杠（如 "Anima\\画师\\x"），
 * 这里只做原样透传，**绝不规范化路径**（plugins/anima-plus/docs/weilin.md §8）。
 */
export function normalizeLora(raw: unknown): LoraRef {
  const r = raw as Partial<LoraRef>;
  const name = stripExt(String(r.name ?? r.lora ?? ''));
  if (!name) {
    throw AppError.workflowValidation('LoRA 缺少 name');
  }
  return {
    name,
    lora: r.lora ? String(r.lora) : `${name}.safetensors`,
    weight: r.weight === undefined ? 1 : asNumber(r.weight, 'LoRA weight'),
    clipWeight: r.clipWeight === undefined ? 1 : asNumber(r.clipWeight, 'LoRA clipWeight'),
    triggerWeight:
      r.triggerWeight === undefined ? 1 : asNumber(r.triggerWeight, 'LoRA triggerWeight'),
    displayName: r.displayName ?? name,
    // loraWorks 仅前端显示用：WeiLin 节点不读取它（plugins/anima-plus/docs/weilin.md §5.3）
    loraWorks: r.loraWorks ?? '',
    hidden: r.hidden ?? false,
  };
}

/**
 * 随机种子的上界取 JS 安全整数上限（2^53-1）。
 * ComfyUI 那边 ClownsharKSampler_Beta 把 seed 声明成 INT、上界 ≈ 2^64，但超过 2^53 的数在
 * JS number 里已经不保证精确，落图时会被写成另一个值 —— 所以干脆只在这个"说了算"的区间里抽。
 * 原来的 `Math.random() * 2**32` 只覆盖 2^32，这里是它的 2^21 倍。
 */
export const SEED_MAX = Number.MAX_SAFE_INTEGER;

/** 用户输入的占位值：表示"这次随机"，渲染时换成 [0, SEED_MAX] 内的一个具体数。 */
export const SEED_RANDOM = -1;

/** 抽一个种子：高 21 位与低 32 位各自独立抽，避免只用低位导致的可预测性。 */
export function randomSeed(): number {
  const hi = Math.floor(Math.random() * 2 ** 21);
  const lo = Math.floor(Math.random() * 2 ** 32);
  return hi * 2 ** 32 + lo;
}

/**
 * 值变换器（docs/archive/v1-templates.md §4）。
 *
 * 说明：`weilinLora` 产出的 JSON **字符串**里含反斜杠转义，
 * 因此这里始终用「先构造对象、再 JSON.stringify 一次」的方式，绝不手写字符串。
 */
export function applyTransform(
  name: TransformName,
  value: unknown,
  ctx: TransformContext = {},
): unknown {
  switch (name) {
    case 'seed': {
      const n = asNumber(value, 'seed');
      if (n === -1) return randomSeed();
      return n;
    }

    case 'join': {
      const arr = asArray<unknown>(value, 'join 的输入');
      const sep = typeof ctx.args?.sep === 'string' ? ctx.args.sep : ', ';
      return arr.map((x) => String(x)).join(sep);
    }

    case 'json':
      return JSON.stringify(value);

    case 'clamp': {
      const n = asNumber(value, 'clamp 的输入');
      const min = ctx.args?.min === undefined ? -Infinity : asNumber(ctx.args.min, 'min');
      const max = ctx.args?.max === undefined ? Infinity : asNumber(ctx.args.max, 'max');
      return Math.min(max, Math.max(min, n));
    }

    case 'triggerPrefix': {
      // 注入点在 28（质量词）之前：19 随后会拼成「触发词 → 质量词 → 主提示词」，
      // 与旧的全能节点（先注入、再当 opt_text 往下传）逐字一致。
      const text = String(value ?? '');
      const prefix = ctx.triggerPrefix?.trim() ?? '';
      if (!prefix) return text;
      return text ? `${prefix}, ${text}` : prefix;
    }

    case 'prefixComma': {
      const prefix = typeof ctx.args?.prefix === 'string' ? ctx.args.prefix : '';
      const text = String(value ?? '');
      return text ? `${prefix}, ${text}` : prefix;
    }

    case 'weilinTokens': {
      const arr = asArray<TagRef>(value, 'weilinTokens 的输入');
      const tokens = arr.map((t, i) => ({
        id: `token_${i + 1}_${Date.now()}`,
        text: t.text,
        translate: t.translate ?? '',
        isPunctuation: false,
        isEditing: false,
        isHidden: false,
        color: t.color ?? null,
        isLoraTag: false,
      }));
      return JSON.stringify(tokens);
    }

    case 'weilinLora': {
      const arr = asArray<unknown>(value, 'weilinLora 的输入');
      const loras = arr.map(normalizeLora).map((l) => ({
        name: l.name,
        lora: l.lora,
        weight: l.weight,
        text_encoder_weight: l.clipWeight,
        trigger_weight: l.triggerWeight,
        display_name: l.displayName,
        loraWorks: l.loraWorks,
        hidden: l.hidden,
      }));
      return JSON.stringify(loras);
    }

    case 'weilinLoraTags': {
      const arr = asArray<unknown>(value, 'weilinLoraTags 的输入');
      // 格式：<wlr:名:模型权重:CLIP权重:触发词权重>（plugins/anima-plus/docs/weilin.md §4.2）
      const tags = arr
        .map(normalizeLora)
        .filter((l) => !l.hidden)
        .map((l) => `<wlr:${l.name}:${l.weight}:${l.clipWeight}:${l.triggerWeight}>`);
      return tags.join(', ');
    }

    default: {
      const never: never = name;
      throw AppError.workflowValidation(`未知的 transform: ${String(never)}`);
    }
  }
}

/** 供 loader 静态校验使用 */
export const KNOWN_TRANSFORMS: readonly TransformName[] = [
  'seed',
  'join',
  'json',
  'weilinTokens',
  'weilinLora',
  'weilinLoraTags',
  'triggerPrefix',
  'prefixComma',
  'clamp',
];
