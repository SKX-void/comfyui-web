/**
 * 词库（`tags.json`）：**一张表两用** —— 翻译按 `en` / `aliases` 命中，面板按 `categories` 分组。
 *
 * 同时吃两种形状：新版 `{ version:2, entries }`（带 categories/aliases）和老的 `dict.json`
 * 平表（只有 en/zh/source）—— 迁移就是"把老文件过一遍这个函数再写到新文件名"。
 */
import { LIMITS } from './constants.js';
import { strList, tagKey } from './prompt.js';
import { asRecord, clampInt, remap } from './util.js';

/** 词条来源：user = 手动入库的（手改 / 显式存过，导入不许覆盖它）· import = 导入的 · builtin = 内置的 */
const TAG_SOURCES: ReadonlySet<string> = new Set(['user', 'import', 'builtin']);
/** 老数据里的 `api`（机器现翻写进去的）归到 import：都不是人认可的，面板里能一键清掉 */
const LEGACY_TAG_SOURCES: Record<string, string> = { api: 'import' };

/** `TAG_SOURCES.has(x)` 的 TS 版（`Set<string>.has` 不收 `unknown`） */
function isTagSource(value: unknown): value is string {
  return typeof value === 'string' && TAG_SOURCES.has(value);
}

export interface TagEntry {
  en: string;
  zh: string;
  categories: string[];
  aliases: string[];
  source: string;
  updatedAt: number;
}

export interface Tags {
  version: 2;
  entries: Record<string, TagEntry>;
  /** 别名索引（派生数据，每次收敛时重算，别手改）：别名键 → 正名键 */
  aliasIndex: Record<string, string>;
}

export interface TagListEntry extends TagEntry {
  key: string;
}

/** 面板查询参数：来自 query string，逐个现查 */
export interface TagQuery {
  q?: unknown;
  category?: unknown;
  limit?: unknown;
}

export interface TagQueryResult {
  tags: TagListEntry[];
  total: number;
  counts: { total: number; uncategorized: number };
  categories: { name: string; count: number }[];
}

export function sanitizeTags(input: unknown): Tags {
  const entries: Record<string, TagEntry> = {};
  const source = asRecord(input);
  const raw = source === null ? null : asRecord(source.entries);
  if (raw === null) return { version: 2, entries, aliasIndex: {} };
  for (const [key, value] of Object.entries(raw)) {
    const entry = asRecord(value);
    if (entry === null) continue;
    const normalized = tagKey(key);
    const zh = typeof entry.zh === 'string' ? entry.zh.trim().slice(0, LIMITS.translation) : '';
    if (normalized === '' || zh === '') continue;
    const en = typeof entry.en === 'string' && entry.en.trim() !== '' ? entry.en.trim() : key;
    entries[normalized] = {
      en: en.slice(0, LIMITS.itemText),
      zh,
      categories: strList(entry.categories, LIMITS.categories, LIMITS.category) ?? [],
      aliases: strList(entry.aliases, LIMITS.aliases, LIMITS.itemText) ?? [],
      source: isTagSource(entry.source) ? entry.source : (remap(LEGACY_TAG_SOURCES, entry.source) ?? 'import'),
      updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : 0,
    };
  }
  return { version: 2, entries, aliasIndex: buildAliasIndex(entries) };
}

/**
 * 别名索引（派生数据，每次收敛时重算，别手改）：别名键 → 正名键。
 * 正名自己在表里、或别名就是另一个正名时，以正名为准（别名不该把正名顶掉）。
 */
function buildAliasIndex(entries: Record<string, TagEntry>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    for (const alias of entry.aliases) {
      const aliasKey = tagKey(alias);
      if (aliasKey === '' || aliasKey === key || entries[aliasKey] !== undefined) continue;
      if (index[aliasKey] === undefined) index[aliasKey] = key;
    }
  }
  return index;
}

/** 查词库：先按正名，再按别名。命中返回词条（调用方只关心"在不在库里"，所以 user/dict 都算在库） */
export function tagsLookup(tags: Tags, text: unknown): TagEntry | null {
  const key = tagKey(text);
  if (key === '') return null;
  const entry = tags?.entries?.[key];
  if (entry !== undefined) return entry;
  const canonical = tags?.aliasIndex?.[key];
  return canonical === undefined ? null : (tags.entries[canonical] ?? null);
}

/**
 * 写一条 / 改一条。**手改的（`source:'user'`）永不被非 user 的写入覆盖** ——
 * 用户改过的就是最终答案，不然下一次自动译会把他刚改的译文又冲掉。
 *
 * 只给 `en` 时（面板里改分类 / 别名）其余字段沿用原值：局部更新不该把译文抹掉。
 */
export function upsertTag(tags: Tags, patch: Record<string, unknown>, now: number = Date.now()): TagEntry | null {
  const en = String(patch?.en ?? patch?.text ?? '').trim();
  const key = tagKey(en);
  if (key === '') return null;
  const current = tags.entries[key];
  const asked = typeof patch?.zh === 'string' ? patch.zh : (typeof patch?.translation === 'string' ? patch.translation : '');
  const zh = asked.trim() === '' ? (current?.zh ?? '') : asked.trim();
  if (zh === '') return null;
  // 不给 source 就沿用原值（面板里只改分类时不该把"导入的"提升成"我认可的"），新条目默认 user
  const askedSource = patch?.source;
  const source = isTagSource(askedSource) ? askedSource : (current?.source ?? 'user');
  if (current !== undefined && current.source === 'user' && source !== 'user') return null;
  tags.entries[key] = {
    en: en.slice(0, LIMITS.itemText),
    zh: zh.slice(0, LIMITS.translation),
    categories: strList(patch?.categories, LIMITS.categories, LIMITS.category) ?? current?.categories ?? [],
    aliases: strList(patch?.aliases, LIMITS.aliases, LIMITS.itemText) ?? current?.aliases ?? [],
    source,
    updatedAt: now,
  };
  tags.aliasIndex = buildAliasIndex(tags.entries);
  return tags.entries[key] ?? null;
}

/** 删一条。返回是否真删掉了 */
export function removeTag(tags: Tags, en: unknown): boolean {
  const key = tagKey(en);
  if (key === '' || tags.entries[key] === undefined) return false;
  delete tags.entries[key];
  tags.aliasIndex = buildAliasIndex(tags.entries);
  return true;
}

/** 面板用：搜索（en / zh / 别名）+ 按分类筛 + 分类计数。分类 `__none__` = 未分类 */
export function queryTags(tags: Tags, options: TagQuery = {}): TagQueryResult {
  const needle = String(options.q ?? '').trim().toLowerCase();
  const category = String(options.category ?? '');
  const limit = clampInt(options.limit, 1, 1000, 200);

  const all = Object.entries(tags.entries).map(([key, entry]) => ({ key, ...entry }));
  const counts = { total: all.length, uncategorized: 0 };
  const byCategory = new Map<string, number>();
  for (const entry of all) {
    if (entry.categories.length === 0) counts.uncategorized += 1;
    for (const name of entry.categories) byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
  }

  const filtered = all.filter((entry) => {
    if (category === '__none__') {
      if (entry.categories.length !== 0) return false;
    } else if (category !== '' && !entry.categories.includes(category)) {
      return false;
    }
    if (needle === '') return true;
    return (
      entry.en.toLowerCase().includes(needle) ||
      entry.zh.includes(needle) ||
      entry.aliases.some((alias) => alias.toLowerCase().includes(needle))
    );
  });
  // 最近改的排前面：刚存进去的那条应该立刻看得见
  filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.en.localeCompare(b.en));

  return {
    tags: filtered.slice(0, limit),
    total: filtered.length,
    counts,
    categories: [...byCategory.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
