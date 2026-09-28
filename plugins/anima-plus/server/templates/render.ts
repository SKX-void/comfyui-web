import type { Graph, TemplateDef, TemplateInput } from '@comfyui-web/shared';
import { AppError } from '../errors.js';
import { SEED_RANDOM, applyTransform } from './transforms.js';
import {
  type EffectiveBounds,
  type LimitHit,
  describeCount,
  describeHit,
  effectiveBounds,
  guardGraph,
  userSourceOf,
  whenMatches,
} from '../safety/limits.js';

export interface LoadedTemplate {
  def: TemplateDef;
  graph: Graph;
  /** template.json 所在目录，用于取缩略图等 */
  dir: string;
}

/**
 * 按 input 类型做值归一化与校验（docs/archive/v1-templates.md §5 步骤 2）。
 *
 * `graph` 用于把安全上限（plugins/anima-plus/docs/safety.md）折算到字段上：模板里的 `ui.max`
 * 只是 UI 提示，真正说了算的是安全策略，两者取交集。
 * 不传 graph 时退化为"只认模板自己的 ui 边界"——越界值仍会被后面的护栏挡住。
 */
export function coerceValues(
  def: TemplateDef,
  values: Record<string, unknown>,
  graph?: Graph,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const details: Array<{ path: string; message: string }> = [];

  for (const input of def.inputs) {
    const raw = values[input.key];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (input.required && input.default === undefined) {
        details.push({ path: `values.${input.key}`, message: `${input.label}：必填项缺失` });
        continue;
      }
      if (input.default !== undefined) out[input.key] = input.default;
      continue;
    }

    try {
      out[input.key] = coerceOne(input, raw, effectiveBounds(def, graph, input));
    } catch (err) {
      // 带上字段名：前端目前只展示 message，details 只是给程序看的
      details.push({
        path: `values.${input.key}`,
        message: `${input.label}：${(err as Error).message}`,
      });
    }
  }

  if (details.length > 0) {
    throw AppError.templateValidation(
      `表单值校验失败：${details.map((d) => d.message).join('；')}`,
      details,
    );
  }
  return out;
}

function coerceOne(input: TemplateInput, raw: unknown, bounds: EffectiveBounds): unknown {
  switch (input.type) {
    case 'number':
    case 'slider':
    case 'seed': {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || Number.isNaN(n)) {
        throw new Error(`必须是数字，收到 ${JSON.stringify(raw)}`);
      }
      // seed 的 -1 是"每次随机"的占位值，不是真实的种子，天然要豁免下界；
      // 上界则必须查，否则 1e20 这种超范围值会原样落图（采样器 seed 上界 ≈ 2^64）。
      if (input.type === 'seed' && n === SEED_RANDOM) return n;
      const note = bounds.fromPolicy ? '（服务端安全限制）' : '';
      if (bounds.min !== undefined && n < bounds.min) {
        throw new Error(`不能小于 ${bounds.min}${note}`);
      }
      if (bounds.max !== undefined && n > bounds.max) {
        throw new Error(`不能大于 ${bounds.max}${note}`);
      }
      return n;
    }
    case 'switch':
      return typeof raw === 'boolean' ? raw : raw === 'true' || raw === 1;
    case 'lora-select':
    case 'tag-selector':
      if (input.ui?.multiple || Array.isArray(raw)) {
        if (!Array.isArray(raw)) throw new Error('必须是数组');
        const max = bounds.countMax;
        if (max !== undefined && raw.length > max) {
          throw new Error(`最多 ${max} 个（服务端安全限制），收到 ${raw.length} 个`);
        }
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

/** 渲染产物 */
export interface RenderResult {
  graph: Graph;
  values: Record<string, unknown>;
  /**
   * seed transform 落到图上的**实际**种子，按输入 key 索引。
   * values 里用户填的 -1（"每次随机"）会原样留着，想复用本次结果就得看这里。
   */
  seeds: Record<string, number>;
  /** 护栏夹紧的记录：只可能是模板自带值（用户值越界会直接抛错） */
  safety: { clamped: LimitHit[] };
}

/**
 * 渲染：把表单值注入模板 graph（docs/archive/v1-templates.md §5）。
 *
 * 返回**新的** graph，不修改模板（深拷贝）。
 *
 * 最后一步是安全护栏（plugins/anima-plus/docs/safety.md）——这里是"值已经全部落图"的唯一位置，
 * 也是模板/transform/预设三条来路都必经的收口：
 *   - 越界值能追溯到用户输入 → 抛错（给出字段级提示，绝不悄悄改用户的参数）
 *   - 只来自模板（const/默认图） → 夹紧到安全值并记在 `safety.clamped` 里
 *   - 取值无法判定 → 抛错（fail closed，宁可拒绝也不猜）
 */
export function renderTemplate(
  tpl: LoadedTemplate,
  rawValues: Record<string, unknown>,
): RenderResult {
  const values = coerceValues(tpl.def, rawValues, tpl.graph);
  const graph: Graph = structuredClone(tpl.graph);

  // 走 seed transform 的实际值。用户填 -1 时这里才拿到"这次到底用了哪个种子"，
  // 而 values 里始终留着 -1（表单语义：下次还想随机），所以要单独回传。
  const seeds: Record<string, number> = {};

  for (const binding of tpl.def.bindings) {
    if (!whenMatches(binding.when, values)) continue;

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
    if (binding.transform === 'seed' && typeof value === 'number') {
      seeds[binding.from ?? binding.target] = value;
    }
    setPath(graph, binding.target, value);
  }

  const scan = guardGraph(graph);

  if (scan.unresolved.length > 0) {
    throw AppError.templateValidation(
      `安全上限无法校验，已拒绝提交（模板 ${tpl.def.id} 的 graph 需要修正）`,
      scan.unresolved.map((u) => ({
        path: `${u.at.nodeId}.inputs.${u.at.field}`,
        message: u.detail,
      })),
    );
  }

  const fromUser = scan.hits.flatMap((hit) => {
    const src = userSourceOf(tpl.def, hit, values);
    return src ? [{ hit, src }] : [];
  });
  if (fromUser.length > 0) {
    throw AppError.templateValidation(
      `参数超出服务端安全限制：${fromUser.map(({ hit }) => describeHit(hit)).join('；')}`,
      fromUser.map(({ hit, src }) => ({
        path: `values.${src.key}`,
        message: `${src.label}：${describeHit(hit)}`,
      })),
    );
  }

  // 数量超限（LoRA 堆）：一律拒绝，绝不截断 —— 截断等于悄悄丢掉用户选的 LoRA
  if (scan.overCount.length > 0) {
    const items = scan.overCount.map((hit) => ({
      hit,
      src: userSourceOf(tpl.def, hit, values),
    }));
    throw AppError.templateValidation(
      `超出服务端安全限制：${items.map(({ hit }) => describeCount(hit)).join('；')}`,
      items.map(({ hit, src }) => ({
        path: src ? `values.${src.key}` : `${hit.at.nodeId}.inputs.${hit.at.field}`,
        message: src ? `${src.label}：${describeCount(hit)}` : describeCount(hit),
      })),
    );
  }

  return { graph, values, seeds, safety: { clamped: scan.hits } };
}
