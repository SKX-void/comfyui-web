import type { Binding, Graph, TemplateDef, TemplateInput } from '@comfyui-server/shared';
import { AppError } from '../errors.js';
import { applyTransform } from './transforms.js';

export interface LoadedTemplate {
  def: TemplateDef;
  graph: Graph;
  /** template.json 所在目录，用于取缩略图等 */
  dir: string;
}

/** 按 input 类型做值归一化与校验（v1-template.md §5 步骤 2） */
export function coerceValues(
  def: TemplateDef,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const details: Array<{ path: string; message: string }> = [];

  for (const input of def.inputs) {
    const raw = values[input.key];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (input.required && input.default === undefined) {
        details.push({ path: `values.${input.key}`, message: '必填项缺失' });
        continue;
      }
      if (input.default !== undefined) out[input.key] = input.default;
      continue;
    }

    try {
      out[input.key] = coerceOne(input, raw);
    } catch (err) {
      details.push({ path: `values.${input.key}`, message: (err as Error).message });
    }
  }

  if (details.length > 0) {
    throw AppError.templateValidation('表单值校验失败', details);
  }
  return out;
}

function coerceOne(input: TemplateInput, raw: unknown): unknown {
  switch (input.type) {
    case 'number':
    case 'slider':
    case 'seed': {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || Number.isNaN(n)) {
        throw new Error(`必须是数字，收到 ${JSON.stringify(raw)}`);
      }
      if (input.type !== 'seed') {
        if (input.ui?.min !== undefined && n < input.ui.min) {
          throw new Error(`不能小于 ${input.ui.min}`);
        }
        if (input.ui?.max !== undefined && n > input.ui.max) {
          throw new Error(`不能大于 ${input.ui.max}`);
        }
      }
      return n;
    }
    case 'switch':
      return typeof raw === 'boolean' ? raw : raw === 'true' || raw === 1;
    case 'lora-select':
    case 'tag-selector':
      if (input.ui?.multiple || Array.isArray(raw)) {
        if (!Array.isArray(raw)) throw new Error('必须是数组');
        return raw;
      }
      return String(raw);
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

function setPath(graph: Graph, target: string, value: unknown): void {
  const m = /^([^.]+)\.inputs\.(.+)$/.exec(target);
  if (!m) {
    throw AppError.templateValidation(
      `binding target 格式非法（应为 "<nodeId>.inputs.<field>"）: ${target}`,
    );
  }
  const nodeId = m[1]!;
  const field = m[2]!;
  const node = graph[nodeId];
  if (!node) {
    throw AppError.templateValidation(`binding target 指向的节点不存在: ${target}`);
  }
  node.inputs[field] = value;
}

function whenMatches(binding: Binding, values: Record<string, unknown>): boolean {
  const cond = binding.when;
  if (!cond) return true;
  const actual = values[cond.key];
  if (cond.truthy !== undefined) return Boolean(actual) === cond.truthy;
  if (cond.equals !== undefined) return actual === cond.equals;
  return true;
}

/**
 * 渲染：把表单值注入模板 graph（v1-template.md §5）。
 *
 * 返回**新的** graph，不修改模板（深拷贝）。
 */
export function renderTemplate(
  tpl: LoadedTemplate,
  rawValues: Record<string, unknown>,
): { graph: Graph; values: Record<string, unknown> } {
  const values = coerceValues(tpl.def, rawValues);
  const graph: Graph = structuredClone(tpl.graph);

  for (const binding of tpl.def.bindings) {
    if (!whenMatches(binding, values)) continue;

    let value: unknown;
    if (binding.const !== undefined) {
      value = binding.const;
    } else if (binding.from !== undefined) {
      value = values[binding.from];
      if (value === undefined) continue;
    } else {
      continue;
    }

    if (binding.transform) {
      value = applyTransform(binding.transform, value, { args: binding.args });
    }
    setPath(graph, binding.target, value);
  }

  return { graph, values };
}
