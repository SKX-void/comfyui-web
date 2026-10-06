import type { Job } from '@comfyui-web/shared';
import type { ComfyClient } from '../comfy/types.js';
import type { WorkflowDefinition } from '../templates/loader.js';
import { addAsset } from './asset.js';
import type { JobEventBus } from './event-bus.js';
import { TERMINAL } from './terminal.js';

/** finalizeJob 需要的外部依赖（状态仍在 JobManager 里） */
export interface FinalizeDeps {
  client: ComfyClient;
  workflow: WorkflowDefinition;
  log: (msg: string, meta?: unknown) => void;
  events: JobEventBus;
}

/**
 * 读取 history，带短重试。
 *
 * 必要性：`executing node=null`（结束信号）与 ComfyUI 落盘 history 之间存在竞态，
 * 首次读取可能拿到 `completed: false`。真实环境同样会有这个窗口。
 */
async function readHistorySettled(
  client: ComfyClient,
  promptId: string,
): Promise<Awaited<ReturnType<ComfyClient['getHistory']>>> {
  const attempts = 5;
  const delayMs = 120;
  let last = null as Awaited<ReturnType<ComfyClient['getHistory']>>;
  for (let i = 0; i < attempts; i++) {
    last = await client.getHistory(promptId);
    if (last?.completed) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
}

/** 终态对账：状态真相源是 ComfyUI /history，不是 WS */
export async function finalizeJob(deps: FinalizeDeps, job: Job): Promise<void> {
  if (TERMINAL.has(job.status)) {
    return;
  }
  let completed = false;
  let historyAssets: Array<{ filename: string; subfolder: string; type: string }> = [];
  let statusStr = 'unknown';

  try {
    const history = job.promptId ? await readHistorySettled(deps.client, job.promptId) : null;
    if (history) {
      completed = history.completed;
      statusStr = history.statusStr;
      const wanted = new Set(deps.workflow.get().def.outputs.nodes);
      for (const [nodeId, output] of Object.entries(history.outputs)) {
        if (wanted.size > 0 && !wanted.has(nodeId)) continue;
        for (const img of output.images ?? []) historyAssets.push(img);
      }
      if (historyAssets.length === 0) {
        for (const output of Object.values(history.outputs)) {
          for (const img of output.images ?? []) historyAssets.push(img);
        }
      }
    }
  } catch (err) {
    deps.log('读取 history 失败', { jobId: job.jobId, err: String(err) });
  }

  for (const img of historyAssets) addAsset(job, img);

  job.finishedAt = new Date().toISOString();
  if (completed && job.assets.length > 0) {
    job.status = 'succeeded';
    deps.events.emit(job, 'completed', {
      status: job.status,
      assets: job.assets,
      historyStatus: statusStr,
    });
  } else if (completed) {
    job.status = 'succeeded';
    deps.events.emit(job, 'completed', { status: job.status, assets: [], historyStatus: statusStr });
  } else {
    job.status = 'failed';
    job.error = {
      code: 'EXECUTION_FAILED',
      message: `执行未成功完成 (history status: ${statusStr})`,
    };
    deps.events.emit(job, 'error', { code: job.error.code, message: job.error.message });
  }

  deps.log('任务终态', { jobId: job.jobId, status: job.status, assets: job.assets.length });
}
