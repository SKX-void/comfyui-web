/**
 * 插件的接口层：前缀只有一个常量（宿主统一给插件加 `/api/p/<id>`），后端就在本插件的 server.js。
 */
import type { BlockMeta, Doc, Item } from './model';

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

/** 一条译文是怎么来的：词库命中且是人认可的 / 词库命中 / 现翻的 / 语法跳过 / 没翻成 */
export type TranslateSource = 'user' | 'dict' | 'api' | 'skip' | 'empty' | 'error';

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
}

export interface TagList {
  tags: TagEntry[];
  total: number;
  counts: { total: number; uncategorized: number };
  categories: { name: string; count: number }[];
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

export async function deleteTagEntry(en: string): Promise<boolean> {
  return (
    await request<{ ok: boolean; deleted: boolean }>('/tags/entry', { method: 'DELETE', body: JSON.stringify({ en }) })
  ).deleted;
}

