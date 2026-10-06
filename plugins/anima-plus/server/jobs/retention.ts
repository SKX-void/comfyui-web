import type { Job } from '@comfyui-web/shared';
import { TERMINAL } from './terminal.js';

/** 任务表（内存 Map）的保留规则：在途任务永不丢，只丢已终态的 */

/** 在途任务数（created / queued / running） */
export function countInFlightJobs(jobs: Map<string, Job>): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (!TERMINAL.has(j.status)) n += 1;
  }
  return n;
}

/**
 * 任务表按条数淘汰：超过上限时**从最旧的开始丢**（Map 保持插入顺序，
 * 也就是"从前舍弃"）。只丢已终态的任务 —— 在途任务被丢掉就意味着
 * 它永远收不到终态事件，还会一直占着队列名额。
 */
export function evictOldJobsOverLimit(
  jobs: Map<string, Job>,
  promptToJob: Map<string, string>,
  maxJobsRetained: number,
  log: (msg: string, meta?: unknown) => void,
): void {
  if (jobs.size <= maxJobsRetained) return;
  let dropped = 0;
  for (const [id, j] of jobs) {
    if (jobs.size <= maxJobsRetained) break;
    if (!TERMINAL.has(j.status)) continue;
    jobs.delete(id);
    if (j.promptId) promptToJob.delete(j.promptId);
    dropped += 1;
  }
  if (dropped > 0) {
    log('任务表超出上限，已从最旧的开始淘汰', {
      dropped,
      retained: jobs.size,
      max: maxJobsRetained,
    });
  }
}

/**
 * 清空历史记录（前端「清空」按钮）。
 *
 * 历史本来就在内存里（不持久化），这里只是手动丢掉。
 * **只清已终态的**：在途任务的记录一删，它后面的事件就没地方落了，
 * 用户还会以为"什么都没在跑"，而 GPU 其实正忙着 —— 所以留着，并把数量回报给前端。
 */
export function clearFinishedJobs(
  jobs: Map<string, Job>,
  promptToJob: Map<string, string>,
  log: (msg: string, meta?: unknown) => void,
): { cleared: number; kept: number } {
  let cleared = 0;
  for (const [id, job] of jobs) {
    if (!TERMINAL.has(job.status)) continue;
    jobs.delete(id);
    if (job.promptId) promptToJob.delete(job.promptId);
    cleared += 1;
  }
  const kept = countInFlightJobs(jobs);
  log('已清空历史记录', { cleared, kept });
  return { cleared, kept };
}
