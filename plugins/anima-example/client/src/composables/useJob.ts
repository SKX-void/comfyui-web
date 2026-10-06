import { computed, inject, onMounted, onUnmounted, provide, ref, type InjectionKey } from 'vue';

import {
  api,
  subscribeJob,
  TERMINAL_STATUSES,
  type Job,
  type JobEventType,
  type PluginOptions,
  type PluginStatus,
} from '../api';
import { useForm } from './useForm';

/**
 * 插件的全部状态与请求。
 *
 * 界面被拆进 components/ 下的子组件，父组件的 `scoped` 样式管不到子组件内部，
 * 所以状态用 provide/inject 共享：只有这里持有一份，子组件不再各自造状态。
 */
export function useJob() {
  const options = ref<PluginOptions | null>(null);
  const status = ref<PluginStatus | null>(null);
  const loadError = ref('');
  /** 设置面板：本插件的设置由自己持有（见 SettingsPanel.vue），宿主设置页对它只读 */
  const settingsOpen = ref(false);

  const submitBusy = ref(false);
  const current = ref<Job | null>(null);
  const history = ref<Job[]>([]);
  const historyTotal = ref(0);

  const { form, limits, joinedPrompt, applyDefaults, loadValues, rollSeed, toPayload } = useForm(options);

  let unsubscribe: (() => void) | null = null;

  const running = computed(
    () => current.value !== null && !TERMINAL_STATUSES.includes(current.value.status),
  );
  const canSubmit = computed(() => joinedPrompt.value !== '' && !submitBusy.value && !running.value);
  const progressPercent = computed(() => {
    const p = current.value?.progress;
    if (!p || !p.max) return 0;
    return Math.min(100, Math.round((p.value / p.max) * 100));
  });

  const STATUS_LABEL: Record<string, string> = {
    created: '已创建',
    queued: '排队中',
    running: '生成中',
    succeeded: '完成',
    failed: '失败',
    canceled: '已取消',
  };

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function loadOptions(): Promise<void> {
    try {
      const o = await api.options();
      options.value = o;
      applyDefaults(o);
      loadError.value = o.reachable ? '' : 'ComfyUI 的 /object_info 拉不到，模型下拉是空的（仍可手填）。';
    } catch (err) {
      loadError.value = `读取选项失败：${message(err)}`;
    }
  }

  async function loadStatus(): Promise<void> {
    try {
      status.value = await api.status();
    } catch (err) {
      loadError.value = `读取状态失败：${message(err)}`;
    }
  }

  async function refreshHistory(): Promise<void> {
    try {
      const r = await api.listJobs(20);
      history.value = r.items;
      historyTotal.value = r.total;
    } catch (err) {
      loadError.value = `读取历史失败：${message(err)}`;
    }
  }

  /** 订阅一个作业的 SSE，把事件并进 `current` */
  function watchJob(jobId: string): void {
    unsubscribe?.();
    current.value = null;
    unsubscribe = subscribeJob(jobId, (type: JobEventType, data) => {
      const job = current.value;
      if (type === 'snapshot') {
        current.value = data as unknown as Job;
        return;
      }
      if (!job || job.jobId !== jobId) return;
      if (type === 'started') job.status = 'running';
      if (type === 'progress') job.progress = data.progress as Job['progress'];
      if (type === 'node') job.node = (data.node as string | null) ?? null;
      if (type === 'queued') job.status = 'queued';
      if (type === 'completed') {
        job.status = 'succeeded';
        job.assets = (data.assets as Job['assets']) ?? [];
        void refreshHistory();
      }
      if (type === 'error') {
        job.status = 'failed';
        job.error = (data.error as Job['error']) ?? null;
        void refreshHistory();
      }
      if (type === 'canceled') {
        job.status = 'canceled';
        void refreshHistory();
      }
    });
  }

  async function submit(): Promise<void> {
    submitBusy.value = true;
    loadError.value = '';
    try {
      const created = await api.createJob(toPayload());
      watchJob(created.jobId);
      void loadStatus();
    } catch (err) {
      loadError.value = `提交失败：${message(err)}`;
    } finally {
      submitBusy.value = false;
    }
  }

  async function cancel(): Promise<void> {
    if (!current.value) return;
    try {
      await api.cancelJob(current.value.jobId);
    } catch (err) {
      loadError.value = `取消失败：${message(err)}`;
    }
  }

  /** 点历史：把参数灌回表单，并把它的图显示在右边 */
  function loadFromHistory(job: Job): void {
    // 在跑的作业要重新订阅，否则刷新页面后点进来只能看到一条不动的记录
    if (!TERMINAL_STATUSES.includes(job.status)) {
      loadValues(job);
      watchJob(job.jobId);
      return;
    }
    unsubscribe?.();
    unsubscribe = null;
    current.value = job;
    loadValues(job);
  }

  async function clearHistory(): Promise<void> {
    if (!window.confirm('清空历史记录？图片文件不会被删除。')) return;
    await api.clearJobs();
    current.value = null;
    await refreshHistory();
  }

  function formatTime(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  onMounted(async () => {
    await Promise.all([loadOptions(), loadStatus(), refreshHistory()]);
  });

  onUnmounted(() => {
    unsubscribe?.();
  });

  return {
    options,
    status,
    loadError,
    settingsOpen,
    current,
    history,
    historyTotal,
    form,
    limits,
    joinedPrompt,
    running,
    canSubmit,
    progressPercent,
    STATUS_LABEL,
    loadStatus,
    submit,
    cancel,
    loadFromHistory,
    clearHistory,
    rollSeed,
    formatTime,
  };
}

export type JobContext = ReturnType<typeof useJob>;

const JOB_KEY: InjectionKey<JobContext> = Symbol('anima-example/job');

export function provideJob(job: JobContext): void {
  provide(JOB_KEY, job);
}

/** 子组件取状态：必须在 App.vue 的 provide 之下调用（setup 期间） */
export function useJobContext(): JobContext {
  const job = inject(JOB_KEY);
  if (!job) throw new Error('useJobContext() 必须在 provideJob() 之下的组件里调用');
  return job;
}
