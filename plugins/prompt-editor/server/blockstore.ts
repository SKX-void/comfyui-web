/**
 * 区块库（**预设单块** + 分类）的存储形状与读写：`block-presets.json`。
 *
 * 跟 `presets.json`（整份文档）不是一回事：这里存的是"一块内容"。
 *
 * 分类**按 id 寻址**（`categories: [{ id, name, sort }]`），于是**允许重名** ——
 * "改名撞到已有的名字"整个问题不存在，也不需要"合并 / 报错"那套分支
 * （词库按名字寻址才要面对它，见 `tagdb.ts` 的 `renameCategory`）。
 *
 * 归属是 `preset.categoryId` 一个字符串（**单选**）：多对多才需要归属表，这里不需要；
 * 分类计数一律从 `presets` 现算，**不落盘** —— 省掉"两份计数要同步"的负担。
 *
 * 老文件（v1：没有 `categories` / `categoryId`）直接当"全是未分类"，不做迁移。
 */
import { randomUUID } from 'node:crypto';

import { BLOCK_PRESETS_FILE, DEFAULT_COLOR, LIMITS, isMode, type Mode } from './constants.js';
import { text } from './doc.js';
import { readJson, writeJson } from './store.js';
import { asRecord } from './util.js';

/** 盘上格式的版本号：v2 = 有分类。写出去永远是 2，读进来的 v1 也认 */
const VERSION = 2;
/** 人工排序的步长：整数够用（分类只有几十个），不用词库那套浮点中点 */
const SORT_STEP = 10;

export interface BlockCategory {
  id: string;
  name: string;
  /** 升序即左栏顺序；读进来时一定会被铺成有限数，下游不用兜底 */
  sort: number;
}

export interface BlockPreset {
  id: string;
  name: string;
  updatedAt: number;
  /** 归属的分类 id；`''` = 未分类（分类被删 / 老文件 / 手改坏都是这个值） */
  categoryId: string;
  /** 区块属性：标题 / 颜色 / 风格，插进来长得跟存的时候一样 */
  title: string;
  color: string;
  mode: Mode;
  /** 条目**文本**（顺序即插入顺序），译文与 id 都不存 */
  items: string[];
}

export interface BlockLibrary {
  categories: BlockCategory[];
  presets: BlockPreset[];
}

/** 列表只给摘要：条目可能几百条，面板只需要"这是哪一块、大概什么内容" */
export interface BlockPresetSummary {
  id: string;
  name: string;
  updatedAt: number;
  categoryId: string;
  title: string;
  color: string;
  mode: Mode;
  itemCount: number;
  /** 前几条文本，够认出是哪一块 */
  preview: string[];
}

/** 左栏一行：分类 + 它的块数（现算） */
export interface BlockCategorySummary {
  id: string;
  name: string;
  count: number;
}

const PREVIEW = 3;

function newId(): string {
  return randomUUID();
}

/** 盘上的行 / 请求体 → 合法分类；形状不对返回 null（调用方跳过或给 400）。`index` 只用来兜底排序 */
export function sanitizeBlockCategory(input: unknown, index: number): BlockCategory | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  // 空名字一律拒：分类有 id 也不行 —— 名字是左栏唯一看得见的东西，空行点不中
  const name = text(raw.name, LIMITS.category).trim();
  if (name === '') return null;
  const sort = typeof raw.sort === 'number' && Number.isFinite(raw.sort) ? raw.sort : index * SORT_STEP;
  return { id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : newId(), name, sort };
}

function sanitizeItems(input: unknown): string[] {
  const list = Array.isArray(input) ? input.slice(0, LIMITS.items) : [];
  return list
    .map((item) => text(item, LIMITS.itemText).trim())
    .filter((item) => item !== '')
    .slice(0, LIMITS.items);
}

/** 盘上的数据 / 请求体 → 合法的预设块；形状不对返回 null（调用方给 400 或跳过） */
export function sanitizeBlockPreset(input: unknown): BlockPreset | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  // 名字要 trim：只敲了空格的名字 = 没名字（不然库里会出现一行点不中的空行）
  const name = text(raw.name, LIMITS.name).trim();
  if (name === '') return null;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : newId();
  return {
    id,
    name,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId.slice(0, 64) : '',
    title: text(raw.title, LIMITS.title),
    color: text(raw.color, LIMITS.color) || DEFAULT_COLOR,
    // 风格认不出来就当 tag：跟 `sanitizeBlockMeta` 同一个兜底
    mode: isMode(raw.mode) ? raw.mode : 'tag',
    items: sanitizeItems(raw.items),
  };
}

/**
 * 读整库。坏行跳过（手改坏的文件不该让整个库打不开），并且**在内存里就把归属收敛成合法值**：
 *
 * - 重复的分类 id：只留第一个（id 是寻址键，重复了左栏两行会一起被选中）
 * - `categoryId` 指向不存在的分类：当未分类 —— id 寻址没有名字可以显示，
 *   只能降级（词库按名字寻址，孤儿名字还能显示出来，所以那边是并进分类树）
 */
export function loadBlockLibrary(file: string): BlockLibrary {
  const raw = asRecord(readJson(file, null));
  const categoryRows = raw !== null && Array.isArray(raw.categories) ? raw.categories : [];
  const categories: BlockCategory[] = [];
  const seen = new Set<string>();
  categoryRows.forEach((row, index) => {
    const category = sanitizeBlockCategory(row, index);
    if (category === null || seen.has(category.id)) return;
    seen.add(category.id);
    categories.push(category);
  });
  categories.sort((a, b) => a.sort - b.sort);

  const presetRows = raw !== null && Array.isArray(raw.presets) ? raw.presets : [];
  const presets: BlockPreset[] = [];
  for (const row of presetRows) {
    const preset = sanitizeBlockPreset(row);
    if (preset === null) continue;
    if (!seen.has(preset.categoryId)) preset.categoryId = '';
    presets.push(preset);
  }
  return { categories, presets };
}

export function saveBlockLibrary(file: string, library: BlockLibrary): void {
  writeJson(file, { version: VERSION, categories: library.categories, presets: library.presets });
}

/** 认不出的归属一律归到未分类（分类刚被另一个页面删掉时，存一块不该因此失败） */
export function knownCategoryId(library: BlockLibrary, id: string): string {
  return id !== '' && library.categories.some((one) => one.id === id) ? id : '';
}

export function summarize(preset: BlockPreset): BlockPresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    categoryId: preset.categoryId,
    title: preset.title,
    color: preset.color,
    mode: preset.mode,
    itemCount: preset.items.length,
    preview: preset.items.slice(0, PREVIEW),
  };
}

/** 左栏的行（含计数）。未分类不是分类，所以不在这个列表里，由 `uncategorized()` 单独给 */
export function categorySummaries(library: BlockLibrary): BlockCategorySummary[] {
  const counts = new Map<string, number>();
  for (const preset of library.presets) {
    if (preset.categoryId === '') continue;
    counts.set(preset.categoryId, (counts.get(preset.categoryId) ?? 0) + 1);
  }
  return library.categories.map((one) => ({ id: one.id, name: one.name, count: counts.get(one.id) ?? 0 }));
}

export function uncategorizedCount(library: BlockLibrary): number {
  return library.presets.reduce((n, preset) => (preset.categoryId === '' ? n + 1 : n), 0);
}

/** 新建分类排在最后 */
export function nextSort(library: BlockLibrary): number {
  return library.categories.reduce((max, one) => Math.max(max, one.sort), 0) + SORT_STEP;
}

/**
 * 整列重排：`ids` = 左栏拖完的新顺序（**全量**）。
 *
 * 与词库那套浮点中点不同 —— 分类只有几十个、整库又是一份 JSON，一次全铺序号最简单，
 * 也不会出现"中点用完了"的精度问题。`ids` 里没提到的分类保持原相对顺序垫在后面
 * （手工挑着排的调用方式是合法的，不必因此 500）。
 */
export function reorderCategories(library: BlockLibrary, ids: string[]): void {
  const rank = new Map(ids.map((id, index) => [id, index]));
  const ordered = [...library.categories].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ra === rb ? a.sort - b.sort : ra - rb;
  });
  library.categories = ordered.map((one, index) => ({ ...one, sort: (index + 1) * SORT_STEP }));
}

/**
 * 区块库自己的顺序：`ids` = 列表拖完的新顺序（**全量**）。
 *
 * 跟分类不同，块**不额外存序号** —— `presets` 本来就是有序数组，列表读的就是这个顺序，
 * 所以重排 = 换一下数组的排列（`Sort` 稳定：`ids` 里没提到的保持原相对顺序垫在后面）。
 * 序号字段是给"分类"那种需要被别处排序引用的东西用的，块不需要。
 */
export function reorderBlockPresets(library: BlockLibrary, ids: string[]): void {
  const rank = new Map(ids.map((id, index) => [id, index]));
  library.presets = [...library.presets].sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
