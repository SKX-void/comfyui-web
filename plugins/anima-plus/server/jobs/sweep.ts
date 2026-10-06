import type { Job } from '@comfyui-web/shared';
import type { ComfyClient } from '../comfy/types.js';
import type { JobEventBus } from './event-bus.js';
import { TERMINAL } from './terminal.js';

/** sweepJobs 需要的外部依赖（状态仍在 JobManager 里） */
export interface SweepDeps {
  jobs: Map<string, Job>;
  client: ComfyClient;
  staleJobMs: number;
  log: (msg: string, meta?: unknown) => void;
  events: JobEventBus;
  finalize: (job: Job) => Promise<void>;
}

/**
 * 对账：把非终态任务与上游 /history + /queue 对齐。
 *
 * 存在的必要性（已实测）：
 * WS 事件可能因断线或客户端 bug 丢失，此时任务会永久停在 queued/running。
 */
export async function sweepJobs(deps: SweepDeps): Promise<void> {
  const candidates = [...deps.jobs.values()].filter(
    (j) => j.promptId !== null && !TERMINAL.has(j.status),
  );
  if (candidates.length === 0) return;

  let queueIds: Set<string> | null = null;
  try {
    const q = await deps.client.getQueue();
    queueIds = new Set(
      [...q.running, ...q.pending]
        .map((r) => r.promptId)
        .filter((id): id is string => typeof id === 'string'),
    );
  } catch {
    // 上游不可达：本轮跳过，不误判
  }

  for (const job of candidates) {
    const promptId = job.promptId;
    if (!promptId) continue;
    try {
      const history = await deps.client.getHistory(promptId);
      if (history?.completed) {
        deps.log('对账：任务已完成，补发终态', { jobId: job.jobId, status: job.status });
        await deps.finalize(job);
        continue;
      }
      const inQueue = queueIds?.has(promptId) ?? false;
      const ageMs = Date.now() - new Date(job.startedAt ?? job.createdAt).getTime();
      if (queueIds !== null && !inQueue && !history && ageMs > deps.staleJobMs) {
        job.status = 'failed';
        job.error = {
          code: 'EXECUTION_FAILED',
          message: '任务在上游既不在队列也无历史记录（可能被 ComfyUI 重启清除）',
        };
        job.finishedAt = new Date().toISOString();
        deps.log('对账：任务已丢失', { jobId: job.jobId, promptId });
        deps.events.emit(job, 'error', {
          code: job.error.code,
          message: job.error.message,
        });
      }
    } catch {
      // 单次对账失败不影响其它任务
    }
  }
}
