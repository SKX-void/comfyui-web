/**
 * 动态表单：由模板 inputs 渲染控件。
 * 控件类型见 `docs/architecture.md` §4.2（`plugin.settings[]`）。
 *
 * 控件类型来自 manifest 的 `plugin.settings[]`；`tag-selector` / `lora-select` 由
 * `components/TagSelector.vue` / `LoraSelector.vue` 实现（WeiLin 的提示词编辑器与 LoRA 栈，
 * 见 plugins/anima-plus/docs/weilin.md §6）。
 */
import type { LoraRef, TemplateInput } from '@comfyui-web/shared';
import { deepClone } from '@/clone';

export interface FieldModel {
  [key: string]: unknown;
}

/**
 * 抽一个种子，范围与上界跟服务端 transforms.ts 的 randomSeed() 一致（0 ~ 2^53-1）。
 *
 * 上界取 2^53-1 而不是采样器声明的 2^64：超过 2^53 的整数在 JS number 里不保证精确。
 * 两个调用点：App.vue 在点「开始出图」时抽（随机模式），FieldControl 的 🎲 在手动模式下摇。
 */
export function drawSeed(): number {
  const hi = Math.floor(Math.random() * 2 ** 21);
  const lo = Math.floor(Math.random() * 2 ** 32);
  return hi * 2 ** 32 + lo;
}

export function defaultValues(inputs: TemplateInput[] | undefined): FieldModel {
  const out: FieldModel = {};
  // 防御：接口异常时也不要把整页渲染搞崩
  if (!Array.isArray(inputs)) return out;
  for (const input of inputs) {
    if (input.default !== undefined && input.default !== null) {
      out[input.key] = deepClone(input.default);
    } else if (input.type === 'lora-select') {
      out[input.key] = [];
    } else if (input.type === 'switch') {
      out[input.key] = false;
    } else {
      out[input.key] = '';
    }
  }
  return out;
}

export function isVisible(input: TemplateInput, values: FieldModel): boolean {
  const cond = input.visibleIf;
  if (!cond) return true;
  const actual = values[cond.key];
  if (cond.notEquals !== undefined) return actual !== cond.notEquals;
  if (cond.equals !== undefined) return actual === cond.equals;
  return true;
}

/**
 * 把值转成提交给后端的形状。
 * lora-select 需要剔除未填名称的占位行。
 */
export function normalizeValues(
  inputs: TemplateInput[],
  values: FieldModel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of inputs) {
    let v = values[input.key];
    if (input.type === 'lora-select' && Array.isArray(v)) {
      v = (v as LoraRef[]).filter((l) => (l.name ?? '').trim() !== '');
    }
    out[input.key] = v;
  }
  return out;
}
