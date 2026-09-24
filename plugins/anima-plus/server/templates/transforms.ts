import type { LoraRef, TagRef, TransformName } from '@comfyui-web/shared';
import { AppError } from '../errors.js';

export interface TransformContext {
  args?: Record<string, unknown>;
}

function asNumber(v: unknown, what: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw AppError.templateValidation(`${what} 必须是数字，收到: ${JSON.stringify(v)}`);
  }
  return n;
}

function asArray<T>(v: unknown, what: string): T[] {
  if (!Array.isArray(v)) {
    throw AppError.templateValidation(`${what} 必须是数组，收到: ${JSON.stringify(v)}`);
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
function normalizeLora(raw: unknown): LoraRef {
  const r = raw as Partial<LoraRef>;
  const name = stripExt(String(r.name ?? r.lora ?? ''));
  if (!name) {
    throw AppError.templateValidation('LoRA 缺少 name');
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
      if (n === -1) return Math.floor(Math.random() * 2 ** 32);
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
      throw AppError.templateValidation(`未知的 transform: ${String(never)}`);
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
  'prefixComma',
  'clamp',
];
