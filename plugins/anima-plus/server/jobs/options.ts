import type { DepsService } from '../deps.js';
import type { TriggerResolver } from '../triggers/resolve.js';

export interface ManagerOptions {
  /** 本仓所有任务共用一个 clientId（原因见 server/comfy/real.ts 的注释），靠 prompt_id 区分归属 */
  clientId: string;
  /** 依赖检查服务：提交前查节点用它的缓存（object_info 很贵，缓存策略见 server/deps.ts） */
  deps: DepsService;
  /** 触发词解析（覆盖表 → WeiLin 标签库 → 不注入）；渲染前调用，见 submit */
  triggers: TriggerResolver;
  log: (msg: string, meta?: unknown) => void;
  /** 对账周期（毫秒），默认 10s */
  sweepIntervalMs?: number;
  /** 判定"上游已丢失该任务"的静默时长（毫秒），默认 120s */
  staleJobMs?: number;
  /** 在途任务上限，默认 MAX_QUEUE_DEPTH（可注入便于测试） */
  maxQueueDepth?: number;
  /** 任务表保留条数，默认 MAX_JOBS_RETAINED（可注入便于测试） */
  maxJobsRetained?: number;
}
