/**
 * 硬件安全护栏（plugins/anima-plus/docs/safety.md）。
 *
 * 目的：**任何**离开本进程、发往 ComfyUI 的图，都不允许含有会打爆显存/显存带宽的取值。
 * 服务要给别人用，所以这里不信任任何上游（模板、transform、预设、未来的新入口）。
 *
 * 三层防线（越靠后越"绝对"）：
 *   1. 表单值：`coerceValues` 用策略推导出的边界直接拒绝（错误信息友好，指向具体字段）
 *   2. 渲染结果：`guardGraph` 扫描**最终图**；能追溯到用户输入的 → 拒绝，
 *      只来自模板的 → 夹紧到安全值并告警（模板作者的错误不该拖垮服务）
 *   3. 出口：`ComfyClient.submit` 前的 `assertGraphSafe`，纯断言、不改图。
 *      走到这一步还有越界，说明前面有 bug —— 宁可提交失败，也不许打到 GPU。
 *
 * 规则只按**节点输入字段名**匹配，与模板解耦：模板改了、换了、加了新的，
 * 只要字段名还是 `width`/`height`/`steps`，照样被管住。
 */
import type { Graph, TemplateDef, TemplateInput } from '@comfyui-web/shared';
import { AppError } from '../errors.js';

// ---------------------------------------------------------------------------
// 上限常量（要调就改这里，别改模板）
// ---------------------------------------------------------------------------

/**
 * 采样步数上限。
 *
 * 比 anima-example 的 32 更紧，是本插件工作流的特性决定的：这里是**多 LoRA 叠加**的系统，
 * 配套的 Turbo 工作流 6 步就能出图 —— 步数往上走收益很小，代价却是每次都要重算全部 LoRA
 * 权重。每个插件管自己的上限（核不管业务），所以这个数字只属于本插件。
 */
export const MAX_STEPS = 24;

/** 图像单边最大像素 */
export const MAX_SIDE = 1216;

/** 图像单边最小像素（挡住 1×1 这类退化输入） */
export const MIN_SIDE = 64;

/** 单个任务里 LoRA 堆叠的数量上限（每个 LoRA 都要常驻一份权重） */
export const MAX_LORAS = 8;

/** 批量张数上限。1 表示"一次只出一张"——显存随张数线性增长 */
export const MAX_BATCH = 1;

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/** 数值规则：命中节点的数值字段，越界可夹紧 */
export interface NumericLimit {
  id: string;
  /** 中文名，出现在报错与告警里 */
  label: string;
  /** 命中的节点输入字段名（小写精确匹配） */
  fields: readonly string[];
  min?: number;
  max?: number;
  /** 必须是整数（不是整数时向下取整） */
  integer?: boolean;
  /** 豁免值（例如 steps_to_run = -1 表示"跑满 steps"） */
  exempt?: readonly number[];
}

/**
 * 数量规则：命中节点的**字符串字段**（JSON 数组），超量一律拒绝、不截断。
 *
 * 为什么不夹紧：截断 LoRA 堆等于悄悄丢掉用户选的 LoRA，
 * 出来的图不对还查不出原因，不如直接报错。
 */
export interface CountLimit {
  id: string;
  label: string;
  fields: readonly string[];
  max: number;
  /** 字段值的形态，目前只有 JSON 数组字符串 */
  format: 'json-array';
}

export const DEFAULT_LIMITS: readonly NumericLimit[] = [
  {
    id: 'steps',
    label: '采样步数',
    fields: ['steps'],
    min: 1,
    max: MAX_STEPS,
    integer: true,
  },
  {
    // 与 steps 分开列，因为 `-1` 这个哨兵只对 steps_to_run 有意义
    //（表示"跑满 steps"）；对 steps 而言 -1 是非法值，必须被 min 拦住。
    id: 'steps_to_run',
    label: '实际执行步数',
    fields: ['steps_to_run'],
    min: 1,
    max: MAX_STEPS,
    integer: true,
    exempt: [-1],
  },
  {
    id: 'size',
    label: '图像尺寸',
    fields: ['width', 'height', 'target_width', 'target_height'],
    min: MIN_SIDE,
    max: MAX_SIDE,
    integer: true,
  },
  {
    id: 'batch',
    label: '批量张数',
    fields: ['batch_size'],
    min: 1,
    max: MAX_BATCH,
    integer: true,
  },
  {
    // 采样器（ClownsharKSampler_Beta）把 seed 声明成 INT，上界 ≈ 2^64。
    // 不设这条，1e20 这种超范围值会原样落图，提交后才在 ComfyUI 侧报错。
    // exempt 里的 -1 是"每次随机"的占位值，在 render 里就已经被换成具体数了。
    id: 'seed',
    label: '随机种子',
    fields: ['seed'],
    min: -1,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
    exempt: [-1],
  },
];

export const DEFAULT_COUNT_LIMITS: readonly CountLimit[] = [
  {
    // 只盯 lora_str / temp_lora_str：它们是 LoRA 数组的**源头**。
    // 43.inputs.positive 里的 <wlr:> 标签是同一次变换派生的（且会过滤 hidden），
    // 数量不会更多；19.inputs.positive 是主提示词，不能按这个规则数。
    id: 'loras',
    label: 'LoRA 数量',
    fields: ['lora_str', 'temp_lora_str'],
    max: MAX_LORAS,
    format: 'json-array',
  },
];

/** 字段名 → 规则（同一字段命中多条规则时取第一条；本表内不会重复） */
export function limitForField(
  field: string,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
): NumericLimit | undefined {
  const key = field.toLowerCase();
  return limits.find((r) => r.fields.includes(key));
}

export function countLimitForField(
  field: string,
  limits: readonly CountLimit[] = DEFAULT_COUNT_LIMITS,
): CountLimit | undefined {
  const key = field.toLowerCase();
  return limits.find((r) => r.fields.includes(key));
}

// ---------------------------------------------------------------------------
// 扫描结果
// ---------------------------------------------------------------------------

export type LimitReason = 'above-max' | 'below-min' | 'not-integer';

export interface Position {
  nodeId: string;
  field: string;
}

export interface LimitHit {
  ruleId: string;
  label: string;
  /** 命中规则的字段（如 32.inputs.width、26.inputs.steps） */
  at: Position;
  /** 数值真正的存放位置（直接字面量时与 at 相同；经连线取值时是上游常量节点） */
  write: Position;
  /** 夹紧前的值 */
  value: number;
  /** 夹紧后的安全值 */
  fixed: number;
  /** 被突破的那个边界 */
  bound: number;
  reason: LimitReason;
  /** 可读的取值链，如 "26.inputs.steps"（字面量）或 "26.inputs.steps → 49.inputs.value"（常量节点接线） */
  chain: string;
}

export interface UnresolvedHit {
  ruleId: string;
  label: string;
  at: Position;
  detail: string;
}

/** 数量超限（一律拒绝，不夹紧） */
export interface CountHit {
  ruleId: string;
  label: string;
  at: Position;
  /** 与 at 相同；为与 LimitHit 共用溯源逻辑而保留 */
  write: Position;
  count: number;
  max: number;
}

export interface GuardScan {
  /** 数值越界（guardGraph 会把它们夹紧） */
  hits: LimitHit[];
  /** 取值无法判定 —— 一律按不安全处理（fail closed） */
  unresolved: UnresolvedHit[];
  /** 数量超限 —— 一律拒绝，不截断 */
  overCount: CountHit[];
}

// ---------------------------------------------------------------------------
// 取值解析
// ---------------------------------------------------------------------------

/** 连线引用：[来源节点ID, 输出序号] */
function isLink(v: unknown): v is [string, number] {
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

export function describeHit(hit: LimitHit): string {
  const where = hit.chain === `${hit.at.nodeId}.inputs.${hit.at.field}` ? '' : `（${hit.chain}）`;
  switch (hit.reason) {
    case 'above-max':
      return `${hit.label} 上限 ${hit.bound}，收到 ${hit.value}${where}`;
    case 'below-min':
      return `${hit.label} 下限 ${hit.bound}，收到 ${hit.value}${where}`;
    case 'not-integer':
      return `${hit.label} 必须是整数，收到 ${hit.value}${where}`;
  }
}

export function describeCount(hit: CountHit): string {
  const where = `${hit.at.nodeId}.inputs.${hit.at.field}`;
  return `${hit.label} 最多 ${hit.max}，收到 ${hit.count}（${where}）`;
}

/**
 * 出口断言：**不修改**图，只要有一处越界或无法校验就抛错。
 * 这是发往 ComfyUI 之前的最后一道闸门。
 */
export function assertGraphSafe(
  graph: Graph,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
  countLimits: readonly CountLimit[] = DEFAULT_COUNT_LIMITS,
): void {
  const scan = scanGraph(graph, limits, countLimits);
  const details = [
    ...scan.hits.map((h) => ({
      path: `${h.at.nodeId}.inputs.${h.at.field}`,
      message: describeHit(h),
    })),
    ...scan.unresolved.map((u) => ({
      path: `${u.at.nodeId}.inputs.${u.at.field}`,
      message: u.detail,
    })),
    ...scan.overCount.map((c) => ({
      path: `${c.at.nodeId}.inputs.${c.at.field}`,
      message: describeCount(c),
    })),
  ];
  if (details.length > 0) {
    throw AppError.graphValidation(
      `安全护栏拦截：图中有 ${details.length} 处越界或无法校验的取值，已拒绝提交`,
      details,
    );
  }
}

// ---------------------------------------------------------------------------
// 表单输入 ↔ 规则的对应关系
// ---------------------------------------------------------------------------

/** 谁读取了 nodeId 的输出（用于从 binding.target 反查被管控的字段） */
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
  def: TemplateDef,
  graph: Graph | undefined,
  input: TemplateInput,
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
 * 收窄表单下发的 ui.min/max（`GET /api/template`）。
 *
 * 好处：改安全策略只需改一处，前端滑块/数字框自动跟着变，
 * 不需要回头改 template.json 里那份可能过期的提示值。
 */
export function narrowTemplateBounds(
  def: TemplateDef,
  graph: Graph,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
): TemplateDef {
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
  def: TemplateDef,
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
