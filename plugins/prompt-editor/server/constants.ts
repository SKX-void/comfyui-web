/**
 * 本插件的固定词汇与文件布局：被多个模块共用，自己谁也不依赖。
 */

export const ID = 'prompt-editor';
/** 空间按**包名**分配，所以这里必须写本插件的包名 */
export const PACKAGE = '@comfyui-web/prompt-editor';

/** 都落在 `ctx.space`（→ data/plugins/<包名>/）里 */
export const PRESETS_FILE = 'presets.json';
/** 区块库：预设的**单块**（标题/颜色/风格/条目文本），见 `routes-block-presets.ts` */
export const BLOCK_PRESETS_FILE = 'block-presets.json';
export const DRAFT_FILE = 'draft.json';
/** 词库（十几万条也扛得住）：SQLite，见 `tagdb.ts` */
export const TAGS_DB_FILE = 'tags.db';
/**
 * 老词库：整文件 JSON。**只当迁移来源** —— 搬进 `tags.db` 后它会被改名成 `tags.json.migrated`，
 * 之后不再读写（留着是给迁移出问题时翻原件）。
 */
export const TAGS_FILE = 'tags.json';
/** 更老的词库：只有 { entries } 平表（en/zh/source），没有分类和别名。同上，`tags.json` 不在时才用它 */
export const LEGACY_DICT_FILE = 'dict.json';
export const SETTINGS_FILE = 'settings.json';
export const USAGE_FILE = 'usage.json';

/** 上限：自用工具也要防「一个坏请求 / 手改坏的文件」把 UI 撑爆 */
export const LIMITS = {
  presets: 300,
  /** 区块库条数（跟预设同一个量级：都是"人手工攒的"，不是导入的） */
  blockPresets: 300,
  name: 120,
  blocks: 200,
  items: 5000,
  itemText: 4000,
  title: 200,
  color: 32,
  translation: 4000,
  category: 24,
  categories: 12,
  aliases: 16,
  /** 一次手动排序最多收多少个 key（面板"加载更多"最多到 1000 条，留点余量） */
  orderKeys: 5000,
};

/** 区块风格：tag = 逗号分隔的标签流 · text = 自然语言句子 */
export type Mode = 'tag' | 'text';
const MODES: ReadonlySet<string> = new Set<Mode>(['tag', 'text']);

/**
 * `MODES.has(x)` 的 TS 版：`Set<string>.has` 不收 `unknown`，而盘上/请求里的值就是 `unknown`。
 * 语义与 `MODES.has(x)` 一致（非字符串本来也命中不了）。
 */
export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && MODES.has(value);
}

/** 兜底色：结构写入还没落地时给区块垫的默认色（与前端调色板第一格一致） */
export const DEFAULT_COLOR = '#6ea8fe';

/**
 * 默认节流间隔（毫秒）：`DEFAULT_SETTINGS` 与 provider 的默认参数都要用。
 * 放这里是为了不让 settings 与 providers 互相 import 成环。
 */
export const MIN_INTERVAL_MS_DEFAULT = 6000;
