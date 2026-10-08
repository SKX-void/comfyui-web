/**
 * 队列行的形状 + 全局事件流的**纯**部分：把一条 SSE 事件翻译成"该做的几件事"。
 *
 * 这里不碰 Vue 的 ref（副作用留在 useJobs.ts）：翻译是可单测的纯函数，
 * 也让 useJobs 只剩"接线 + 副作用"。
 */
import type { JobProgress } from '@comfyui-web/shared';
import type { JobStreamEvent } from '@/api';

/** 终态：到了就从队列里挪走，只剩历史表里那一行 */
export const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** 队列里的一条在途任务（进度卡按它渲染） */
export interface QueueJob {
  jobId: string;
  promptId: string | null;
  status: string;
  progress: JobProgress | null;
  /** 0~100，由 progress 算出（不单独维护，免得两处漂移） */
  percent: number;
  error: string | null;
  createdAt: string;
  /** 本次提交时定下的种子（界面回显；服务端渲染时还会再抽一次兜底，见 templates/render.ts） */
  seed: number | null;
}

/** 队列行：多两个给界面用的派生字段 */
export interface QueueRow extends QueueJob {
  /** 中文状态（进度卡的 pill 用它，所以别把英文状态直接摊给用户） */
  label: string;
  /** 排队位次（1 起）；已经在跑的是 null */
  waiting: number | null;
}

const STATUS_LABEL: Record<string, string> = {
  created: '已创建',
  queued: '排队中',
  running: '执行中',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function asText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * 进度条宽度：**总进度**（服务端按整张图算的 overall）优先。
 * 回落到单节点 value/max 只是为了兼容不带 overall 的旧快照 —— 那正是"每换一个节点归零一次"的旧观感。
 */
export function percentOf(progress: JobProgress | null): number {
  if (!progress) return 0;
  if (typeof progress.overall === 'number') {
    return Math.max(0, Math.min(100, Math.round(progress.overall)));
  }
  if (!progress.max) return 0;
  return Math.min(100, Math.round((progress.value / progress.max) * 100));
}

/** 合并一条任务状态；队列里没有就按"新任务"补进来（别的浏览器标签提交的也会这么出现） */
export function mergeJob(rows: QueueJob[], jobId: string, patch: Partial<QueueJob>): QueueJob[] {
  const at = rows.findIndex((q) => q.jobId === jobId);
  const base: QueueJob = at === -1
    ? {
        jobId,
        promptId: null,
        status: 'created',
        progress: null,
        percent: 0,
        error: null,
        createdAt: new Date().toISOString(),
        seed: null,
      }
    : rows[at]!;
  const merged: QueueJob = { ...base, ...patch };
  merged.percent = percentOf(merged.progress);
  const rest = rows.filter((q) => q.jobId !== jobId);
  // 按提交时间排 = 队列视图的顺序（快照不带时间时用到达顺序兜底，见 createdAt 的兜底）
  return [...rest, merged].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 产出图（服务端下发的原始 URL，改写反代前缀是界面层的事） */
export interface JobAssetRef {
  assetId: string;
  url: string;
  filename: string;
}

/** 一条事件该引起的副作用（useJobs 逐条执行；顺序有意义） */
export type StreamEffect =
  | { kind: 'patch'; jobId: string; patch: Partial<QueueJob> }
  | { kind: 'log'; line: string }
  | { kind: 'assets'; jobId: string; assets: JobAssetRef[] }
  | { kind: 'error'; message: string }
  | { kind: 'drop'; jobId: string }
  | { kind: 'refresh' };

/**
 * 事件 → 副作用。
 *
 * `known` = 队列里当前有没有这条：终态事件对"已经不认识的"任务必须忽略 ——
 * 本地已摘除（用户点了取消）或那是历史里的旧任务，不能让它凭空长回队列。
 */
export function reduceStreamEvent(evt: JobStreamEvent, known: boolean): StreamEffect[] {
  const { jobId, type, data } = evt;
  const short = jobId.slice(0, 12);

  switch (type) {
    case 'snapshot': {
      const patch: Partial<QueueJob> = {
        status: String(data.status ?? 'created'),
        progress: (data.progress as JobProgress | null) ?? null,
        error: (data.error as { message?: string } | null)?.message ?? null,
      };
      // 服务端带上了提交时间：刷新页面后队列顺序不会乱（不带就用"现在"兜底）
      const createdAt = asText(data.createdAt);
      if (createdAt) patch.createdAt = createdAt;
      return [{ kind: 'patch', jobId, patch }];
    }
    case 'queued':
      return [{ kind: 'patch', jobId, patch: { status: 'queued', promptId: asText(data.promptId) } }];
    case 'started':
      return [{ kind: 'patch', jobId, patch: { status: 'running' } }];
    case 'progress':
      return [
        {
          kind: 'patch',
          jobId,
          patch: {
            status: 'running',
            progress: {
              value: Number(data.value ?? 0),
              max: Number(data.max ?? 0),
              node: (data.node as string | null) ?? null,
              label: asText(data.label),
              overall: typeof data.overall === 'number' ? data.overall : undefined,
            },
          },
        },
      ];
    case 'node': {
      // 节点号对用户没有意义（"节点 27"）：有标签就打标签，节点号只留作排查线索
      const node = String(data.node);
      const label = asText(data.label);
      return [
        { kind: 'log', line: `${short}… 执行：${label ? `${label}（节点 ${node}）` : `节点 ${node}`}` },
      ];
    }
    case 'completed': {
      if (!known) return [];
      const assets = ((data.assets as JobAssetRef[] | undefined) ?? []).map((a) => ({ ...a }));
      return [
        { kind: 'assets', jobId, assets },
        { kind: 'log', line: `完成 ${short}… · 产出 ${assets.length} 张` },
        { kind: 'drop', jobId },
        { kind: 'refresh' },
      ];
    }
    case 'error': {
      if (!known) return [];
      const message = String(data.message ?? '执行失败');
      return [
        { kind: 'error', message },
        { kind: 'log', line: `失败 ${short}…: ${message}` },
        { kind: 'drop', jobId },
        { kind: 'refresh' },
      ];
    }
    case 'canceled':
      if (!known) return [];
      return [
        { kind: 'log', line: `已取消 ${short}…` },
        { kind: 'drop', jobId },
        { kind: 'refresh' },
      ];
    default:
      return [];
  }
}
