/**
 * 在跑的作业：内存状态 + SSE 订阅者，以及 ComfyUI 事件 → 作业状态的翻译。
 *
 * 内存表一律归零是契约（D20）：重挂 = 新 fiber，要活下来的只有写进空间的东西。
 * 所以这里的状态**不落盘**，落盘的是作业记录（store）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { TERMINAL, assetUrl } from './meta.js';
import { extFor, sleep } from './util.js';
import type { ComfyClient } from './comfy.js';
import type { JobStore } from './store.js';
import type {
  Graph,
  HistoryResult,
  Job,
  JobAsset,
  JobEntry,
  JobError,
  JobValues,
} from './model.js';

export function createJobs({
  comfy,
  store,
  log,
}: {
  comfy: ComfyClient;
  store: JobStore;
  log: (msg: string) => void;
}) {
  /** jobId → { job, listeners:Set, graph } */
  const live = new Map<string, JobEntry>();
  /** ComfyUI 的 prompt_id → jobId */
  const byPromptId = new Map<string, string>();
  /** progress 事件可能不带 prompt_id，记住当前在跑的 */
  let runningPromptId: string | null = null;

  /** 事件字段一律是 unknown：取字符串统一走这里（null/undefined → null） */
  const str = (value: unknown): string | null =>
    value === undefined || value === null ? null : String(value);

  /** 按 ComfyUI 的 prompt_id 找在跑的作业 */
  function entryOf(promptId: string | null): JobEntry | undefined {
    if (!promptId) return undefined;
    const jobId = byPromptId.get(promptId);
    return jobId ? live.get(jobId) : undefined;
  }

  function snapshot(job: Job): Job {
    return {
      jobId: job.jobId,
      promptId: job.promptId ?? null,
      status: job.status,
      progress: job.progress ?? null,
      node: job.node ?? null,
      values: job.values,
      assets: job.assets ?? [],
      error: job.error ?? null,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    };
  }

  function emit(entry: JobEntry, type: string, data: unknown): void {
    for (const listener of entry.listeners) {
      try {
        listener(type, data);
      } catch (err) {
        log(`SSE 订阅者抛错: ${err}`);
      }
    }
  }

  /** 登记一个作业（提交**之前**就进内存表：SSE 与取消都要能立刻找到它） */
  function register(jobId: string, values: JobValues, graph: Graph): JobEntry {
    const entry: JobEntry = {
      job: {
        jobId,
        promptId: null,
        status: 'queued',
        progress: null,
        node: null,
        values,
        assets: [],
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      },
      listeners: new Set(),
      graph,
    };
    live.set(jobId, entry);
    return entry;
  }

  /** 提交成功：把 ComfyUI 的 prompt_id 与作业对上（之后所有事件都靠它归属） */
  function trackPrompt(promptId: string, jobId: string): void {
    byPromptId.set(promptId, jobId);
  }

  /** 在跑的（还没到终态的）作业数 */
  function inFlight(): number {
    return [...live.values()].filter((e) => !TERMINAL.has(e.job.status)).length;
  }

  /** 按 jobId 找在跑的作业（路由、SSE、取消都从这里进） */
  function find(jobId: string): JobEntry | undefined {
    return live.get(jobId);
  }

  /** 清空内存表（`DELETE /jobs`）：SSE 订阅者手里的 entry 引用会自然失效 */
  function forgetAll(): void {
    live.clear();
    byPromptId.clear();
  }

  /** 终态收尾：拉 history → 下载图片 → 落盘 → 写库 → 推 SSE */
  async function finalize(entry: JobEntry, forcedError?: JobError | null): Promise<void> {
    const job = entry.job;
    if (TERMINAL.has(job.status)) return;

    if (forcedError) {
      job.status = 'failed';
      job.error = forcedError;
      job.finishedAt = new Date().toISOString();
      store.persist(job);
      emit(entry, 'error', { jobId: job.jobId, error: job.error });
      return;
    }

    try {
      // executing(node=null) 与 executed 谁先到不保证，给小重试
      let history: HistoryResult | null = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const promptId = job.promptId;
        history = promptId ? await comfy.history(promptId) : null;
        if (history && history.images.length > 0) break;
        if (history && history.completed && history.statusStr === 'error') break;
        await sleep(attempt === 0 ? 150 : 500);
      }

      const images = history?.images ?? [];
      if (images.length === 0) {
        const failed = history !== null && history.statusStr === 'error';
        throw new Error(
          failed
            ? `ComfyUI 执行失败：${JSON.stringify(history?.messages ?? []).slice(0, 400)}`
            : 'ComfyUI 没有返回图片',
        );
      }

      const dir = store.imageDir(job.jobId);
      fs.mkdirSync(dir, { recursive: true });
      const assets: JobAsset[] = [];
      for (const [idx, image] of images.entries()) {
        const { data, contentType } = await comfy.view(image);
        const ext = extFor(contentType, image.filename);
        const file = path.join(dir, `${idx}${ext}`);
        fs.writeFileSync(file, data);
        // 存相对空间根的路径（不是绝对路径）
        store.saveAsset(job.jobId, idx, file, contentType, data.length);
        assets.push({ idx, url: assetUrl(job.jobId, idx), filename: path.basename(file), mime: contentType, bytes: data.length });
      }

      job.assets = assets;
      job.status = 'succeeded';
      job.progress = { value: job.values.steps, max: job.values.steps };
      job.finishedAt = new Date().toISOString();
      store.persist(job);
      emit(entry, 'completed', { jobId: job.jobId, assets, status: 'succeeded' });
      log(`作业 ${job.jobId} 完成，${assets.length} 张图`);
    } catch (err) {
      job.status = 'failed';
      job.error = { code: 'COMFY_ERROR', message: err instanceof Error ? err.message : String(err) };
      job.finishedAt = new Date().toISOString();
      store.persist(job);
      emit(entry, 'error', { jobId: job.jobId, error: job.error });
      log(`作业 ${job.jobId} 失败：${job.error.message}`);
    }
  }

  /** ComfyUI 事件 → 作业状态；返回退订函数（卸载时调） */
  function attachComfyEvents(): () => void {
    return comfy.onEvent((payload) => {
      const type = payload.type;
      const data = payload.data ?? {};

      if (type === 'execution_start') {
        runningPromptId = str(data.prompt_id);
        const entry = entryOf(runningPromptId);
        if (entry && entry.job.status !== 'running') {
          entry.job.status = 'running';
          entry.job.startedAt = new Date().toISOString();
          store.persist(entry.job);
          emit(entry, 'started', { jobId: entry.job.jobId, status: 'running' });
        }
        return;
      }

      if (type === 'progress') {
        const promptId = str(data.prompt_id) ?? runningPromptId;
        const entry = entryOf(promptId);
        if (!entry) return;
        entry.job.progress = { value: Number(data.value ?? 0), max: Number(data.max ?? 0) };
        emit(entry, 'progress', { jobId: entry.job.jobId, progress: entry.job.progress });
        return;
      }

      if (type === 'executing') {
        const promptId = str(data.prompt_id) ?? runningPromptId;
        const entry = entryOf(promptId);
        if (!entry) return;
        entry.job.node = str(data.node);
        emit(entry, 'node', { jobId: entry.job.jobId, node: entry.job.node });
        if (data.node === null || data.node === undefined) {
          runningPromptId = null;
          void finalize(entry);
        }
        return;
      }

      if (type === 'execution_error') {
        const promptId = str(data.prompt_id) ?? runningPromptId;
        const entry = entryOf(promptId);
        if (!entry) return;
        runningPromptId = null;
        void finalize(entry, {
          code: 'COMFY_EXECUTION_ERROR',
          message: String(data.exception_message ?? 'ComfyUI 执行出错'),
          node: str(data.node_id),
        });
        return;
      }

      if (type === 'execution_interrupted') {
        const promptId = str(data.prompt_id) ?? runningPromptId;
        const entry = entryOf(promptId);
        runningPromptId = null;
        if (!entry || TERMINAL.has(entry.job.status)) return;
        entry.job.status = 'canceled';
        entry.job.finishedAt = new Date().toISOString();
        store.persist(entry.job);
        emit(entry, 'canceled', { jobId: entry.job.jobId });
      }
    });
  }

  /** 取消兜底：真正的状态翻转交给 execution_interrupted，1.5s 后还没翻就自己翻 */
  function cancelFallback(entry: JobEntry): void {
    setTimeout(() => {
      if (!TERMINAL.has(entry.job.status)) {
        entry.job.status = 'canceled';
        entry.job.finishedAt = new Date().toISOString();
        store.persist(entry.job);
        emit(entry, 'canceled', { jobId: entry.job.jobId });
      }
    }, 1500);
  }

  /** 卸载：断开所有 SSE 订阅者并清空内存表（D20：内存状态一律归零） */
  function dispose(): void {
    for (const entry of live.values()) entry.listeners.clear();
    live.clear();
  }

  return {
    find,
    snapshot,
    emit,
    register,
    trackPrompt,
    inFlight,
    forgetAll,
    finalize,
    attachComfyEvents,
    cancelFallback,
    dispose,
  };
}
