/**
 * 词条规则（纯函数）：解析外部词库文件、合并一条写入、面板搜索列。
 *
 * 存储形态是 SQLite（见 `tagdb.ts`）—— 这一层只管"一条词条长什么样"，
 * 脱开数据库就能测（契约测试直接调这里，不碰盘）。
 */
import { LIMITS } from './constants.js';
import { strList, tagKey } from './prompt.js';
import { asRecord, remap } from './util.js';

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

/** 进库的词条一定带正名键（= `tagKey(en)`，查询与别名都按它对齐） */
export interface TagListEntry extends TagEntry {
  key: string;
  /**
   * 热度：外部数据的 post count，自己写的条目是 0。**只用来排序** ——
   * 十几万条导入后面板一页只回 300 条，`updated_at` 是同一批导入时间、排不出先后，
   * 按热度排才能让那一页全是高频词（这也是 WeiLin 的 `ORDER BY hot DESC`）。
   */
  hot: number;
}

/** 面板查询参数：来自 query string，逐个现查 */
export interface TagQuery {
  q?: unknown;
  category?: unknown;
  limit?: unknown;
}

export interface TagQueryResult {
  tags: TagListEntry[];
  /**
   * 命中总数，**最多报到 `limit + 1`**：面板只显示一页，精确值要再全表扫一遍
   * （14 万条实测 22ms → 0.06ms）。`> limit` 就表示"还有更多"。
   */
  total: number;
  counts: { total: number; uncategorized: number };
  categories: { name: string; count: number }[];
}

/**
 * 翻译侧要的词库形状：只要能按 en / 别名查一条。
 * 声明成接口是为了让 `translate.ts` 不认数据库 —— 契约测试塞个假的就能测编排。
 */
export interface TagLookup {
  lookup(text: unknown): TagEntry | null;
}

/**
 * 面板搜索列：正名键 + 小写译文 + 别名键，用换行拼成**一列**。
 *
 * 拼一列是为了让面板那条查询只做一次 LIKE（三个字段分别 LIKE 的话，每行要跑三次匹配
 * 外加一个别名子查询）；换行分隔免得跨字段撞出假命中（搜 `quality` 不该命中译文里的尾巴）。
 */
export function tagSearchBlob(entry: Pick<TagEntry, 'en' | 'zh' | 'aliases'>): string {
  return [tagKey(entry.en), entry.zh.toLowerCase(), ...entry.aliases.map((alias) => tagKey(alias))].join('\n');
}

/** LIKE 的元字符转义（`\` `%` `_`）：不转的话搜一个 `%` 就是全表命中 */
export function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 读外部词库文件（迁移用）：同时吃新版 `{ version:2, entries }`（带 categories/aliases）
 * 和老 `dict.json` 平表（只有 en/zh/source）—— 迁移就是"把老文件过一遍这个函数再写进库"。
 *
 * 返回数组而不是字典：入库是一条条写，键由 `tagKey` 归一（同键的后写覆盖前写，与老行为一致）。
 */
export function sanitizeTags(input: unknown): TagListEntry[] {
  const source = asRecord(input);
  const raw = source === null ? null : asRecord(source.entries);
  if (raw === null) return [];
  const rows = new Map<string, TagListEntry>();
  for (const [key, value] of Object.entries(raw)) {
    const entry = asRecord(value);
    if (entry === null) continue;
    const normalized = tagKey(key);
    const zh = typeof entry.zh === 'string' ? entry.zh.trim().slice(0, LIMITS.translation) : '';
    if (normalized === '' || zh === '') continue;
    const en = typeof entry.en === 'string' && entry.en.trim() !== '' ? entry.en.trim() : key;
    rows.set(normalized, {
      key: normalized,
      en: en.slice(0, LIMITS.itemText),
      zh,
      categories: strList(entry.categories, LIMITS.categories, LIMITS.category) ?? [],
      aliases: strList(entry.aliases, LIMITS.aliases, LIMITS.itemText) ?? [],
      source: isTagSource(entry.source) ? entry.source : (remap(LEGACY_TAG_SOURCES, entry.source) ?? 'import'),
      updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : 0,
      hot: 0,
    });
  }
  return [...rows.values()];
}

/**
 * 合并一条写入：`current` 是库里那条（没有就传 null），返回要落库的词条。
 *
 * **手改的（`source:'user'`）永不被非 user 的写入覆盖** —— 用户改过的就是最终答案，
 * 不然下一次自动译会把他刚改的译文又冲掉。
 *
 * 只给 `en` 时（面板里改分类 / 别名）其余字段沿用原值：局部更新不该把译文抹掉。
 */
export function mergeTag(current: TagListEntry | null, patch: Record<string, unknown>, now: number): TagListEntry | null {
  const en = String(patch?.en ?? patch?.text ?? '').trim();
  const key = tagKey(en);
  if (key === '') return null;
  const asked = typeof patch?.zh === 'string' ? patch.zh : (typeof patch?.translation === 'string' ? patch.translation : '');
  const zh = asked.trim() === '' ? (current?.zh ?? '') : asked.trim();
  if (zh === '') return null;
  // 不给 source 就沿用原值（面板里只改分类时不该把"导入的"提升成"我认可的"），新条目默认 user
  const askedSource = patch?.source;
  const source = isTagSource(askedSource) ? askedSource : (current?.source ?? 'user');
  if (current !== null && current.source === 'user' && source !== 'user') return null;
  return {
    key,
    en: en.slice(0, LIMITS.itemText),
    zh: zh.slice(0, LIMITS.translation),
    categories: strList(patch?.categories, LIMITS.categories, LIMITS.category) ?? current?.categories ?? [],
    aliases: strList(patch?.aliases, LIMITS.aliases, LIMITS.itemText) ?? current?.aliases ?? [],
    source,
    updatedAt: now,
    // 手改不动热度：热度是导入带来的元数据，面板里改个译文不该把它清零
    hot: current?.hot ?? 0,
  };
}

/**
 * 外部数据的分类数字 → 中文分类名，**带 `机翻-` 前缀**。
 *
 * 数字是 danbooru 的 category（0 general · 1 artist · 3 copyright · 4 character · 5 meta）。
 * 不直接当分类名用：它会跟"画质 / 光照"这类**写作分类**挤在同一棵树上。加前缀有两个好处 ——
 * 一眼看出是机器带来的，而且整组 `机翻-*` 就是一个"待整理收件箱"：你改完译文、换成自己的分类，
 * 它自然就离开这一组了。
 *
 * 空值返回 null（落进"未分类"，面板本来就有这个筛选）；认不出的数字归"其他"。
 */
const MACHINE_CATEGORY_NAMES: Record<string, string> = {
  '0': '通用',
  '1': '画师',
  '3': '作品',
  '4': '角色',
  '5': '元信息',
};

export function machineCategory(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  return `机翻-${MACHINE_CATEGORY_NAMES[raw] ?? '其他'}`;
}
