import type { Job } from '@comfyui-web/shared';
import type { ComfyEvent } from '../comfy/types.js';
import { addAsset } from './asset.js';
import type { JobEventBus } from './event-bus.js';
import { trackerFor, type StagePlan } from './plan.js';

// ---------------------------------------------------------------------------
// 内部：ComfyUI 事件 -> 领域事件
// ---------------------------------------------------------------------------

/** applyComfyEvent 需要的外部依赖（状态仍在 JobManager 里） */
export interface ComfyEventDeps {
  jobs: Map<string, Job>;
  promptToJob: Map<string, string>;
  events: JobEventBus;
  finalize: (job: Job) => Promise<void>;
  /** 当前工作流的执行计划（节点标签 + 权重），见 jobs/plan.ts */
  plan: StagePlan;
}

export function applyComfyEvent(deps: ComfyEventDeps, evt: ComfyEvent): void {
  const promptId = typeof evt.data.prompt_id === 'string' ? evt.data.prompt_id : null;
  if (!promptId) return;
  const jobId = deps.promptToJob.get(promptId);
  if (!jobId) return; // 不属于本服务器的任务（WS 会广播部分事件）
  const job = deps.jobs.get(jobId);
  if (!job) return;

  // 进度按**整条工作流**算（节点号 -> 人话 + 权重），见 jobs/plan.ts
  const tracker = trackerFor(job, deps.plan);

  switch (evt.type) {
    case 'execution_start': {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      deps.events.emit(job, 'started', { status: job.status });
      break;
    }

    case 'execution_cached': {
      // 上游复用了缓存节点，这些节点**不会**再发 executing —— 不在这里认领，
      // 总进度的分母就永远差一截（进度条卡在 9x% 直到任务结束才跳满）
      const cached = evt.data.nodes;
      if (Array.isArray(cached)) {
        for (const nodeId of cached) tracker.finish(String(nodeId));
      }
      break;
    }

    case 'executing': {
      const node = evt.data.node;
      if (node === null) {
        // 执行结束：以 /history 为准落最终状态（WS 只用于进度）
        tracker.finishAll();
        job.progress = tracker.snapshot(0, 0);
        deps.events.emit(job, 'progress', { ...job.progress });
        void deps.finalize(job);
      } else {
        const nodeId = String(node);
        tracker.start(nodeId);
        // 每个节点开头都发一条 progress：没有内部进度事件的节点（VAE 解码等）
        // 也得让标签和总进度立刻动起来，不能等它跑完才更新
        job.progress = tracker.snapshot(0, 0);
        deps.events.emit(job, 'progress', { ...job.progress });
        deps.events.emit(job, 'node', { node: nodeId, label: tracker.label });
      }
      break;
    }

    case 'progress': {
      const value = Number(evt.data.value ?? 0);
      const max = Number(evt.data.max ?? 0);
      // 上游的 progress 带 node（个别版本不带）：带了就以它为准，顺带把"当前节点"对齐
      const nodeId =
        evt.data.node === undefined || evt.data.node === null
          ? tracker.node
          : String(evt.data.node);
      if (nodeId && nodeId !== tracker.node) tracker.start(nodeId);
      tracker.step(value, max);
      if (job.status !== 'running') {
        job.status = 'running';
      }
      job.progress = tracker.snapshot(value, max);
      deps.events.emit(job, 'progress', { ...job.progress });
      break;
    }

    case 'progress_state': {
      // 新式多节点进度：它带着**所有**节点的状态，是比 executing 更全的一份账
      const nodes = evt.data.nodes as
        | Record<string, { value: number; max: number; state: string }>
        | undefined;
      if (!nodes) break;
      let running: { value: number; max: number } | null = null;
      for (const [nodeId, state] of Object.entries(nodes)) {
        if (state.state === 'finished') {
          tracker.finish(nodeId);
        } else if (state.state === 'running') {
          tracker.start(nodeId);
          tracker.step(state.value, state.max);
          running = state;
        }
      }
      if (running) {
        job.progress = tracker.snapshot(running.value, running.max);
        deps.events.emit(job, 'progress', { ...job.progress });
      }
      break;
    }

    case 'executed': {
      const nodeId = evt.data.node;
      if (nodeId !== undefined && nodeId !== null) tracker.finish(String(nodeId));
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
