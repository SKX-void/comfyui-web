/**
 * 插件的接口层。
 *
 * 前缀只有一个常量：`/api/p/image-reverse-inference`（宿主统一给插件加的前缀）。
 */
import type { TaggerParams } from './types';

export const PLUGIN_ID = 'image-reverse-inference';

export const API_BASE = `/api/p/${PLUGIN_ID}`;

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface SettingsResponse {
  /** 存下来的值（原样，没做收敛） */
  values: Record<string, unknown>;
  /** 本次装载真正生效的值 */
  effective: Record<string, unknown>;
  file: string;
  error?: string;
}

/** 模型来自工作流，不是设置：这里只报告它是什么、本机装没装 */
export interface ModelResponse {
  reachable: boolean;
  /** `workflow.json` 里 tagger 节点的 model（空串 = 工作流没写） */
  model: string;
  /** null = 问不到（ComfyUI 连不上或节点没给候选列表），不是「没装」 */
  installed: boolean | null;
}

export type StatusResponse = {
  comfyuiBaseUrl: string;
  inFlight: number;
} & (
  | { comfyui: { reachable: true; version: string | null; device: string | null } }
  | { comfyui: { reachable: false; error: string } }
);

export interface InferResponse {
  promptId: string;
  tags: string;
  model: string;
  uploaded: { name: string; subfolder: string; type: string };
  elapsedMs: number;
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
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  settings: () => request<SettingsResponse>('/settings'),
  /** 存下来的只是值；生效要宿主重挂本插件（`POST /api/tabs/<id>/reload`） */
  saveSettings: (values: Record<string, unknown>) =>
    request<{ values: Record<string, unknown>; file: string; reloadRequired: boolean }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),
  /**
   * 把「这次用的参数」写回默认设置（点「开始反推」时顺手调）。
   *
   * 与 `saveSettings` 的区别：服务端只**并**这几个参数键，不动 `comfyuiBaseUrl`；
   * 也**不需要重挂** —— 本次反推的参数本来就是显式送过去的，落盘只为下次打开。
   */
  saveParams: (params: TaggerParams) =>
    request<{ values: Record<string, unknown>; file: string; reloadRequired: boolean }>('/params', {
      method: 'PUT',
      body: JSON.stringify({ params }),
    }),
  model: () => request<ModelResponse>('/model'),
  status: () => request<StatusResponse>('/status'),
  infer: (body: { dataUrl: string; filename: string; params: TaggerParams }) =>
    request<InferResponse>('/infer', { method: 'POST', body: JSON.stringify(body) }),
};

/** 设置存完让宿主重挂本插件（D20：宿主不监听目录，也不读插件的设置文件） */
export async function reloadPlugin(): Promise<void> {
  await fetch(`/api/tabs/${PLUGIN_ID}/reload`, { method: 'POST' });
}
