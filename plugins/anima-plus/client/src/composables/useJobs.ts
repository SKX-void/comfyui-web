/**
 * 作业生命周期：提交 / SSE 进度 / 产出 / 取消 / 复用 + 历史列表。
 *
 * 提交要用表单值和"存快照"，这两样在 `useTemplate()` 手里，所以从外面传进来（App.vue 接线）。
 */
import { computed, ref, type Ref } from 'vue';
import type { Job, JobProgress, TemplateDetail } from '@comfyui-web/shared';
import { api, apiUrl, assetUrl, subscribeJob } from '@/api';
import { drawSeed, normalizeValues, type FieldModel } from '@/form';

export function useJobs(
  pushLog: (line: string) => void,
  template: Ref<TemplateDetail | null>,
  values: Ref<FieldModel>,
  saveLastState: (payload: Record<string, unknown>) => Promise<void>,
) {
const submitting = ref(false);

const activeJobId = ref<string | null>(null);

const status = ref<string>('空闲');

const progress = ref<JobProgress | null>(null);

const assets = ref<Array<{ assetId: string; url: string; filename: string }>>([]);

const errorMessage = ref<string | null>(null);

const history = ref<Job[]>([]);

const clearing = ref(false);
let unsubscribe: (() => void) | null = null;
async function refreshHistory(): Promise<void> {
  try {
    history.value = (await api.listJobs()).items.slice(0, 8);
  } catch {
    /* 忽略 */
  }
}

/** 清空历史记录：服务端只清已结束的任务，在途的会保留 */
async function clearHistory(): Promise<void> {
  clearing.value = true;
  try {
    const res = await api.clearJobs();
    history.value = res.items.slice(0, 8);
    const parts = [`已清空 ${res.cleared} 条历史`];
    if (res.kept > 0) parts.push(`${res.kept} 个任务还在跑，已保留`);
    status.value = parts.join('，');
    pushLog(parts.join('，'));
  } catch (e) {
    status.value = '清空失败';
    pushLog(`清空历史失败: ${(e as Error).message}`);
  } finally {
    clearing.value = false;
  }
}

async function submit(): Promise<void> {
  if (!template.value) return;
  submitting.value = true;
  errorMessage.value = null;
  assets.value = [];
  progress.value = null;
  status.value = '提交中…';

  try {
    // 随机开启：现在抽定，并写回表单 —— 提交的值与界面显示的必须是同一个数
    if (values.value.randomSeed === true) {
      const drawn = drawSeed();
      values.value = { ...values.value, seed: drawn };
      pushLog(`随机种子: ${drawn}`);
    }
    const payload = normalizeValues(template.value.inputs, values.value);
    // 快照就是这次提交出去的那一份（含刚抽定的种子）：刷新页面回填的必须是"跑过的参数"
    void saveLastState(payload);
    const res = await api.createJob({ values: payload });
    activeJobId.value = res.jobId;
    pushLog(`任务已创建 ${res.jobId} · promptId=${res.promptId ?? '-'}`);

    unsubscribe?.();
    unsubscribe = subscribeJob(res.jobId, (evt) => {
      switch (evt.type) {
        case 'snapshot':
          status.value = String(evt.data.status ?? '');
          if (evt.data.progress) progress.value = evt.data.progress as JobProgress;
          break;
        case 'queued':
          status.value = '排队中';
          break;
        case 'started':
          status.value = '执行中';
          break;
        case 'progress': {
          const p = evt.data as unknown as JobProgress;
          progress.value = { value: p.value, max: p.max, node: p.node ?? null };
          status.value = '执行中';
          break;
        }
        case 'node':
          pushLog(`执行节点 ${String(evt.data.node)}`);
          break;
        case 'completed': {
          status.value = '已完成';
          // SSE 是绕开 api 层的第二条数据入口，产出图 URL 同样要改写到反代前缀下
          const raw =
            (evt.data.assets as Array<{ assetId: string; url: string; filename: string }>) ?? [];
          assets.value = raw.map((a) => ({ ...a, url: assetUrl(a.url) }));
          pushLog(`完成 · 产出 ${assets.value.length} 张`);
          submitting.value = false;
          cleanup();
          void refreshHistory();
          break;
        }
        case 'error': {
          status.value = '失败';
          errorMessage.value = String(evt.data.message ?? '执行失败');
          pushLog(`错误: ${errorMessage.value}`);
          submitting.value = false;
          cleanup();
          void refreshHistory();
          break;
        }
        case 'canceled':
          status.value = '已取消';
          submitting.value = false;
          cleanup();
          break;
      }
    });
  } catch (err) {
    const e = err as Error & { details?: unknown };
    errorMessage.value = e.message;
    status.value = '提交失败';
    submitting.value = false;
    pushLog(`提交失败: ${e.message}`);
    if (e.details) pushLog(`详情: ${JSON.stringify(e.details)}`);
  }
}

function cleanup(): void {
  unsubscribe?.();
  unsubscribe = null;
}

async function cancel(): Promise<void> {
  if (!activeJobId.value) return;
  try {
    await api.cancelJob(activeJobId.value);
    pushLog('已请求取消');
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

const percent = computed(() => {
  const p = progress.value;
  if (!p || !p.max) return 0;
  return Math.min(100, Math.round((p.value / p.max) * 100));
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
    activeJobId,
    progress,
    assets,
    errorMessage,
    history,
    clearing,
    percent,
    assetThumbUrl,
    submit,
    cancel,
    reuse,
    clearHistory,
    refreshHistory,
  };
}
