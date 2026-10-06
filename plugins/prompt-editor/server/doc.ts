/**
 * 形状收敛：盘上的、请求里的数据都不信任，一律过一遍。
 *
 * 顺带定义跑起来之后流来流去的形状（Doc / Stored / Preset）—— 与前端 `client/src/model.ts`
 * 的 Doc / Item 是同一份形状的两侧。
 *
 * 草稿在盘上分两段：组结构（顺序 + 属性）与条目（按区块 id 分组）。
 * 拆开是为了**一次编辑只写一段**：改区块属性只动结构（O(区块数)，不含条目），
 * 某个区块编辑完只动它自己的条目（O(该区块条目数)）。
 * 整份 doc 一起写的话，改一个字就要把全文档重新序列化+传一遍，放大太厉害。
 */
import { randomUUID } from 'node:crypto';

import { LIMITS, isMode, type Mode } from './constants.js';
import { asRecord, isRecord, remap } from './util.js';

export interface Item {
  id: string;
  text: string;
  enabled: boolean;
  translation: string;
  /** 译文来源：'' 未知/无译文 · api 现翻（没进词库）· dict 词库命中 */
  source: string;
}

/** 区块的「属性」（不含条目）：标题 / 颜色 / 风格。顺序由数组本身表达 */
export interface BlockMeta {
  id: string;
  title: string;
  color: string;
  mode: Mode;
}

export interface Block extends BlockMeta {
  items: Item[];
}

export interface Doc {
  version: 1;
  blocks: Block[];
}

/** 盘上草稿的两段：`structure` 是区块属性，`items` 按区块 id 分组 */
export interface Stored {
  structure: BlockMeta[];
  items: Record<string, Item[]>;
}

/** 盘上草稿的整份形状（`storedFromRaw` 之前的原始文件） */
export interface Raw {
  version: 1;
  blocks: BlockMeta[];
  items: Record<string, Item[]>;
}

export interface Preset {
  id: string;
  name: string;
  updatedAt: number;
  doc: Doc;
}

/**
 * 条目来源只有两态：`dict` = 这条译文在词库里 · `api` = 机器现翻的、还没进库。
 * （徽章只说"在不在库里" —— "谁写的"不再区分：手改的、词库命中的、点「机」存过的，都在库里。）
 */
const ITEM_SOURCES: ReadonlySet<string> = new Set(['api', 'dict']);
/** 老草稿里的 `user`（手改的）折进 `dict` */
const LEGACY_ITEM_SOURCES: Record<string, string> = { user: 'dict' };

/** `ITEM_SOURCES.has(x)` 的 TS 版（`Set<string>.has` 不收 `unknown`） */
function isItemSource(value: unknown): value is string {
  return typeof value === 'string' && ITEM_SOURCES.has(value);
}

export function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function id(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value.slice(0, 64) : randomUUID();
}

export function sanitizeItems(input: unknown): Item[] {
  return (Array.isArray(input) ? input.slice(0, LIMITS.items) : [])
    .filter(isRecord)
    .map((item) => ({
      id: id(item.id),
      text: text(item.text, LIMITS.itemText),
      // 缺省是「启用」：手写一份预设时不该因为漏字段就整块被吞掉
      enabled: item.enabled !== false,
      translation: text(item.translation, LIMITS.translation),
      source: isItemSource(item.source) ? item.source : (remap(LEGACY_ITEM_SOURCES, item.source) ?? ''),
    }));
}

export function sanitizeBlockMeta(block: Record<string, unknown>, fallbackMode: Mode): BlockMeta {
  return {
    id: id(block.id),
    title: text(block.title, LIMITS.title),
    color: text(block.color, LIMITS.color),
    mode: isMode(block.mode) ? block.mode : fallbackMode,
  };
}

/** 把任意输入收敛成一份 Doc；形状不对（比如整个不是对象）返回 null */
export function sanitizeDoc(input: unknown): Doc | null {
  const source = asRecord(input);
  if (source === null) return null;
  const blocks = Array.isArray(source.blocks) ? source.blocks.slice(0, LIMITS.blocks) : [];
  // 风格现在挂在区块上；`input.mode` 是早期"全局风格"版本的字段，留着当老预设/老草稿的兜底
  const legacyMode = isMode(source.mode) ? source.mode : 'tag';
  return {
    version: 1,
    blocks: blocks
      .filter(isRecord)
      .map((block) => ({ ...sanitizeBlockMeta(block, legacyMode), items: sanitizeItems(block.items) })),
  };
}

/** 盘上的草稿 → { structure, items }；老格式（条目直接挂在 block.items 上）也认 */
export function storedFromRaw(raw: unknown): Stored | null {
  const source = asRecord(raw);
  if (source === null) return null;
  const blocks = Array.isArray(source.blocks) ? source.blocks.slice(0, LIMITS.blocks) : [];
  const grouped = asRecord(source.items) ?? {};
  const legacyMode = isMode(source.mode) ? source.mode : 'tag';
  const structure: BlockMeta[] = [];
  const items: Record<string, Item[]> = {};
  for (const block of blocks) {
    const meta = asRecord(block);
    if (meta === null) continue;
    const sanitized = sanitizeBlockMeta(meta, legacyMode);
    structure.push(sanitized);
    items[sanitized.id] = sanitizeItems(Array.isArray(meta.items) ? meta.items : grouped[sanitized.id]);
  }
  return { structure, items };
}

export function rawFromStored(stored: Stored): Raw {
  return { version: 1, blocks: stored.structure, items: stored.items };
}

/** { structure, items } → Doc（GET /draft 回给前端的就是它） */
export function docFromStored(stored: Stored): Doc {
  return {
    version: 1,
    blocks: stored.structure.map((meta) => ({ ...meta, items: stored.items[meta.id] ?? [] })),
  };
}

/** Doc → { structure, items }（整份替换：载入预设 / 清空） */
export function storedFromDoc(doc: Doc): Stored {
  const items: Record<string, Item[]> = {};
  for (const block of doc.blocks) items[block.id] = block.items;
  return { structure: doc.blocks.map(({ items: _items, ...meta }) => meta), items };
}

export function sanitizePreset(input: unknown): Preset | null {
  const source = asRecord(input);
  if (source === null) return null;
  const doc = sanitizeDoc(source.doc);
  if (doc === null) return null;
  return {
    id: id(source.id),
    name: text(source.name, LIMITS.name) || '未命名预设',
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now(),
    doc,
  };
}
