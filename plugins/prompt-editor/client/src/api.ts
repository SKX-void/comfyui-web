/**
 * 插件的接口层：前缀只有一个常量（宿主统一给插件加 `/api/p/<id>`），后端就在本插件的 server.js。
 */
import type { Doc } from './model';

export const API_BASE = '/api/p/prompt-editor';

export interface PresetSummary {
  id: string;
  name: string;
  updatedAt: number;
  blockCount: number;
  itemCount: number;
}

export interface Preset extends PresetSummary {
  doc: Doc;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  const raw = await response.text();
  const data: unknown = raw === '' ? null : JSON.parse(raw);
  if (!response.ok) {
    const message = (data as ErrorBody | null)?.error?.message;
    throw new Error(message ?? `请求失败（HTTP ${response.status}）`);
  }
  return data as T;
}

export async function listPresets(): Promise<PresetSummary[]> {
  return (await request<{ presets: PresetSummary[] }>('/presets')).presets;
}

export async function getPreset(id: string): Promise<Preset> {
  return (await request<{ preset: Preset }>(`/presets/${encodeURIComponent(id)}`)).preset;
}

export async function createPreset(name: string, doc: Doc): Promise<Preset> {
  return (await request<{ preset: Preset }>('/presets', {
    method: 'POST',
    body: JSON.stringify({ name, doc }),
  })).preset;
}

export async function updatePreset(id: string, patch: { name?: string; doc?: Doc }): Promise<Preset> {
  return (await request<{ preset: Preset }>(`/presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })).preset;
}

export async function deletePreset(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchDraft(): Promise<Doc | null> {
  return (await request<{ doc: Doc | null }>('/draft')).doc;
}

export async function saveDraft(doc: Doc): Promise<void> {
  await request<{ ok: boolean }>('/draft', { method: 'PUT', body: JSON.stringify({ doc }) });
}
