/**
 * 插件的接口层。
 *
 * 前缀只有一个常量：`/api/p/anima-example`（宿主统一给插件加的前缀）；
 * 后端就在本插件里（`server.js`），没有反代。
 */

export const API_BASE = '/api/p/anima-example';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export type JobStatus = 'created' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export const TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'canceled'];

export type JobEventType =
  | 'snapshot'
  | 'queued'
  | 'started'
  | 'progress'
  | 'node'
  | 'completed'
  | 'error'
  | 'canceled';

export interface JobValues {
  /** 描述提示词（主输入框）：画什么 */
  description: string;
  /** 正向提示词：质量/风格串，与描述词拼接后才发给 ComfyUI */
  positive: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  batch: number;
  rotation: string | null;
  lora: string | null;
  loraStrength: number | null;
  unet: string | null;
  clip: string | null;
  vae: string | null;
}

export interface JobAsset {
  idx: number;
  url: string;
  filename: string;
  mime: string;
  bytes: number;
}

export interface JobError {
  code: string;
  message: string;
  node?: string | null;
}

export interface Job {
  jobId: string;
  promptId: string | null;
  status: JobStatus;
  progress: { value: number; max: number } | null;
  node: string | null;
  values: JobValues;
  assets: JobAsset[];
  error: JobError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowDefaults extends Omit<JobValues, 'negative'> {
  negative: string;
  hasRotateNode: boolean;
  hasLoraNode: boolean;
}

/** 后端护栏的上下限（App.vue 绑到输入框的 min/max 上） */
export interface PluginLimits {
  minSteps: number;
  maxSteps: number;
  minSide: number;
  maxSide: number;
}

export interface PluginOptions {
  reachable: boolean;
  unet: string[];
  clip: string[];
  clipType: string[];
  vae: string[];
  lora: string[];
  sampler: string[];
  scheduler: string[];
  rotation: string[];
  defaults: WorkflowDefaults;
  workflow: { nodes: number; file: string };
  bindings: Record<string, string | null>;
  settings: Record<string, unknown>;
  limits: PluginLimits;
}

export interface PluginStatus {
  comfyuiBaseUrl: string;
  wsConnected: boolean;
  lastError: string | null;
  inFlight: number;
  comfyui:
    | {
        reachable: true;
        version: string | null;
        device: string | null;
        queue: { running: number; pending: number };
      }
    | { reachable: false; error: string };
}

/** 设置端点的响应（字段的**形状**问宿主清单：package.json 的 plugin.settings） */
export interface PluginSettingsResponse {
  /** 存下来的值（原样，没做范围收敛） */
  values: Record<string, unknown>;
  /** 本次装载真正生效的值（越界已收敛，见 server.js §3.3） */
  effective: Record<string, unknown>;
  /** 设置文件的位置，排障用 */
  file: string;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 无 body 的请求绝不能带 Content-Type：fastify 会拒绝空 JSON body
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined && init.body !== null && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      /* 保持默认信息 */
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => request<PluginStatus>('/status'),
  options: () => request<PluginOptions>('/options'),

  // --- 设置：设置归插件自己（server.js §2.5），宿主既不读也不写 ---
  settings: () => request<PluginSettingsResponse>('/settings'),
  /** 存下来的只是值；生效要宿主重挂本插件（`POST /api/tabs/<id>/reload`，见 SettingsPanel.vue） */
  saveSettings: (values: Record<string, unknown>) =>
    request<{ values: Record<string, unknown>; file: string; reloadRequired: boolean }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),
  createJob: (body: Partial<JobValues>) =>
    request<{ jobId: string; promptId: string; status: JobStatus }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getJob: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  listJobs: (limit = 20) =>
    request<{ items: Job[]; total: number }>(`/jobs?limit=${limit}`),
  cancelJob: (id: string) =>
    request<{ ok: boolean; status?: JobStatus }>(`/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  clearJobs: () => request<{ cleared: number }>('/jobs', { method: 'DELETE' }),
};

const EVENT_TYPES: JobEventType[] = [
  'snapshot',
  'queued',
  'started',
  'progress',
  'node',
  'completed',
  'error',
  'canceled',
];

/**
 * 订阅作业事件（SSE）。返回取消订阅的函数。
 *
 * 服务端在终态会主动关闭流；而 EventSource 见流关闭就会**自动重连**，
 * 于是又收到一次 snapshot、又关闭…… 所以终态事件必须显式 close，否则是死循环。
 */
export function subscribeJob(
  jobId: string,
  onEvent: (type: JobEventType, data: Record<string, unknown>) => void,
): () => void {
  const es = new EventSource(apiUrl(`/jobs/${encodeURIComponent(jobId)}/events`));
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    es.close();
  };

  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (raw) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse((raw as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        /* 坏帧忽略 */
      }
      onEvent(type, data);
      if (type === 'completed' || type === 'error' || type === 'canceled') close();
    });
  }
  es.onerror = () => close();
  return close;
}
