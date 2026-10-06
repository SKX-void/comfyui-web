import type {
  CreateJobRequest,
  CreateJobResponse,
  DepsReport,
  HealthResponse,
  HelpDoc,
  Job,
  JobEvent,
  LoraBrowseResponse,
  LoraMeta,
  PresetKindPayload,
  ResolvedTriggerWord,
  TagGroupItem,
  TagItem,
  TemplateDetail,
  TriggerWordsResponse,
} from '@comfyui-web/shared';

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * 本插件的接口前缀（宿主统一加的 `/api/p/<id>`）。
 * 后端就在本插件里（`server/index.ts` 组装、`server/http/routes.ts` 挂路由），**没有反代**。
 */
export const API_BASE = '/api/p/anima-plus';

/** 把上游的 `/api/...` 路径拼成本插件的同源地址（`<img src>` 这类也要用它） */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * 上游在响应里回传的图片地址是**绝对路径**（`/api/assets/...`）。
 * 搬进插件后必须改写到反代前缀下，否则会打到宿主源上（404）。
 *
 * 统一在 api 层做：调用方拿到的就是能直接用的 URL。否则每个用到 `asset.url`
 * 的地方都要记得改写一次，迟早漏。
 */
export function assetUrl(url: string): string {
  return url.startsWith('/api/') ? apiUrl(url) : url;
}

interface AssetLike {
  assetId: string;
  url: string;
  filename?: string;
}

/** 任务里带的产出图 URL 全部改写；其它字段不动 */
function withAssetUrls<T extends { assets?: AssetLike[] }>(job: T): T {
  if (!Array.isArray(job.assets)) return job;
  return { ...job, assets: job.assets.map((a) => ({ ...a, url: assetUrl(a.url) })) };
}

/** 设置端点的响应（字段的**形状**问宿主清单：`package.json` 的 `plugin.settings`） */
export interface PluginSettingsPayload {
  /** 存下来的值（原样，没做范围收敛） */
  values: Record<string, unknown>;
  /** 本次装载真正生效的值（越界已收敛，见 server/config.ts） */
  effective: Record<string, unknown>;
  /** 设置文件的位置，排障用 */
  file: string;
  error?: string;
}

/**
 * 上次提交的参数快照（`<space>/last-state.json`，见 server/state.ts）。
 * 值由前端按模板 input 判定后回填（`restoreValues`），服务端只做原样读写。
 */
export interface LastStatePayload {
  values: Record<string, unknown>;
  /** 上次保存时刻（ISO）；没存过为 null */
  savedAt: string | null;
  /** 快照文件的位置，排障用 */
  file: string;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // ⚠️ 只在有 body 时才带 Content-Type。
  // DELETE 这类无 body 的请求若声明 application/json，Fastify 会直接拒绝：
  // "Body cannot be empty when content-type is set to 'application/json'"
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined && init.body !== null && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(apiUrl(path), { ...init, headers });
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

  /**
   * 依赖检查：模板需要的节点类，这台 ComfyUI 有没有。
   * `refresh` 绕过服务端默认 5 分钟缓存（object_info 很贵，缓存策略见 server/deps.ts）。
   */
  deps: (refresh = false) => request<DepsReport>(`/api/deps${refresh ? '?refresh=1' : ''}`),

  /** 帮助文档：包内 readme.md 的原文（运行前需要装哪些节点包） */
  help: () => request<HelpDoc>('/api/help'),

  /**
   * 本插件唯一的工作流定义（表单 + 绑定 + 图规模）。
   * 没有"列模板再挑一个"这一步：一个插件 = 一个工作流（docs/architecture.md §0 G1）。
   */
  getTemplate: () => request<TemplateDetail>('/api/template'),

  listModels: (folder: string) =>
    request<{ items: string[] }>(`/api/models?folder=${encodeURIComponent(folder)}`),

  createJob: (body: CreateJobRequest) =>
    request<CreateJobResponse>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getJob: (id: string) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`).then(withAssetUrls),

  listJobs: () =>
    request<{ items: Job[] }>('/api/jobs').then((r) => ({
      ...r,
      items: r.items.map(withAssetUrls),
    })),

  /** 清空历史记录：只清已结束的任务，在途任务保留 */
  clearJobs: () =>
    request<{ ok: boolean; cleared: number; kept: number; items: Job[] }>('/api/jobs', {
      method: 'DELETE',
    }).then((r) => ({ ...r, items: r.items.map(withAssetUrls) })),

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

  // --- LoRA 触发词（本插件自管的三态表；Lora堆节点不注入，词由服务端拼） ---

  /** 写入一个 LoRA 的三态：`useDefault` = 界面开关，`word` = 自定义词（空 = 不注入） */
  setTriggerWord: (name: string, useDefault: boolean, word: string) =>
    request<TriggerWordsResponse & { useDefault: boolean; word: string }>('/api/triggers', {
      method: 'PUT',
      body: JSON.stringify({ name, useDefault, word }),
    }),

  /**
   * 解析预览：与提交走同一个 resolver，所以这里返回的就是**真正会注入**的词。
   * 界面不该自己实现一遍优先级（那正是"显示与注入不一致"的老问题）。
   */
  resolveTriggers: (loras: unknown) =>
    request<{ details: ResolvedTriggerWord[] }>('/api/triggers/resolve', {
      method: 'POST',
      body: JSON.stringify({ loras }),
    }),

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

  // --- 上次提交的参数（每次点「开始生成」记一次；刷新页面回填） ---

  getLastState: () => request<LastStatePayload>('/api/state'),

  saveLastState: (values: Record<string, unknown>) =>
    request<LastStatePayload>('/api/state', {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),

  // --- 预设 ---

  listPresets: () => request<{ kinds: PresetKindPayload[] }>('/api/presets'),

  savePreset: (
    kind: string,
    name: string,
    body: { description: string; values: Record<string, unknown> },
  ) =>
    request<{ ok: boolean }>(
      `/api/presets/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  deletePreset: (kind: string, name: string) =>
    request<{ ok: boolean }>(
      `/api/presets/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  translate: (texts: string[]) =>
    request<{ items: Array<{ original: string; translated: string; color: string }> }>(
      '/api/tags/translate',
      { method: 'POST', body: JSON.stringify({ texts }) },
    ),

  // --- 设置：设置归插件自己（server/settings.ts），宿主既不读也不写 ---

  getSettings: () => request<PluginSettingsPayload>('/api/settings'),

  /** 存下来的只是值；生效要宿主重挂本插件（`POST /api/tabs/<id>/reload`，见 SettingsPanel.vue） */
  saveSettings: (values: Record<string, unknown>) =>
    request<{ values: Record<string, unknown>; file: string; reloadRequired: boolean }>(
      '/api/settings',
      { method: 'PUT', body: JSON.stringify({ values }) },
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
  const es = new EventSource(apiUrl(`/api/jobs/${encodeURIComponent(jobId)}/events`));
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
