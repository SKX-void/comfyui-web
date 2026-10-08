import type { Job } from '@comfyui-web/shared';
import { AppError } from '../errors.js';
import type { ComfyClient } from '../comfy/types.js';
import { TERMINAL } from './terminal.js';

/** cancelJob 要的外部依赖（状态仍在 JobManager 里） */
export interface CancelDeps {
  jobs: Map<string, Job>;
  client: ComfyClient;
  log: (msg: string, meta?: unknown) => void;
  /** 发一条领域事件（'canceled'） */
  emit: (job: Job, data: Record<string, unknown>) => void;
}

/**
 * 取消一个任务。
 *
 * 上游的真相优先：同一条 prompt 可能"本地还写着 queued，上游其实已经在跑"（WS 掉帧），
 * 所以先问一次 /queue 再决定 —— `/interrupt` 打断的是**当前执行**的那条，
 * 对排队中的任务调它只会误伤正在跑的那个。
 *
 * 上游清理失败（断线等）也照样本地终结：不能因为摘不掉队列就把任务永远挂在界面上。
 * 已经终态的任务不再变（finalize 里同样先看终态，所以不会"取消完又被判成功"）。
 */
export async function cancelJob(deps: CancelDeps, jobId: string): Promise<Job> {
  const job = deps.jobs.get(jobId);
  if (!job) throw AppError.jobNotFound(jobId);
  if (TERMINAL.has(job.status)) {
    return job;
  }

  if (job.promptId) {
    try {
      const where = await locateUpstream(deps.client, job.promptId);
      if (where === 'running') await deps.client.interrupt();
      else if (where === 'pending') await deps.client.deleteQueueItems([job.promptId]);
    } catch (err) {
      deps.log('取消时清理上游失败（本地仍标记取消）', {
        jobId,
        promptId: job.promptId,
        err: String(err),
      });
    }
  }

  job.status = 'canceled';
  job.finishedAt = new Date().toISOString();
  deps.emit(job, { status: job.status });
  return job;
}

/** 这条 prompt 在上游是"正在跑"、"还在排队"，还是已经不在了 */
async function locateUpstream(
  client: ComfyClient,
  promptId: string,
): Promise<'running' | 'pending' | null> {
  const q = await client.getQueue();
  if (q.running.some((r) => r.promptId === promptId)) return 'running';
  if (q.pending.some((r) => r.promptId === promptId)) return 'pending';
  return null;
}
