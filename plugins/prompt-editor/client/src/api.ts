/**
 * 插件的接口层：前缀只有一个常量（宿主统一给插件加 `/api/p/<id>`），后端就在本插件的 server.js。
 *
 * 地基（前缀 + 取 JSON）在 `api-core.ts`，预设库在 `api-presets.ts`，区块库在 `api-block.ts` ——
 * 都从这里转出去，所以调用方照旧 `from './api'` 取，不用知道它们被拆过。
 */
import type { BlockMeta, Doc, Item } from './model';
import { request } from './api-core';

export * from './api-presets';
export * from './api-block';
export { API_BASE, request } from './api-core';

export async function fetchDraft(): Promise<Doc | null> {
  return (await request<{ doc: Doc | null }>('/draft')).doc;
}

/**
 * 草稿的两个写事件（按"改了多大一块"分派，别整份发）：
 * - 组结构变了：区块增删/排序/标题/颜色/风格 → 只发结构，不含条目
 * - 某个组编辑完了：只发那个组的条目
 */
export async function saveDraftStructure(blocks: BlockMeta[]): Promise<void> {
  await request<{ ok: boolean }>('/draft/structure', { method: 'PUT', body: JSON.stringify({ blocks }) });
}

export async function saveDraftItems(blockId: string, items: Item[]): Promise<void> {
  await request<{ ok: boolean }>(`/draft/blocks/${encodeURIComponent(blockId)}/items`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
}

/** 整份替换：载入预设 / 清空工作区（不在编辑热路径上） */
export async function saveDraft(doc: Doc): Promise<void> {
  await request<{ ok: boolean }>('/draft', { method: 'PUT', body: JSON.stringify({ doc }) });
}

// ── 翻译：译文由后端统一去拿（词库优先，provider 兜底；key 不下发到浏览器）──────

export interface TranslateSettings {
  provider: string;
  autoTranslate: boolean;
  maxCallsPerDay: number;
  timeoutMs: number;
  /** 两次 provider 调用之间的最小间隔（体验版限流紧，默认 6s） */
  minIntervalMs: number;
}

export interface TranslateUsage {
  date: string;
  calls: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  fields: string[];
}

export interface SettingsPayload {
  settings: TranslateSettings;
  usage: TranslateUsage;
  tagCount: number;
  providers: ProviderInfo[];
}

/** 一条译文是怎么来的：词库命中（你改过的 / 内置的）/ 词库命中（导入的机翻表）/ 现翻的 / 语法跳过 / 没翻成 */
export type TranslateSource = 'user' | 'dict' | 'import' | 'api' | 'skip' | 'empty' | 'error';

export interface TranslateResult {
  text: string;
  translation: string;
  source: TranslateSource;
}

export interface TranslateOutcome {
  results: TranslateResult[];
  error?: { code: string; message: string };
}

export async function fetchSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>('/settings');
}

export async function saveSettings(settings: Partial<TranslateSettings>): Promise<TranslateSettings> {
  return (await request<{ settings: TranslateSettings }>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  })).settings;
}

/** 结果按 texts 顺序对齐返回（调用方自己记 id ↔ 下标） */
export async function translateTexts(texts: string[]): Promise<TranslateOutcome> {
  return request<TranslateOutcome>('/translate', { method: 'POST', body: JSON.stringify({ texts }) });
}

// ── 词库：一张表两用（翻译按 en/别名命中，面板按分类分组）────────────────────

/**
 * user = 手动入库的（手改 / 显式存过）· import = 导入的 · builtin = 内置的。
 *
 * 词库里**不按来源分标签** —— 进了库就是库（都是你认可的）。这个字段只影响
 * 工作区命中时画「我」还是「库」。
 */
export type TagSource = 'user' | 'import' | 'builtin';

export interface TagEntry {
  key: string;
  en: string;
  zh: string;
  categories: string[];
  aliases: string[];
  source: TagSource;
  updatedAt: number;
  /** 热度（导入数据的 post count，自己写的条目是 0）：面板那一页就是按它排序的 */
  hot: number;
}

export interface TagList {
  tags: TagEntry[];
  /** 命中总数，**最多报到 `limit + 1`**（面板只显示一页，精确值要全表扫） */
  total: number;
  counts: { total: number; uncategorized: number };
  /** 分类树（含空分类）：`parent` 非空 = 某个大类下的小类，面板按它排两级（见 TagCategoryNav） */
  categories: { name: string; count: number; parent: string | null }[];
}

/** 面板查询：`category` 传 `__none__` = 未分类 */
export async function listTags(query: { q?: string; category?: string; limit?: number } = {}): Promise<TagList> {
  const params = new URLSearchParams();
  if (query.q !== undefined && query.q !== '') params.set('q', query.q);
  if (query.category !== undefined && query.category !== '') params.set('category', query.category);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return request<TagList>(`/tags${suffix === '' ? '' : `?${suffix}`}`);
}

/**
 * 写一条 / 改一条。手改译文、点「机」存进词库、面板里改分类或别名，都走这里。
 * 不给 `source` 就沿用原值（新条目默认 `user`）。
 */
export async function saveTagEntry(entry: {
  en: string;
  zh?: string;
  categories?: string[];
  aliases?: string[];
  source?: TagSource;
}): Promise<TagEntry> {
  return (
    await request<{ ok: boolean; entry: TagEntry }>('/tags/entry', { method: 'PUT', body: JSON.stringify(entry) })
  ).entry;
}

/**
 * 分类级操作（分类本身是一张表，跟"某个 tag 属于谁"分开）。
 *
 * 新建**只加名字，一条词都不动** —— 这样"先建分类、再往里放词"才走得通（靠给 tag 打新名字
 * 来间接建分类的话，建完不马上用就会消失）。
 */
export async function createCategory(name: string): Promise<boolean> {
  return (await request<{ ok: boolean; created: boolean }>('/tags/categories', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })).created;
}

/** 删掉分类**连它下面的归属一起删**；返回受影响的词条数（词条本身不删，只是变回未分类） */
export async function deleteCategory(name: string): Promise<number> {
  return (await request<{ ok: boolean; removed: number }>('/tags/categories', {
    method: 'DELETE',
    body: JSON.stringify({ name }),
  })).removed;
}

/** 重命名分类（两张表一起改）；目标名字已存在时服务端 409（不自动合并） */
export async function renameCategory(from: string, to: string): Promise<number> {
  return (await request<{ ok: boolean; moved: number }>('/tags/categories', {
    method: 'PUT',
    body: JSON.stringify({ from, to }),
  })).moved;
}

export async function deleteTagEntry(en: string): Promise<boolean> {
  return (
    await request<{ ok: boolean; deleted: boolean }>('/tags/entry', { method: 'DELETE', body: JSON.stringify({ en }) })
  ).deleted;
}

/**
 * 手动排序：把**当前这一页的新顺序**（`keys`）和**被拖的那一条**（`moved`）发过去。
 *
 * `moved` 是必需的：服务端取左右邻居的中点只写 1 行，它得知道"哪一条动了" ——
 * 光看一串 key 是看不出来的（顺序是相对一整页说的，服务端不知道原来长什么样）。
 */
export async function saveTagOrder(keys: string[], moved: string): Promise<{ written: number; rebuilt: boolean }> {
  return await request<{ ok: boolean; written: number; rebuilt: boolean }>('/tags/order', {
    method: 'PUT',
    body: JSON.stringify({ keys, moved }),
  });
}

/**
 * 分类树的手动顺序。跟 `saveTagOrder` 同一套（`names` = 新顺序，`moved` = 被拖的那个），
 * 区别是服务端**第一次拖就整树铺序号** —— 分类只有几个，不用"手动的是前缀"那套。
 */
export async function saveCategoryOrder(
  names: string[],
  moved: string,
): Promise<{ written: number; rebuilt: boolean }> {
  return await request<{ ok: boolean; written: number; rebuilt: boolean }>('/tags/categories/order', {
    method: 'PUT',
    body: JSON.stringify({ names, moved }),
  });
}

/**
 * **批量删除**一个分类下的词条：那些 `tags` 行真删（不是只摘归属），分类留着。
 * 返回删了几条、其中几条是手改过的（`userDeleted`）—— 面板要把"删掉了什么"说出来。
 */
export async function deleteCategoryEntries(name: string): Promise<{ deleted: number; userDeleted: number }> {
  return await request<{ ok: boolean; deleted: number; userDeleted: number }>('/tags/categories/entries', {
    method: 'DELETE',
    body: JSON.stringify({ name }),
  });
}

/** 产物里的一份词库表：`available:false` = 产物里没有它（面板就不画那个按钮） */
export interface BundledAsset {
  available: boolean;
  bytes: number;
}

/** 产物里的两份内置表：`danbooru-zh.csv`（机翻，32 万条）+ `weilin-zh.csv`（人工，4 千条带两级分类） */
export interface BundledTags extends BundledAsset {
  builtin: BundledAsset;
}

export async function fetchBundledTags(): Promise<BundledTags> {
  return (await request<{ bundled: BundledTags }>('/tags/import')).bundled;
}

/**
 * 导入结果。`written` 是**真写进去的**条数，`skipped` 是被守卫挡下、这次没动的
 * （机翻那层只许盖机翻、人工那层不许盖手改的 —— 见 `tagdb.ts` 的 `ImportGuard`）。
 */
export interface TagImportResult {
  /** 两层加起来解析后的候选条数 */
  rows: number;
  written: number;
  skipped: number;
  before: number;
  after: number;
  /** 每一层导完的报数（面板拿它把「机翻多少 + 人工多少」说清楚） */
  layers: { name: string; rows: number; written: number }[];
  /** 共现邻居表：老产物里没有这份文件时 `available:false`（词库照样是导好的） */
  cooccur: { available: boolean; kept: number; written: number };
  elapsedMs: number;
}

export async function importBundledTags(): Promise<TagImportResult> {
  return await request<TagImportResult>('/tags/import', { method: 'POST' });
}

