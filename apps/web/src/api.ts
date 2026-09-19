import type {
  CreateJobRequest,
  CreateJobResponse,
  HealthResponse,
  Job,
  JobEvent,
  LoraBrowseResponse,
  LoraMeta,
  TagGroupItem,
  TagItem,
  TemplateDetail,
} from '@comfyui-server/shared';

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let details: unknown;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error?.message ?? message;
      details = body.error?.details;
    } catch {
      /* 保持默认信息 */
    }
    const err = new Error(message) as Error & { details?: unknown; status?: number };
    err.details = details;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>('/api/system/health'),

  listTemplates: () =>
    request<{ items: Array<{ id: string; name: string; description: string; version: string }> }>(
      '/api/templates',
    ),

  getTemplate: (id: string) =>
    request<TemplateDetail>(`/api/templates/${encodeURIComponent(id)}`),

  listModels: (folder: string) =>
    request<{ items: string[] }>(`/api/models?folder=${encodeURIComponent(folder)}`),

  createJob: (body: CreateJobRequest) =>
    request<CreateJobResponse>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getJob: (id: string) => request<Job>(`/api/jobs/${encodeURIComponent(id)}`),

  listJobs: () => request<{ items: Job[] }>('/api/jobs'),

  cancelJob: (id: string) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  // --- WeiLin 数据源 ---

  /**
   * LoRA 目录浏览：一次只取一层（子目录 + 当前目录直属的 LoRA）。
   * 不递归 —— 避免把 290 个 LoRA 一次性丢给浏览器。
   */
  browseLoras: (path = '') =>
    request<LoraBrowseResponse>(`/api/loras/browse?path=${encodeURIComponent(path)}`),

  getLoraMeta: (file: string) =>
    request<LoraMeta>(`/api/loras/meta?file=${encodeURIComponent(file)}`),

  listTagGroups: () => request<{ items: TagGroupItem[] }>('/api/tags/groups'),

  listTags: (params: { q?: string; groupId?: number; page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.groupId) qs.set('groupId', String(params.groupId));
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 60));
    return request<{ items: TagItem[]; total: number; page: number; pageSize: number }>(
      `/api/tags?${qs.toString()}`,
    );
  },

  autocompleteTags: (q: string) =>
    request<{ items: TagItem[] }>(`/api/tags/autocomplete?q=${encodeURIComponent(q)}`),

  translate: (texts: string[]) =>
    request<{ items: Array<{ original: string; translated: string; color: string }> }>(
      '/api/tags/translate',
      { method: 'POST', body: JSON.stringify({ texts }) },
    ),
};

/**
 * 订阅任务事件（SSE）。返回取消订阅函数。
 * 服务端连接即发 snapshot，因此断线重连不需要回放。
 */
export function subscribeJob(
  jobId: string,
  onEvent: (evt: JobEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  const types: JobEvent['type'][] = [
    'snapshot',
    'queued',
    'started',
    'progress',
    'node',
    'completed',
    'error',
    'canceled',
  ];
  for (const type of types) {
    es.addEventListener(type, (raw) => {
      const evt = raw as MessageEvent<string>;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(evt.data) as Record<string, unknown>;
      } catch {
        /* 忽略坏帧 */
      }
      onEvent({ type, data });
    });
  }
  es.onerror = (err) => {
    onError?.(err);
    es.close();
  };
  return () => es.close();
}
