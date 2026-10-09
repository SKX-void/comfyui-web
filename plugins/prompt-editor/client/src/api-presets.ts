/**
 * 预设库（整份文档）那一摊：增删改查 + 导入导出。
 *
 * 和 `api-block.ts` 一样从 `api.ts` 转出去 —— 调用方照旧 `from './api'` 取，不用知道它被拆过。
 */
import type { Doc } from './model';
import { request } from './api-core';

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

export async function listPresets(): Promise<PresetSummary[]> {
  return (await request<{ presets: PresetSummary[] }>('/presets')).presets;
}

export async function getPreset(id: string): Promise<Preset> {
  return (await request<{ preset: Preset }>(`/presets/${encodeURIComponent(id)}`)).preset;
}

export async function createPreset(name: string, doc: Doc): Promise<Preset> {
  return (
    await request<{ preset: Preset }>('/presets', {
      method: 'POST',
      body: JSON.stringify({ name, doc }),
    })
  ).preset;
}

export async function updatePreset(id: string, patch: { name?: string; doc?: Doc }): Promise<Preset> {
  return (
    await request<{ preset: Preset }>(`/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  ).preset;
}

export async function deletePreset(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * 导出选中的预设（`ids` 空数组 = 全选，这是服务端的语义）。
 *
 * 返回值**原样下载**：文件形状只有服务端那一份定义（`server/exportdoc.ts`），这边不解析也不重拼 ——
 * 拼一份就是第二份定义，迟早和导入那边对不上。
 */
export async function exportPresets(ids: string[]): Promise<unknown> {
  return request<unknown>('/presets/export', { method: 'POST', body: JSON.stringify({ ids }) });
}

/** 导入：**追加**（同名的照收，不覆盖），返回真正导进去的条数与被跳过的坏行 */
export async function importPresets(file: unknown): Promise<{ imported: number; skipped: number; total: number }> {
  return request<{ imported: number; skipped: number; total: number }>('/presets/import', {
    method: 'POST',
    body: JSON.stringify(file),
  });
}
