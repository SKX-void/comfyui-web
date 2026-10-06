/**
 * 扫描命中的形状：越界 / 超限的"证据"，由 `scan.ts` 产出、`describe.ts` 翻译成人话。
 *
 * 单独一个文件是为了让这两边都能引它，而不用互相引。
 */

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
