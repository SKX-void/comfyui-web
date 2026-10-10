/**
 * 本次生效的边界：默认表 + 用户自定义上下限（模板自己声明的边界也在这里收窄）。
 *
 * 常量与默认规则表在 `limits.ts`；这里只做"合并与收窄"，不扫描图。
 */
import type { Graph, WorkflowDef, WorkflowInput } from '@comfyui-web/shared';

import {
  DEFAULT_COUNT_LIMITS,
  DEFAULT_LIMITS,
  countLimitForField,
  limitForField,
  type CountLimit,
  type NumericLimit,
} from './limits.js';
import { isLink } from './scan.js';
import type { Position } from './hits.js';

function consumersOf(graph: Graph, nodeId: string): Position[] {
  const out: Position[] = [];
  for (const [id, node] of Object.entries(graph ?? {})) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    for (const [field, v] of Object.entries(node.inputs)) {
      if (isLink(v) && v[0] === nodeId) out.push({ nodeId: id, field });
    }
  }
  return out;
}

/**
 * binding.target 命中了哪些规则。
 *
 * 两步：
 *   1. 直接匹配（binding 写的就是 width/height 本身）
 *   2. 顺着连线往**下游**走（binding 写的是上游常量节点的 `value`，
 *      真正被管控的字段在下游采样器上 —— 本项目的 steps 正是这种形状）
 */
function rulesOfTarget<T extends { id: string; fields: readonly string[] }>(
  graph: Graph,
  target: Position,
  limits: readonly T[],
  find: (field: string, limits: readonly T[]) => T | undefined,
): T[] {
  const found = new Map<string, T>();
  const direct = find(target.field, limits);
  if (direct) found.set(direct.id, direct);

  const seen = new Set<string>([target.nodeId]);
  let frontier = [target.nodeId];
  for (let depth = 0; depth < 3 && found.size === 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const consumer of consumersOf(graph, id)) {
        const rule = find(consumer.field, limits);
        if (rule) found.set(rule.id, rule);
        if (!seen.has(consumer.nodeId)) {
          seen.add(consumer.nodeId);
          next.push(consumer.nodeId);
        }
      }
    }
    frontier = next;
  }
  return [...found.values()];
}

export interface EffectiveBounds {
  min?: number;
  max?: number;
  /** 数量上限（如 LoRA 个数） */
  countMax?: number;
  /** 该字段是否受安全策略管辖 */
  fromPolicy: boolean;
  /** 命中的规则名（用于错误措辞） */
  label?: string;
}

/**
 * 某个表单字段的**有效边界** = 模板里写的 ui.min/max ∩ 安全策略。
 *
 * 这是"单一真相源"的关键：模板里的 ui.max 只是 UI 提示，
 * 真正说了算的是安全策略；两边取交集，谁更严格听谁的。
 */
export function effectiveBounds(
  def: WorkflowDef,
  graph: Graph | undefined,
  input: WorkflowInput,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
  countLimits: readonly CountLimit[] = DEFAULT_COUNT_LIMITS,
): EffectiveBounds {
  let min = input.ui?.min;
  let max = input.ui?.max;
  let countMax: number | undefined;
  let fromPolicy = false;
  let label: string | undefined;

  for (const binding of def.bindings ?? []) {
    if (binding.from !== input.key) continue;
    const m = /^([^.]+)\.inputs\.(.+)$/.exec(binding.target ?? '');
    if (!m) continue;
    const target: Position = { nodeId: m[1]!, field: m[2]! };

    const direct = limitForField(target.field, limits);
    const rules = graph
      ? rulesOfTarget(graph, target, limits, limitForField)
      : direct
        ? [direct]
        : [];

    for (const rule of rules) {
      fromPolicy = true;
      label = rule.label;
      if (rule.min !== undefined) min = min === undefined ? rule.min : Math.max(min, rule.min);
      if (rule.max !== undefined) max = max === undefined ? rule.max : Math.min(max, rule.max);
    }

    const directCount = countLimitForField(target.field, countLimits);
    const countRules = graph
      ? rulesOfTarget(graph, target, countLimits, countLimitForField)
      : directCount
        ? [directCount]
        : [];

    for (const rule of countRules) {
      fromPolicy = true;
      label = rule.label;
      countMax = countMax === undefined ? rule.max : Math.min(countMax, rule.max);
    }
  }

  return { min, max, countMax, fromPolicy, label };
}

/**
 * 收窄表单下发的 ui.min/max（`GET /api/workflow`）。
 *
 * 好处：改安全策略只需改一处，前端滑块/数字框自动跟着变，
 * 不需要回头改 assets/form.json 里那份可能过期的提示值。
 */
export function narrowWorkflowBounds(
  def: WorkflowDef,
  graph: Graph,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
): WorkflowDef {
  let changed = false;
  const inputs = (def.inputs ?? []).map((input) => {
    const b = effectiveBounds(def, graph, input, limits);
    const min = b.min ?? input.ui?.min;
    const max = b.max ?? input.ui?.max;
    if (min === input.ui?.min && max === input.ui?.max) return input;
    changed = true;
    return { ...input, ui: { ...input.ui, min, max } };
  });
  return changed ? { ...def, inputs } : def;
}

/**
 * 找出该越界值是否来自用户填的表单字段。
 *
 * 判定依据：某条 binding 的目标正好是（被管控的字段本身 或 数值真正存放的位置），
 * 且它的 `when` 条件成立（条件不成立时用的是模板原值，不能算用户的账）。
 */
export function userSourceOf(
  def: WorkflowDef,
  hit: { at: Position; write: Position },
  values: Record<string, unknown>,
): { key: string; label: string } | null {
  const targets = new Set([
    `${hit.at.nodeId}.inputs.${hit.at.field}`,
    `${hit.write.nodeId}.inputs.${hit.write.field}`,
  ]);
  for (const binding of def.bindings ?? []) {
    if (binding.from === undefined) continue;
    if (!targets.has(binding.target)) continue;
    if (!whenMatches(binding.when, values)) continue;
    const input = (def.inputs ?? []).find((i) => i.key === binding.from);
    return { key: binding.from, label: input?.label ?? binding.from };
  }
  return null;
}

/** `binding.when` 的求值，render.ts 与这里共用同一份语义 */
export function whenMatches(
  cond: { key: string; equals?: unknown; truthy?: boolean } | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!cond) return true;
  const actual = values[cond.key];
  if (cond.truthy !== undefined) return Boolean(actual) === cond.truthy;
  if (cond.equals !== undefined) return actual === cond.equals;
  return true;
}
