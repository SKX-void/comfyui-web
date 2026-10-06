/**
 * 命中的"人话"描述 + 提交前总闸（三层防线的第 3 层）。
 *
 * 扫描在 `scan.ts`，常量与规则表在 `limits.ts`。
 */
import type { Graph } from '@comfyui-web/shared';

import { AppError } from '../errors.js';
import {
  DEFAULT_COUNT_LIMITS,
  DEFAULT_LIMITS,
  type CountLimit,
  type NumericLimit,
} from './limits.js';
import type { CountHit, GuardScan, LimitHit } from './hits.js';
import { guardGraph, scanGraph } from './scan.js';

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
