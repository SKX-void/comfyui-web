/**
 * 文档模型：**区块**（工作区里的视觉容器）→ **条目**（原子单位：编辑 / 禁用 / 翻译都挂在它身上）。
 *
 * 与用户敲定的设计一致的三条约定：
 * 1. 顶层结构**只属于工作区**：输出是拼接后的纯文本，结构不进输出文本；
 *    但保存预设时结构随 JSON 一起存（所以 Doc 是唯一真源，文本是从它推出来的）。
 * 2. 两种风格是**同一份内容的两种切分视图**：tag 按逗号切，自然语言按英文句号切；
 *    切换时重切，不额外保存第二份内容。
 * 3. 条目提交（新建 / 编辑 / 粘贴）一律按当前模式的规则重切：
 *    在 tag 模式下粘贴 `a, b, c` 会变成三个块，自然语言模式下同理按句号断句。
 */

export type Mode = 'tag' | 'text';

export interface Item {
  id: string;
  text: string;
  /** 双击禁用：条目留在文档里但不进输出（WeiLin 的 isHidden） */
  enabled: boolean;
  /** 翻译位（下一步接入数据源）：这里只存结果，空串 = 没翻译 */
  translation: string;
}

export interface Block {
  id: string;
  title: string;
  /** 色板里的一个十六进制色值，用于区分区块 */
  color: string;
  items: Item[];
}

export interface Doc {
  version: 1;
  mode: Mode;
  blocks: Block[];
}

export const MODE_LABEL: Record<Mode, string> = { tag: 'tag', text: '自然语言' };

/** 区块色板：够区分即可，不做取色器 */
export const BLOCK_COLORS = [
  '#6ea8fe',
  '#4ac38a',
  '#f2b84b',
  '#ff7b72',
  '#c792ea',
  '#4dd0e1',
  '#f48fb1',
  '#9aa3b2',
];

/**
 * 条目 / 区块的 id。
 *
 * **不能直接用 `crypto.randomUUID()`**：它和 `crypto.subtle` 一样只在**安全上下文**
 * （https / localhost）里存在，而本插件经常就是局域网 http 打开的（`http://10.x.x.x:5180`）——
 * 那里它是 `undefined`，页面会在首屏渲染时直接炸掉。
 * `crypto.getRandomValues()` 没有这条限制，所以自己拼一个 v4 UUID；
 * 连它都没有（极老环境）才退回 `Math.random` —— id 只需要在本机文档内唯一。
 */
export function newId(): string {
  const bytes = new Uint8Array(16);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newItem(text = ''): Item {
  return { id: newId(), text, enabled: true, translation: '' };
}

export function newBlock(title = '新区块', color = BLOCK_COLORS[0]!): Block {
  return { id: newId(), title, color, items: [] };
}

/** 首屏的三块：只是"能立刻开始写"的起手式，标题随便改 */
export function starterDoc(): Doc {
  return {
    version: 1,
    mode: 'tag',
    blocks: [newBlock('质量', BLOCK_COLORS[0]!), newBlock('主体', BLOCK_COLORS[1]!), newBlock('场景', BLOCK_COLORS[2]!)],
  };
}

/** 深拷贝：只为了喂给 fetch 与结构化克隆无关，JSON 往返对我们这种纯数据足够 */
export function cloneDoc(doc: Doc): Doc {
  return JSON.parse(JSON.stringify(doc)) as Doc;
}

// ===========================================================================
// 切分：两种模式各一条规则
// ===========================================================================

/**
 * tag 切分：只在**括号深度 0** 的逗号处切，`(a, b:1.2)` 是一个块。
 * 转义 `\,` 连下一个字符一起吃进当前段（与 anima-plus 的提示词整理同款规则）。
 */
export function splitTags(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      buf += ch + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 自然语言切分：在**英文句号**处断句，句号留在前一句里。
 * 只认「句号 + 空白 / 结尾」，所以 `1.5`、`v1.2` 这类不会被切开；
 * `e.g.` 这种缩写会被当成句尾 —— 图像提示词里几乎不出现，不为它加特例。
 */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    buf += ch;
    const next = text[i + 1];
    if (ch === '.' && (next === undefined || /\s/.test(next))) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf !== '') parts.push(buf);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

export function splitByMode(text: string, mode: Mode): string[] {
  return mode === 'tag' ? splitTags(text) : splitSentences(text);
}

/** 条目拼回文本：tag 用逗号，自然语言用空格（句号已经在条目里了） */
export function joinItems(items: Item[], mode: Mode): string {
  const sep = mode === 'tag' ? ', ' : ' ';
  return items
    .map((item) => item.text.trim())
    .filter((text) => text !== '')
    .join(sep);
}

/**
 * 换模式：先按旧规则拼回文本，再按新规则重切。
 * 只有**整串仍然相等**的条目能继承禁用态与译文 —— 切分粒度变了，别的本来也对不上。
 */
export function reflow(items: Item[], from: Mode, to: Mode): Item[] {
  if (from === to) return items;
  const parts = splitByMode(joinItems(items, from), to);
  const previous = new Map<string, Item>();
  for (const item of items) if (!previous.has(item.text)) previous.set(item.text, item);
  return parts.map((text) => {
    const old = previous.get(text);
    return old ? { ...old, text } : newItem(text);
  });
}

// ===========================================================================
// 输出：拼接后的纯文本（结构不进输出）
// ===========================================================================

export function renderOutput(doc: Doc): string {
  const sep = doc.mode === 'tag' ? ', ' : ' ';
  return doc.blocks
    .map((block) =>
      block.items
        .filter((item) => item.enabled && item.text.trim() !== '')
        .map((item) => item.text.trim())
        .join(sep),
    )
    .filter((line) => line !== '')
    .join('\n');
}

export function countItems(doc: Doc): number {
  return doc.blocks.reduce((n, block) => n + block.items.length, 0);
}
