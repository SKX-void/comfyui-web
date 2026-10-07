/**
 * 机翻表 CSV 的解析与行构造 —— CLI（`scripts/import-tags.ts`）和面板的「导入内置词库」
 * 路由（`POST /tags/import`）**共用这一份**。
 *
 * 为什么不各写一遍：这份表哪些行该跳过、列名怎么认，是它的**语义**；两处各写一份，
 * 面板导进来的和命令行导进来的迟早不是一个结果。
 *
 * ## 列怎么对
 *
 * `tag,category,count,alias`（这份表是**机翻表**：第 4 列的值本身就是中文译文，表头叫 alias 也当译文读）：
 * - `tag` → 正名（`key` 走 `tagKey` 归一；同键去重留 count 大的那条）
 * - `category` → 数字映射成 `机翻-通用 / 画师 / 作品 / 角色 / 元信息`（见 `tags.ts` 的 `machineCategory`）
 * - `count` → `hot`，面板那一页就是按它排序的（同一批导入的 `updated_at` 相同，排不出先后）
 * - 第 4 列 → 译文
 *
 * 列按表头名字认（认不出表头就按上面这个顺序）；名字不认识时只认位置，不猜。
 *
 * ## 三种行不导入
 *
 * - 没 tag 的（空行、垃圾行）
 * - **没译文的**：命中一条没有译文的词等于白占一次"库"命中，还不如让翻译接口去翻
 * - **译文和正名一样的**：机翻表里没翻出来的占位（真表里 8224 行，5.8%）。
 *   存进去的后果和"没译文"一样，但它非空，光看空值挡不住 —— 所以按 `tagKey` 比一遍。
 */
import { LIMITS } from './constants.js';
import { tagKey } from './prompt.js';
import { machineCategory, type TagListEntry } from './tags.js';

/**
 * 内置资产 `assets/danbooru-zh.csv`（构建时由 `scripts/pack.mjs` 的 extras 拷进产物目录）。
 *
 * `import.meta.url` 在产物里指的就是 `server.js` 自己，所以这里写"跟入口同级的 assets/"：
 * 换成源码的相对路径（`../assets`）在产物里就找不到了 —— 源码在 `plugins/<id>/server/`，
 * 产物在 `tabs/<id>/`，两者层级不一样。
 */
export const BUNDLED_CSV = new URL('./assets/danbooru-zh.csv', import.meta.url);

/** git-lfs 指针文件的第一行。命中 = 这份 CSV 没被 smudge 成真身（clone 时没装 lfs / 跳过了 smudge） */
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

export function looksLikeLfsPointer(text: string): boolean {
  return text.startsWith(LFS_POINTER);
}

/** 表头名 → 我们的列。`alias` 当译文：这份表是机翻表，那一列的值就是中文 */
const COLUMNS: Record<string, string> = {
  tag: 'en',
  name: 'en',
  en: 'en',
  category: 'category',
  cat: 'category',
  count: 'hot',
  hot: 'hot',
  post_count: 'hot',
  posts: 'hot',
  alias: 'zh',
  translate: 'zh',
  translation: 'zh',
  zh: 'zh',
};
const POSITIONAL = ['en', 'category', 'hot', 'zh'];

/**
 * 极简 CSV：够读"字段要么裸着、要么整段被引号包住"的表。
 *
 * 真表里确实有引号字段（48 处），而且**引号里带逗号**：
 * `"my_hero_academia,",6,39259,我的英雄学院`（tag 自己带了个逗号）、
 * `otu_(o2h2_oh4),1,679,"otu (O2H2, Oh4)"`（译文里带逗号）。
 * 按逗号裸切会把这两种行切错列 —— 前者错成一个不存在的 tag，后者错成译文被截断。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 跳过了多少行、按什么列序读的 —— CLI 和面板的"入库报告"都拿它说话 */
export interface TagCsvStats {
  /** 数据行数（不含表头） */
  lines: number;
  /** 实际用的列序，如 `['en','category','hot','zh']` */
  header: string[];
  noTag: number;
  noZh: number;
  /** 译文 == 正名（机翻表里没翻出来的占位） */
  placeholder: number;
  filtered: number;
  /** 同键重复被丢掉的行 */
  duplicates: number;
}

export interface TagCsvResult {
  rows: TagListEntry[];
  stats: TagCsvStats;
}

/**
 * CSV 文本 → 可直接喂 `importEntries` 的行。
 *
 * `minCount` 是 CLI 的旋钮（`--min-count`）：真表最小值是 0、只有 32 行低于 50，
 * 所以面板那条路不传 —— 全量进库，噪音靠 `hot DESC` 排序压下去，不靠删数据。
 */
export function parseTagCsv(text: string, options: { minCount?: number } = {}): TagCsvResult {
  const minCount = options.minCount ?? 0;
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const hasHeader = COLUMNS[(rows[0]?.[0] ?? '').trim().toLowerCase()] === 'en';
  const header = hasHeader ? (rows[0] as string[]).map((cell) => COLUMNS[cell.trim().toLowerCase()] ?? '') : POSITIONAL;
  const data = hasHeader ? rows.slice(1) : rows;

  const stats: TagCsvStats = {
    lines: data.length,
    header,
    noTag: 0,
    noZh: 0,
    placeholder: 0,
    filtered: 0,
    duplicates: 0,
  };

  const byKey = new Map<string, TagListEntry>();
  for (const row of data) {
    const cell = (name: string): string => {
      const index = header.indexOf(name);
      return index < 0 ? '' : ((row[index] ?? '') as string).trim();
    };
    const en = cell('en');
    const key = tagKey(en);
    if (key === '') {
      stats.noTag += 1;
      continue;
    }
    const zh = cell('zh').slice(0, LIMITS.translation);
    if (zh === '') {
      stats.noZh += 1;
      continue;
    }
    if (tagKey(zh) === key) {
      stats.placeholder += 1;
      continue;
    }
    const hot = Math.max(0, Math.floor(Number(cell('hot')) || 0));
    if (hot < minCount) {
      stats.filtered += 1;
      continue;
    }
    const previous = byKey.get(key);
    // 同键留 count 大的那条（表里同一个 tag 出现两次时，热度高的那份更可信）
    if (previous !== undefined) {
      stats.duplicates += 1;
      if (previous.hot >= hot) continue;
    }
    const category = machineCategory(cell('category'));
    byKey.set(key, {
      key,
      en: en.slice(0, LIMITS.itemText),
      zh,
      categories: category === null ? [] : [category],
      aliases: [],
      source: 'import',
      // 0 = "还没被人碰过"：面板排序 `updated_at DESC, hot DESC` 让你改过的永远排在导入的前面
      updatedAt: 0,
      hot,
    });
  }

  return { rows: [...byKey.values()], stats };
}
