/**
 * 文档模型：**区块**（工作区里的视觉容器）→ **条目**（原子单位：编辑 / 禁用 / 翻译都挂在它身上）。
 *
 * 与用户敲定的设计一致的三条约定：
 * 1. 顶层结构**只属于工作区**：输出是拼接后的纯文本，结构不进输出文本；
 *    但保存预设时结构随 JSON 一起存（所以 Doc 是唯一真源，文本是从它推出来的）。
 * 2. 两种风格是**同一份内容的两种切分视图**：tag 按逗号切，自然语言按英文句号切；
 *    切换时把**整块当一份内容**重切（见 `reflow`），块与块之间不合并，也不额外保存第二份内容。
 *    风格开关挂在**每个区块**上（`Block.mode`），没有全局开关 —— 实际写提示词就是混着来的。
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
  /**
   * 译文是哪来的（视觉上要能分出来，因为只有"人认可的"才会进词库）：
   * `''` 没译文或旧数据 · `api` 机器现翻的（**没进词库**）· `dict` 词库命中的 · `user` 手改/存过的
   */
  source: ItemSource;
}

/** 译文来源：`dict` = 在词库里 · `api` = 机器现翻的、还没进库 · `''` = 没有译文/来路不明 */
export type ItemSource = '' | 'api' | 'dict';

export interface Block {
  id: string;
  title: string;
  /** 色板里的一个十六进制色值，用于区分区块 */
  color: string;
  /**
   * **这个区块自己的**风格开关，不是全局的：tag = 逗号串，text = 句子。
   * 放在区块上而不是文档上，因为实际写提示词就是混着来的
   * （质量块用 tag、场景块用自然语言），而区块是工作区里唯一的结构。
   */
  mode: Mode;
  items: Item[];
}

export interface Doc {
  version: 1;
  blocks: Block[];
}

/**
 * 区块的「属性」（不含条目）：草稿在盘上把"组结构"和"条目"分成两段，
 * 结构那一段存的就是它 —— 所以改标题/颜色/风格只需要发这么小一份。
 */
export type BlockMeta = Omit<Block, 'items'>;

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
  return { id: newId(), text, enabled: true, translation: '', source: '' };
}

export function newBlock(title = '新区块', color = BLOCK_COLORS[0]!, mode: Mode = 'tag'): Block {
  return { id: newId(), title, color, mode, items: [] };
}

/** 首屏的三块：只是"能立刻开始写"的起手式，标题和风格随便改 */
export function starterDoc(): Doc {
  return {
    version: 1,
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

/**
 * 重切时**重建内容**用的连接符。
 *
 * 注意它和输出的排版分隔符**不是一回事**：自然语言在输出里是"每句一行"（`\n`），
 * 但重建成一份文本时句子之间应该是空格 —— 原文本本来就是空格分隔的，用 `\n` 拼的话
 * 切到 tag 会把换行带进 tag 里。
 */
const CONTENT_SEPARATOR: Record<Mode, string> = { tag: ', ', text: ' ' };

/**
 * 换模式：把**整块当成一份内容**重切 —— 按旧风格的连接符拼起来，再按新规则切。
 *
 * 这是"同一份内容的两种切分视图"的字面实现，所以**块内已有的条目会真的被重新切一遍**：
 * tag[masterpiece|best quality|8k] 切到自然语言 = 一条 `masterpiece, best quality, 8k`；
 * 再切回 tag 又还原成那三条（拼接用的分隔符和切分规则是对偶的，往返可还原）。
 *
 * 两个例外，都是为了不静默改数据：
 * - **禁用的条目不参与合并，原样留在后面** —— 它本来就不进输出，并进去等于悄悄把它放回输出；
 * - 拼接后切不出任何东西（空块 / 全禁用 / 只有空白条目）→ 原样返回。
 *
 * 重切出来的条目译文一律清空：译文对应的是**整条**文本，重切之后挂在任何一个碎片上都是错的。
 */
export function reflow(items: Item[], from: Mode, to: Mode): Item[] {
  if (from === to) return items;
  const content = items.filter((item) => item.enabled && item.text.trim() !== '');
  const head = content[0];
  if (head === undefined) return items;
  const parts = splitByMode(
    content.map((item) => item.text.trim()).join(CONTENT_SEPARATOR[from]),
    to,
  );
  if (parts.length === 0) return items;
  // 只有一条内容、切完还是它自己 → 什么都没变，连译文都别动
  if (content.length === 1 && parts.length === 1 && parts[0] === head.text) return items;
  const rebuilt: Item[] = parts.map((text, index) =>
    index === 0 ? { id: head.id, text, enabled: true, translation: '', source: '' } : newItem(text),
  );
  return [...rebuilt, ...items.filter((item) => !item.enabled)];
}

// ===========================================================================
// 输出：拼接后的纯文本（结构不进输出）
// ===========================================================================

export function renderOutput(doc: Doc): string {
  return doc.blocks
    .map((block) => {
      // 连接符跟着**区块自己的风格**走：
      // tag 串成一行（逗号分隔）；自然语言**每句一行**（句号已经在条目里，换行只是排版）
      const sep = block.mode === 'tag' ? ', ' : '\n';
      const text = block.items
        .filter((item) => item.enabled && item.text.trim() !== '')
        .map((item) => item.text.trim())
        .join(sep);
      // tag 块的末尾必须带结束符（英文逗号）：块是拿换行拼的，少了它，下一个块/你手接的
      // 东西就跟最后一个 tag 粘成一个（以前得自己在最后一个条目上补个逗号）。本来就有就不补第二个。
      // 自然语言块不补：句号是它自己的结束符。
      if (block.mode !== 'tag' || text === '') return text;
      return text.endsWith(',') ? text : `${text},`;
    })
    .filter((line) => line !== '')
    .join('\n');
}

export function countItems(doc: Doc): number {
  return doc.blocks.reduce((n, block) => n + block.items.length, 0);
}
