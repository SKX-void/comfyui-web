/**
 * 扫图：把最终图里每个受管字段解析成具体数值，收集越界命中。
 *
 * 这是 `limits.ts` 头部写的三层防线里的第 2 层（"渲染结果"）的扫描部分；
 * 常量、字段规则表与查表在 `limits.ts`，把人话翻译与提交前断言在 `describe.ts`。
 */
import type { Graph } from '@comfyui-web/shared';

import {
  DEFAULT_COUNT_LIMITS,
  DEFAULT_LIMITS,
  countLimitForField,
  limitForField,
  type CountLimit,
  type NumericLimit,
} from './limits.js';

import type {
  CountHit,
  GuardScan,
  LimitHit,
  LimitReason,
  Position,
  UnresolvedHit,
} from './hits.js';

// ---------------------------------------------------------------------------
// 取值解析
// ---------------------------------------------------------------------------

/** 连线引用：[来源节点ID, 输出序号] */
export function isLink(v: unknown): v is [string, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'string' &&
    typeof v[1] === 'number'
  );
}

type Resolved =
  | { ok: true; value: number; at: Position; chain: string }
  | { ok: false; detail: string };

const MAX_LINK_DEPTH = 4;

/**
 * 解析某个节点字段的**实际数值**。
 *
 * ComfyUI 的 API 图里，`steps` 有时不是字面量而是 `["49", 0]`
 * （连到一个 INTConstant / PrimitiveInt 的 `value`）。只看字面量会漏掉这类图，
 * 所以这里在字面量取不到时顺着连线往上找，并且：
 *   - 上游节点只有一个数值输入 → 采用它
 *   - 上游节点没有数值输入但只有一条连线 → 继续往上
 *   - 有多个数值输入（无法判断哪个是取值） → **判定失败**，不猜
 */
function resolveNumeric(
  graph: Graph,
  nodeId: string,
  field: string,
  depth = 0,
): Resolved {
  if (depth > MAX_LINK_DEPTH) {
    return { ok: false, detail: `${nodeId}.inputs.${field} 连线层级过深` };
  }
  const node = graph[nodeId];
  if (!node || typeof node !== 'object' || !node.inputs) {
    return { ok: false, detail: `节点 ${nodeId} 不在 graph 中` };
  }
  const raw = node.inputs[field];
  const here = `${nodeId}.inputs.${field}`;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { ok: false, detail: `${here} 不是有限数值（${String(raw)}）` };
    }
    return { ok: true, value: raw, at: { nodeId, field }, chain: here };
  }

  if (typeof raw === 'string') {
    // 字符串形式的数字：ComfyUI 可能勉强接受，但护栏不能靠猜 —— 要求模板写数字
    return { ok: false, detail: `${here} 是字符串 ${JSON.stringify(raw)}，请改成数字` };
  }

  if (isLink(raw)) {
    const srcId = raw[0];
    const src = graph[srcId];
    if (!src || typeof src !== 'object' || !src.inputs) {
      return { ok: false, detail: `${here} 连线的来源节点 ${srcId} 不在 graph 中` };
    }
    const numericFields = Object.entries(src.inputs).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    );
    if (numericFields.length === 1) {
      const [srcField] = numericFields[0]!;
      const inner = resolveNumeric(graph, srcId, srcField, depth + 1);
      return inner.ok ? { ...inner, chain: `${here} → ${inner.chain}` } : inner;
    }
    if (numericFields.length === 0) {
      const linkFields = Object.entries(src.inputs).filter(([, v]) => isLink(v));
      if (linkFields.length === 1) {
        const inner = resolveNumeric(graph, srcId, linkFields[0]![0], depth + 1);
        return inner.ok ? { ...inner, chain: `${here} → ${inner.chain}` } : inner;
      }
      return {
        ok: false,
        detail: `${here} 连到 ${srcId}（${src.class_type}），该节点没有数值输入，无法判断取值`,
      };
    }
    return {
      ok: false,
      detail: `${here} 连到 ${srcId}（${src.class_type}），该节点有 ${numericFields.length} 个数值输入，无法判断哪个是取值`,
    };
  }

  return { ok: false, detail: `${here} 既不是数值也不是连线` };
}

/** 判断数值是否需要修正；返回 null 表示合规 */
function limitValue(
  value: number,
  rule: NumericLimit,
): { fixed: number; bound: number; reason: LimitReason } | null {
  if (rule.exempt?.includes(value)) return null;

  let fixed = value;
  let bound = value;
  let reason: LimitReason | null = null;

  if (rule.integer && !Number.isInteger(fixed)) {
    fixed = Math.trunc(fixed); // 向下/向零取整，绝不放大
    bound = Math.trunc(value);
    reason = 'not-integer';
  }
  // 先判上限：越界是最需要被看见的原因
  if (rule.max !== undefined && fixed > rule.max) {
    fixed = rule.max;
    bound = rule.max;
    reason = 'above-max';
  }
  if (rule.min !== undefined && fixed < rule.min) {
    fixed = rule.min;
    bound = rule.min;
    reason = 'below-min';
  }

  return reason ? { fixed, bound, reason } : null;
}

// ---------------------------------------------------------------------------
// 扫描 / 夹紧 / 断言
// ---------------------------------------------------------------------------

/** 解析字段里的 JSON 数组，取出元素个数 */
function countOf(
  raw: unknown,
  format: CountLimit['format'],
): { ok: true; count: number } | { ok: false; detail: string } {
  if (format !== 'json-array') return { ok: false, detail: `未知的数量判定方式: ${String(format)}` };
  if (typeof raw !== 'string') {
    return { ok: false, detail: '不是字符串（无法判定数量）' };
  }
  // 空串按"空数组"算：ComfyUI 里没挂 LoRA 时这个字段可能导出成 ""，
  // 这种情况数量就是 0，没有风险，不该判成"无法判定"而拒绝所有人。
  if (raw.trim() === '') return { ok: true, count: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: '不是合法 JSON（无法判定数量）' };
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: '不是 JSON 数组（无法判定数量）' };
  return { ok: true, count: parsed.length };
}

/** 只扫描，不改图 */
export function scanGraph(
  graph: Graph,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
  countLimits: readonly CountLimit[] = DEFAULT_COUNT_LIMITS,
): GuardScan {
  const hits: LimitHit[] = [];
  const unresolved: UnresolvedHit[] = [];
  const overCount: CountHit[] = [];

  for (const [nodeId, node] of Object.entries(graph ?? {})) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    for (const field of Object.keys(node.inputs)) {
      const countRule = countLimitForField(field, countLimits);
      if (countRule) {
        const res = countOf(node.inputs[field], countRule.format);
        if (!res.ok) {
          unresolved.push({
            ruleId: countRule.id,
            label: countRule.label,
            at: { nodeId, field },
            detail: `${nodeId}.inputs.${field} ${res.detail}`,
          });
        } else if (res.count > countRule.max) {
          overCount.push({
            ruleId: countRule.id,
            label: countRule.label,
            at: { nodeId, field },
            write: { nodeId, field },
            count: res.count,
            max: countRule.max,
          });
        }
      }

      const rule = limitForField(field, limits);
      if (!rule) continue;

      const res = resolveNumeric(graph, nodeId, field);
      if (!res.ok) {
        unresolved.push({
          ruleId: rule.id,
          label: rule.label,
          at: { nodeId, field },
          detail: res.detail,
        });
        continue;
      }
      const over = limitValue(res.value, rule);
      if (over) {
        hits.push({
          ruleId: rule.id,
          label: rule.label,
          at: { nodeId, field },
          write: res.at,
          value: res.value,
          fixed: over.fixed,
          bound: over.bound,
          reason: over.reason,
          chain: res.chain,
        });
      }
    }
  }

  return { hits, unresolved, overCount };
}

/** 扫描并**就地**把越界值夹紧到安全值（数量超限不夹，见 CountLimit 注释） */
export function guardGraph(
  graph: Graph,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
  countLimits: readonly CountLimit[] = DEFAULT_COUNT_LIMITS,
): GuardScan {
  const scan = scanGraph(graph, limits, countLimits);
  for (const hit of scan.hits) {
    const node = graph[hit.write.nodeId];
    if (node && typeof node === 'object' && node.inputs) {
      node.inputs[hit.write.field] = hit.fixed;
    }
  }
  return scan;
}

