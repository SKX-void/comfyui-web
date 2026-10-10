/**
 * 动态表单：由模板 inputs 渲染控件。
 * 控件类型见 `docs/architecture.md` §4.2（`plugin.settings[]`）。
 *
 * 控件类型来自 manifest 的 `plugin.settings[]`；`tag-selector` / `lora-select` 由
 * `components/TagSelector.vue` / `LoraSelector.vue` 实现（WeiLin 的提示词编辑器与 LoRA 栈，
 * 见 plugins/anima-plus/docs/weilin.md §6）。
 */
import type { LoraRef, WorkflowInput } from '@comfyui-web/shared';
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

export function defaultValues(inputs: WorkflowInput[] | undefined): FieldModel {
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

/**
 * 回填「上次提交的参数」（`<space>/last-state.json`，写入时机见 App.vue 的 submit）。
 *
 * 两道过滤，都是必要的：
 *
 * 1. **只认模板里现在还有的字段** —— 换过模板的机器上，文件里可能躺着早就删掉的键；
 * 2. **按控件类型验一次** —— 文件是普通 JSON，手改过就可能出现"字符串住进 switch"
 *    这种键；这种值宁可退回模板默认值，也不要让界面显示得莫名其妙。
 *
 * 返回值只含"要覆盖的键"，由调用方 merge 到 `defaultValues()` 之上。
 */
export function restoreValues(inputs: WorkflowInput[] | undefined, saved: unknown): FieldModel {
  const out: FieldModel = {};
  if (!Array.isArray(inputs) || saved === null || typeof saved !== 'object') return out;
  const source = saved as Record<string, unknown>;
  for (const input of inputs) {
    if (!Object.prototype.hasOwnProperty.call(source, input.key)) continue;
    const value = source[input.key];
    if (acceptsValue(input, value)) out[input.key] = value;
  }
  return out;
}

/** 这个值配得上这个控件吗（JSON 里只有 string / number / boolean / array / object） */
function acceptsValue(input: WorkflowInput, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  switch (input.type) {
    case 'switch':
      return typeof value === 'boolean';
    case 'lora-select':
      return Array.isArray(value);
    case 'number':
    case 'slider':
    case 'seed':
      return typeof value === 'number' && Number.isFinite(value);
    case 'text':
    case 'textarea':
    case 'select':
    case 'model-select':
    case 'tag-selector':
    case 'image-upload':
      return typeof value === 'string';
    default:
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }
}

export function isVisible(input: WorkflowInput, values: FieldModel): boolean {
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
  inputs: WorkflowInput[],
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
