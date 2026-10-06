import type { Job } from '@comfyui-web/shared';
import type { ComfyEvent } from '../comfy/types.js';
import { addAsset } from './asset.js';
import type { JobEventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// 内部：ComfyUI 事件 -> 领域事件
// ---------------------------------------------------------------------------

/** applyComfyEvent 需要的外部依赖（状态仍在 JobManager 里） */
export interface ComfyEventDeps {
  jobs: Map<string, Job>;
  promptToJob: Map<string, string>;
  events: JobEventBus;
  finalize: (job: Job) => Promise<void>;
}

export function applyComfyEvent(deps: ComfyEventDeps, evt: ComfyEvent): void {
  const promptId = typeof evt.data.prompt_id === 'string' ? evt.data.prompt_id : null;
  if (!promptId) return;
  const jobId = deps.promptToJob.get(promptId);
  if (!jobId) return; // 不属于本服务器的任务（WS 会广播部分事件）
  const job = deps.jobs.get(jobId);
  if (!job) return;

  switch (evt.type) {
    case 'execution_start': {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      deps.events.emit(job, 'started', { status: job.status });
      break;
    }

    case 'executing': {
      const node = evt.data.node;
      if (node === null) {
        // 执行结束：以 /history 为准落最终状态（WS 只用于进度）
        void deps.finalize(job);
      } else {
        deps.events.emit(job, 'node', { node: String(node) });
      }
      break;
    }

    case 'progress': {
      const value = Number(evt.data.value ?? 0);
      const max = Number(evt.data.max ?? 0);
      job.progress = { value, max, node: (evt.data.node as string) ?? null };
      if (job.status !== 'running') {
        job.status = 'running';
      }
      deps.events.emit(job, 'progress', { ...job.progress });
      break;
    }

    case 'progress_state': {
      // 新式多节点进度：取当前 running 节点作为主进度
      const nodes = evt.data.nodes as
        | Record<string, { value: number; max: number; state: string }>
        | undefined;
      if (!nodes) break;
      const running = Object.entries(nodes).find(([, s]) => s.state === 'running');
      if (running) {
        job.progress = { value: running[1].value, max: running[1].max, node: running[0] };
        deps.events.emit(job, 'progress', { ...job.progress });
      }
      break;
    }

    case 'executed': {
      const output = evt.data.output as
        | { images?: Array<{ filename: string; subfolder: string; type: string }> }
        | undefined;
      for (const img of output?.images ?? []) {
        addAsset(job, img);
      }
      break;
    }

    case 'execution_error': {
      job.status = 'failed';
      job.error = {
        code: 'EXECUTION_FAILED',
        message:
          typeof evt.data.exception_message === 'string'
            ? evt.data.exception_message
            : '执行失败',
        node: (evt.data.node_id as string) ?? null,
        detail: evt.data.traceback,
      };
      job.finishedAt = new Date().toISOString();
      deps.events.emit(job, 'error', {
        code: job.error.code,
        message: job.error.message,
        node: job.error.node,
      });
      break;
    }

    case 'execution_interrupted': {
      job.status = 'canceled';
      job.finishedAt = new Date().toISOString();
      deps.events.emit(job, 'canceled', { status: job.status });
      break;
    }

    default:
      break;
  }
}
