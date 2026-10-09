/**
 * 区块库（**预设单块** + 分类）的接口：列表只给摘要（条目可能几百条），插入时按 id 取整条。
 * 跟预设库（整份文档）是两份数据、两条路由。
 *
 * 分类按 id 传（`{'categoryId': ''}` = 未分类），所以**重名无所谓** —— 面板上两个同名分类
 * 是两件不同的事。
 */
import { request } from './api-core';
import type { Mode } from './model';

export interface BlockPresetSummary {
  id: string;
  name: string;
  updatedAt: number;
  /** 归属分类的 id；`''` = 未分类 */
  categoryId: string;
  title: string;
  color: string;
  mode: Mode;
  itemCount: number;
  /** 前几条文本，够认出是哪一块 */
  preview: string[];
}

export interface BlockPreset {
  id: string;
  name: string;
  updatedAt: number;
  categoryId: string;
  title: string;
  color: string;
  mode: Mode;
  /** 条目文本（译文与 id 不存：插入时按当前词库重新查、id 现场生成） */
  items: string[];
}

/** 左栏一行：分类 + 它的块数（计数是后端现算的，不是存的） */
export interface BlockCategorySummary {
  id: string;
  name: string;
  count: number;
}

export async function listBlockPresets(): Promise<BlockPresetSummary[]> {
  return (await request<{ presets: BlockPresetSummary[] }>('/block-presets')).presets;
}

export async function getBlockPreset(id: string): Promise<BlockPreset> {
  return (await request<{ preset: BlockPreset }>(`/block-presets/${encodeURIComponent(id)}`)).preset;
}

export async function createBlockPreset(preset: {
  name: string;
  categoryId: string;
  title: string;
  color: string;
  mode: Mode;
  items: string[];
}): Promise<BlockPreset> {
  return (
    await request<{ preset: BlockPreset }>('/block-presets', { method: 'POST', body: JSON.stringify(preset) })
  ).preset;
}

/** 改名 / 改归类共用（条目内容不在这里改：想改内容就重新存一块） */
export async function updateBlockPreset(id: string, patch: { name?: string; categoryId?: string }): Promise<BlockPreset> {
  return (
    await request<{ preset: BlockPreset }>(`/block-presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  ).preset;
}

export async function deleteBlockPreset(id: string): Promise<boolean> {
  return (
    await request<{ removed: boolean }>(`/block-presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
  ).removed;
}

/** 导出选中的块（`ids` 空数组 = 全选）：返回值原样下载，形状只有服务端那一份定义 */
export async function exportBlockPresets(ids: string[]): Promise<unknown> {
  return request<unknown>('/block-presets/export', { method: 'POST', body: JSON.stringify({ ids }) });
}

/**
 * 导入：**追加**（同名的照收，不覆盖）。分类按名字对齐，文件里认不出的名字会新建一个分类 ——
 * `categoriesCreated` / `categoriesDropped`（分类满员，退到未分类）就是这件事的回执。
 */
export async function importBlockPresets(file: unknown): Promise<{
  imported: number;
  skipped: number;
  categoriesCreated: number;
  categoriesDropped: number;
}> {
  return request<{ imported: number; skipped: number; categoriesCreated: number; categoriesDropped: number }>(
    '/block-presets/import',
    { method: 'POST', body: JSON.stringify(file) },
  );
}

/** 左栏要的东西：分类（含计数）+ 未分类的块数（未分类不是一个分类，所以单独给） */
export async function listBlockCategories(): Promise<{ categories: BlockCategorySummary[]; uncategorized: number }> {
  return request<{ categories: BlockCategorySummary[]; uncategorized: number }>('/block-categories');
}

export async function createBlockCategory(name: string): Promise<BlockCategorySummary> {
  const created = await request<{ category: { id: string; name: string } }>('/block-categories', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return { ...created.category, count: 0 };
}

export async function renameBlockCategory(id: string, name: string): Promise<void> {
  await request<{ category: { id: string } }>('/block-categories', {
    method: 'PUT',
    body: JSON.stringify({ id, name }),
  });
}

/** 删分类：里面的块变未分类（`cleared` = 影响了几块），块本身一条都不删 */
export async function deleteBlockCategory(id: string): Promise<{ removed: boolean; cleared: number }> {
  return request<{ removed: boolean; cleared: number }>('/block-categories', {
    method: 'DELETE',
    body: JSON.stringify({ id }),
  });
}

export async function reorderBlockCategories(ids: string[]): Promise<BlockCategorySummary[]> {
  return (
    await request<{ categories: BlockCategorySummary[] }>('/block-categories/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    })
  ).categories;
}

/** 列表拖完的新顺序（`ids` = 全量，左栏在筛的时候不给拖 —— 见 useBlockLibrary 的 sortable） */
export async function reorderBlockPresets(ids: string[]): Promise<BlockPresetSummary[]> {
  return (
    await request<{ presets: BlockPresetSummary[] }>('/block-presets/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    })
  ).presets;
}
