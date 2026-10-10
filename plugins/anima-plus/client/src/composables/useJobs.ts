/**
 * 作业生命周期：**队列**（提交 / 进度 / 产出 / 取消）+ 复用 + 历史列表。
 *
 * 队列是这块的核心：点一次「开始生成」只是往 ComfyUI 队列里排一条，POST 一回来表单就解锁 ——
 * 改完参数可以接着排下一条（在途上限由服务端 `maxQueueDepth` 兜着，满了返回 QUEUE_FULL）。
 * 因此这里跟的是一"批"任务，不是"一个当前任务"；进度卡按队列渲染。
 *
 * 所有任务的进度走**一条**全局 SSE（`/api/jobs/events`，见 server/http/routes/jobs.ts）：
 * 浏览器对同源 HTTP/1.1 只给 6 条连接，每个任务各开一条 EventSource 会把队列深度本身
 * 变成连接数上限，缩略图和历史刷新就都排不上了。
 *
 * 提交要用表单值和"存快照"，这两样在 `useWorkflow()` 手里，所以从外面传进来（App.vue 接线）。
 * 队列行的形状与"事件 → 该做什么"的翻译在 `jobs-stream.ts`（纯函数，本文件只接线 + 副作用）。
 */
import { computed, ref, type Ref } from 'vue';
import type { Job, WorkflowDetail } from '@comfyui-web/shared';
import { api, apiUrl, assetUrl, subscribeJobs, type JobStreamEvent } from '@/api';
import { drawSeed, normalizeValues, type FieldModel } from '@/form';
import {
  mergeJob,
  reduceStreamEvent,
  statusLabel,
  TERMINAL,
  type QueueJob,
  type QueueRow,
} from './jobs-stream';

export function useJobs(
  pushLog: (line: string) => void,
  workflow: Ref<WorkflowDetail | null>,
  values: Ref<FieldModel>,
  saveLastState: (payload: Record<string, unknown>) => Promise<void>,
) {
  /** 只在 POST /api/jobs 那一下为 true —— 队列在跑不影响它，表单要一直能改 */
  const submitting = ref(false);
  const errorMessage = ref<string | null>(null);

  const queue = ref<QueueJob[]>([]);
  const history = ref<Job[]>([]);
  const clearing = ref(false);

  /** 最近一条完成任务的产出（进度卡里的大图） */
  const recentAssets = ref<Array<{ assetId: string; url: string; filename: string }>>([]);
  const recentJobId = ref<string | null>(null);

  let unsubscribe: (() => void) | null = null;

  // ---- 队列维护 ----------------------------------------------------------

  function applyJob(jobId: string, patch: Partial<QueueJob>): void {
    queue.value = mergeJob(queue.value, jobId, patch);
  }

  function dropJob(jobId: string): void {
    queue.value = queue.value.filter((q) => q.jobId !== jobId);
  }

  function hasJob(jobId: string): boolean {
    return queue.value.some((q) => q.jobId === jobId);
  }

  function onStreamEvent(evt: JobStreamEvent): void {
    for (const effect of reduceStreamEvent(evt, hasJob(evt.jobId))) {
      switch (effect.kind) {
        case 'patch':
          applyJob(effect.jobId, effect.patch);
          break;
        case 'log':
          pushLog(effect.line);
          break;
        case 'assets':
          // SSE 是绕开 api 层的第二条数据入口，产出图 URL 同样要改写到反代前缀下
          recentAssets.value = effect.assets.map((a) => ({ ...a, url: assetUrl(a.url) }));
          recentJobId.value = effect.jobId;
          break;
        case 'error':
          errorMessage.value = effect.message;
          break;
        case 'drop':
          dropJob(effect.jobId);
          break;
        case 'refresh':
          void refreshHistory();
          break;
      }
    }
  }

  /**
   * 跟服务端对一次账：列表里已经是终态的任务，队列里就不该再留着。
   *
   * 这条兜的是"SSE 断线期间任务跑完了"——重连只会补发**在途**任务的快照，
   * 已结束的那条不会再有事件，只能靠对账把它从队列里摘掉。
   */
  function reconcile(items: Job[]): void {
    if (queue.value.length === 0) return;
    const byId = new Map(items.map((j) => [j.jobId, j]));
    let changed = false;
    const kept: QueueJob[] = [];
    for (const q of queue.value) {
      const job = byId.get(q.jobId);
      if (job && TERMINAL.has(job.status)) {
        changed = true;
        if (job.status === 'succeeded' && job.assets.length > 0 && recentJobId.value !== job.jobId) {
          recentAssets.value = job.assets.map((a) => ({ ...a, url: assetUrl(a.url) }));
          recentJobId.value = job.jobId;
        }
        continue;
      }
      kept.push(q);
    }
    if (changed) queue.value = kept;
  }

  async function refreshHistory(): Promise<void> {
    try {
      const items = (await api.listJobs()).items;
      history.value = items.slice(0, 8);
      reconcile(items);
    } catch {
      /* 忽略 */
    }
  }

  // ---- 事件流 ------------------------------------------------------------

  /** 订阅全局任务事件流（App.vue 挂载时调一次；重复调用是空操作） */
  function start(): void {
    if (unsubscribe) return;
    unsubscribe = subscribeJobs(onStreamEvent, {
      // 重连成功就对一次账：断线期间跑完的任务不会有事件补发
      onOpen: () => void refreshHistory(),
      onError: (err) => pushLog(`任务事件流中断，浏览器会自动重连（${err.type || 'error'}）`),
    });
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  // ---- 提交 / 取消 / 复用 -------------------------------------------------

  async function submit(): Promise<void> {
    if (!workflow.value) return;
    submitting.value = true;
    errorMessage.value = null;

    try {
      // 随机开启：现在抽定，并写回表单 —— 提交的值与界面显示的必须是同一个数
      if (values.value.randomSeed === true) {
        const drawn = drawSeed();
        values.value = { ...values.value, seed: drawn };
        pushLog(`随机种子: ${drawn}`);
      }
      const payload = normalizeValues(workflow.value.inputs, values.value);
      // 快照就是这次提交出去的那一份（含刚抽定的种子）：刷新页面回填的必须是"跑过的参数"
      void saveLastState(payload);
      const res = await api.createJob({ values: payload });
      const seed = typeof payload.seed === 'number' && payload.seed >= 0 ? payload.seed : null;
      applyJob(res.jobId, {
        promptId: res.promptId,
        status: res.status,
        createdAt: res.createdAt,
        seed,
      });
      pushLog(
        `已加入队列 ${res.jobId} · promptId=${res.promptId ?? '-'}（在途 ${queue.value.length} 个）`,
      );
      // 兜底：调用方忘了 start() 也要能收到进度（重复调用无害）
      start();
    } catch (err) {
      const e = err as Error & { details?: unknown };
      errorMessage.value = e.message;
      pushLog(`提交失败: ${e.message}`);
      if (e.details) pushLog(`详情: ${JSON.stringify(e.details)}`);
    } finally {
      // 只锁这一下 —— 队列在跑不影响继续改参数、接着排下一条
      submitting.value = false;
    }
  }

  /**
   * 取消一条任务。在跑的打断当前执行，排队的从 ComfyUI 队列里摘掉（服务端按上游队列判断，
   * 不靠本地状态猜 —— WS 掉线时本地会以为还在排队，其实已经在跑）。
   */
  async function cancel(jobId: string): Promise<void> {
    try {
      await api.cancelJob(jobId);
      pushLog(`已请求取消 ${jobId.slice(0, 12)}…`);
      // 乐观摘除；随后真到的 canceled 事件会因为"队列里没这条"被忽略（见 onStreamEvent）
      dropJob(jobId);
    } catch (err) {
      pushLog(`取消失败: ${(err as Error).message}`);
    }
  }

  function reuse(job: Job): void {
    // 复用 = 复现同一张图：种子必须是**当时那个具体数**，所以顺手关掉随机，
    // 否则下一次提交又抽新的，复用就白点了。
    const resolved = job.seeds ?? {};
    const next: Record<string, unknown> = { ...values.value, ...job.values };
    for (const [key, seed] of Object.entries(resolved)) next[key] = seed;
    if (Object.keys(resolved).length > 0) next.randomSeed = false;
    values.value = next;
    const seedKeys = Object.keys(resolved);
    pushLog(
      seedKeys.length > 0
        ? `已复用任务 ${job.jobId} 的参数（种子 ${seedKeys.map((k) => resolved[k]).join(', ')}，已切换为固定种子）`
        : `已复用任务 ${job.jobId} 的参数`,
    );
  }

  /** 清空历史记录：服务端只清已结束的任务，在途的会保留 */
  async function clearHistory(): Promise<void> {
    clearing.value = true;
    try {
      const res = await api.clearJobs();
      history.value = res.items.slice(0, 8);
      const parts = [`已清空 ${res.cleared} 条历史`];
      if (res.kept > 0) parts.push(`${res.kept} 个任务还在跑，已保留`);
      pushLog(parts.join('，'));
    } catch (e) {
      pushLog(`清空历史失败: ${(e as Error).message}`);
    } finally {
      clearing.value = false;
    }
  }

  // ---- 派生 --------------------------------------------------------------

  const queueRows = computed<QueueRow[]>(() => {
    let waiting = 0;
    return queue.value.map((q) => {
      const isWaiting = q.status !== 'running';
      if (isWaiting) waiting += 1;
      return { ...q, label: statusLabel(q.status), waiting: isWaiting ? waiting : null };
    });
  });

  const status = computed(() => {
    if (submitting.value) return '提交中…';
    const rows = queue.value;
    if (rows.length === 0) return '空闲';
    const running = rows.filter((q) => q.status === 'running').length;
    const parts: string[] = [];
    if (running > 0) parts.push(`执行中 ${running}`);
    if (rows.length - running > 0) parts.push(`排队 ${rows.length - running}`);
    return parts.join(' · ');
  });

  /**
   * 任务列表里的小图走缩略图端点。
   * 产出图可能是 1~2MB，用来渲染 56px 的缩略图纯属浪费网络。
   */
  function assetThumbUrl(assetId: string): string {
    return apiUrl(`/api/assets/${encodeURIComponent(assetId)}/thumb?w=112&h=112`);
  }

  return {
    status,
    submitting,
    queue: queueRows,
    queueCount: computed(() => queue.value.length),
    recentAssets,
    recentJobId,
    errorMessage,
    history,
    clearing,
    assetThumbUrl,
    submit,
    cancel,
    reuse,
    clearHistory,
    refreshHistory,
    start,
    stop,
  };
}
