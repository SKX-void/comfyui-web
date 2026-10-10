/**
 * 外部词库文件的解析与行构造 —— CLI（`scripts/import-tags.ts`）和面板的「导入内置词库」
 * 路由（`POST /tags/import`）**共用这一份**。
 *
 * 为什么不各写一遍：这份表哪些行该跳过、列名怎么认，是它的**语义**；两处各写一份，
 * 面板导进来的和命令行导进来的迟早不是一个结果。
 *
 * ## 列怎么对
 *
 * `tag,category,count,zh[,group,sub][,source]`（词库表：第 4 列的值本身就是中文译文，表头叫 alias 也当译文读）：
 * - `tag` → 正名（`key` 走 `tagKey` 归一 + 下划线折成空格，见 `foldUnderscore`；同键去重留 count 大的那条）
 * - `category` → 数字映射成 `机翻-通用 / 画师 / 作品 / 角色 / 元信息`（见 `tags.ts` 的 `machineCategory`）
 * - `count` → `hot`，面板那一页就是按它排序的（同一批导入的 `updated_at` 相同，排不出先后）
 * - 第 4 列 → 译文
 * - `group` / `sub` → 人工分类的两级（大类 / 小类，见下）。老表没有这两列，认不出就当没有
 * - `source` → 这批行算什么来源（`user` / `import` / `builtin`，见 `tags.ts`）。没这列时用
 *   `options.defaultSource`（CLI `--source` 传，默认 `import`）
 *
 * 列按表头名字认（认不出表头就按 `POSITIONAL` 那个顺序）；名字不认识时只认位置，不猜。
 *
 * ## 人工译文压过机翻（`builtin` 那一层）
 *
 * 机翻表（`source='import'`）和人工表（`source='builtin'`）是**两份文件**，各自可以单独重导。
 * 谁压过谁不靠导入顺序，靠 `tagdb.ts` 的导入守卫：**已入库的 `user` / `builtin` 行不许被覆盖**
 * —— 于是「重导内置机翻表」不会把人工译文冲掉（见 `insertTagSql` 的 `guard`）。
 * 同一个文件内部撞键（同一 tag 写两遍）时，非 `import` 的那条优先，其次才比 `hot`。
 *
 * ## 分类两级，以及"人工分类压掉机翻桶"
 *
 * `group` / `sub` 来自词库包里那份人工分类表（它正好覆盖机翻表的 `category=0` 那批通用词）：
 * 52,514 个词被切进 4 个大类 / 22 个小类。**分类的父子关系不是词条上的字段** —— 它是分类自己
 * 的属性（`categories.parent`），所以这里只回一张 `parents` 映射（小类 → 大类），由导入层落库。
 *
 * 有 `group` 的词条**不再挂 `机翻-通用`**：那个桶的语义是"还没被整理的通用词"（见 `machineCategory`
 * 的注释），而这批词已经被人工分类整理过了，再挂在收件箱里就是两份互相矛盾的分类。
 *
 * ## 三种行不导入（占位那条可关）
 *
 * - 没 tag 的（空行、垃圾行）
 * - **没译文的**：命中一条没有译文的词等于白占一次"库"命中，还不如让翻译接口去翻
 * - **译文和正名一样的**：机翻表里没翻出来的占位（老表 8,224 行 5.8%；新表 77,237 行 23.8%，
 *   其中 94.8% 是 `hololive`、`fate/grand order` 这类**专有名词**——本来就不该翻）。
 *   存进去的后果和"没译文"一样，但它非空，光看空值挡不住 —— 所以按 `tagKey` 比一遍。
 *
 * `keepPlaceholders: true` 就留下这批（译文照存正名）：专有名词"命中即原文"比让机翻去翻它更对，
 * 而且这样 7.7 万个词在面板里**搜得到**。默认关着 —— CLI 显式加 `--keep-placeholders`，
 * 面板的「导入内置词库」开着（那份产物是我们自己造的，规则明确）。
 */
import { LIMITS } from './constants.js';
import { tagKey } from './prompt.js';
import { isTagSource, machineCategory, type TagListEntry, type TagSource } from './tags.js';

/**
 * 内置资产 `assets/danbooru-zh.csv`（构建时由 `scripts/pack.mjs` 的 extras 拷进产物目录）。
 *
 * `import.meta.url` 在产物里指的就是 `server.js` 自己，所以这里写"跟入口同级的 assets/"：
 * 换成源码的相对路径（`../assets`）在产物里就找不到了 —— 源码在 `plugins/<id>/server/`，
 * 产物在 `tabs/<id>/`，两者层级不一样。
 */
export const BUNDLED_CSV = new URL('./assets/danbooru-zh.csv', import.meta.url);

/**
 * 内置的共现邻居表（`assets/cooccur.tsv`，同样是 `pack.mjs` 的 extras 拷进产物的）。
 * 格式：`词<TAB>邻居|邻居|…`，按共现强度从强到弱。
 */
export const BUNDLED_COOC = new URL('./assets/cooccur.tsv', import.meta.url);

/**
 * 内置的**人工**词表（`assets/weilin-zh.csv`）：WeiLin 那份人工译文（MIT，见 README 的出处一节），
 * 4 千条，带两级分类。它进库时写 `source='builtin'` —— 比机翻高一层，重导机翻表盖不掉它。
 */
export const BUNDLED_BUILTIN = new URL('./assets/weilin-zh.csv', import.meta.url);

/** git-lfs 指针文件的第一行。命中 = 这份 CSV 没被 smudge 成真身（clone 时没装 lfs / 跳过了 smudge） */
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

export function looksLikeLfsPointer(text: string): boolean {
  return text.startsWith(LFS_POINTER);
}

/** 表头名 → 我们的列。`alias` 当译文：这份表是词库表，那一列的值就是中文 */
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
  group: 'group',
  parent: 'group',
  sub: 'sub',
  subgroup: 'sub',
  subcategory: 'sub',
  source: 'source',
  from: 'source',
};
const POSITIONAL = ['en', 'category', 'hot', 'zh'];

/**
 * 下划线 → 空格（顺带把连续空白收成一个、去掉首尾）。booru 那一套（Danbooru 官方名、WeiLin 的库）
 * 把名字里的空格写成 `_`，我们的表是空格形（`long hair`）—— 不折的话同一个词会变成两行
 * （`long_hair` / `long hair`），人工译文就压不到机翻那条上。
 *
 * **一律折，不做"夹在字母之间才折"的例外**：机翻表本身就是整表折过的（32 万条里 0 条下划线、
 * 22.9 万条带空格），带例外的折法会把 `hanten_(clothes)`、`robot_` 这种留成下划线形，
 * 于是它们跟机翻表的 `hanten (clothes)` 永远对不上。颜文字（`^_^`）折了也还是能查到的
 * —— 正名和键两边都过这一道，写法始终一致。
 */
export function foldUnderscore(input: string): string {
  return input.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 同一份文件里撞键时谁赢：`import`（机翻）垫底，人工写的（`builtin` / `user`）压过它 */
function sourceRank(source: string): number {
  return source === 'import' ? 0 : 1;
}

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
  /** 译文 == 正名（词库里没翻出来的占位）。`keepPlaceholders` 关着时这些行被丢掉，开着时照收 */
  placeholder: number;
  /** 带人工分类（`group` 列非空）的行数 */
  grouped: number;
  /** 按 `source` 分组统计（`{ import: 324470 }` / `{ builtin: 4087 }`）—— 报告里要能看出这批是什么 */
  sources: Record<string, number>;
  filtered: number;
  /** 同键重复被丢掉的行 */
  duplicates: number;
}

export interface TagCsvResult {
  rows: TagListEntry[];
  stats: TagCsvStats;
  /** 分类的父子关系（小类名 → 大类名）。分类的属性，不是词条的字段 —— 落库交给 `importEntries` */
  parents: Map<string, string>;
}

/**
 * CSV 文本 → 可直接喂 `importEntries` 的行。
 *
 * `minCount` 是 CLI 的旋钮（`--min-count`）：真表最小值是 0、只有 32 行低于 50，
 * 所以面板那条路不传 —— 全量进库，噪音靠 `hot DESC` 排序压下去，不靠删数据。
 */
export function parseTagCsv(
  text: string,
  options: { minCount?: number; keepPlaceholders?: boolean; defaultSource?: TagSource } = {},
): TagCsvResult {
  const minCount = options.minCount ?? 0;
  const keepPlaceholders = options.keepPlaceholders ?? false;
  const defaultSource = options.defaultSource ?? 'import';
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
    grouped: 0,
    sources: {},
    filtered: 0,
    duplicates: 0,
  };

  const parents = new Map<string, string>();
  const byKey = new Map<string, TagListEntry>();
  for (const row of data) {
    const cell = (name: string): string => {
      const index = header.indexOf(name);
      return index < 0 ? '' : ((row[index] ?? '') as string).trim();
    };
    // 下划线折成空格（`long_hair` → `long hair`）：正名和键都折，两个来源才落在同一行上
    const en = foldUnderscore(cell('en'));
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
    const placeholder = tagKey(zh) === key;
    if (placeholder) stats.placeholder += 1;
    // 占位行开着 `keepPlaceholders` 时照收：译文就用正名（专有名词"命中即原文"）
    if (placeholder && !keepPlaceholders) continue;
    const hot = Math.max(0, Math.floor(Number(cell('hot')) || 0));
    if (hot < minCount) {
      stats.filtered += 1;
      continue;
    }
    // 人工分类：大类 + 小类。小类的父是大类 —— 词条本身只记名字，父子关系回 `parents`
    const group = cell('group').slice(0, LIMITS.category);
    const rawSub = cell('sub').slice(0, LIMITS.category);
    // 小类跟大类同名 = "这一大类里还没细分"（WeiLin 那份里 `镜头` 就是这样：大类叫镜头，底下还有个
    // 也叫镜头的小类）。留着它就成了"自己是自己的父"—— 两级树里那一支再也回不到顶级（真踩过：
    // 面板左栏少了整个「镜头」）。当没细分处理，跟 `未分类` 那条规则同一个意思。
    const sub = rawSub === group ? '' : rawSub;
    if (group !== '' || sub !== '') stats.grouped += 1;
    if (group !== '' && sub !== '') parents.set(sub, group);
    const categories = [group, sub].filter((one) => one !== '');
    // 有分类时不再挂机翻桶：`机翻-通用` 是"还没整理"的意思，整理过的不该同时挂在收件箱里
    const machine = categories.length === 0 ? machineCategory(cell('category')) : null;
    const rawSource = cell('source').toLowerCase();
    const source: TagSource = isTagSource(rawSource) ? rawSource : defaultSource;
    stats.sources[source] = (stats.sources[source] ?? 0) + 1;
    const previous = byKey.get(key);
    // 同键撞车：非 `import` 的那条先赢（人工写的一条压过机翻），同级别才比热度
    if (previous !== undefined) {
      stats.duplicates += 1;
      const before = sourceRank(previous.source);
      const now = sourceRank(source);
      if (before > now || (before === now && previous.hot >= hot)) continue;
    }
    byKey.set(key, {
      key,
      en: en.slice(0, LIMITS.itemText),
      zh,
      categories: machine === null ? categories : [machine],
      aliases: [],
      source,
      // 0 = "还没被人碰过"：面板排序 `updated_at DESC, hot DESC` 让你改过的永远排在导入的前面
      updatedAt: 0,
      hot,
    });
  }

  return { rows: [...byKey.values()], stats, parents };
}

/**
 * 共现邻居表（`词<TAB>邻居|邻居|…`）→ 可直接喂 `importCooccur` 的行。
 *
 * 只做切分和归一：**不在这里过滤"邻居是否在词库里"** —— 那是查询时的 INNER JOIN 的事，
 * 导入就不必关心词库和邻居表谁先落库。
 */
export function parseCooccurTsv(text: string): { rows: [string, string, number][]; stats: { lines: number; kept: number } } {
  const rows: [string, string, number][] = [];
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    const [word = '', neighbors = ''] = line.split('\t');
    const key = tagKey(word);
    if (key === '') continue;
    let rank = 0;
    const seen = new Set<string>();
    for (const neighbor of neighbors.split('|')) {
      const neighborKey = tagKey(neighbor);
      // 自己配自己没意义，同一个邻居写两遍也只留第一次（序号按留下来的那份数）
      if (neighborKey === '' || neighborKey === key || seen.has(neighborKey)) continue;
      seen.add(neighborKey);
      rank += 1;
      rows.push([key, neighborKey, rank]);
    }
  }
  return { rows, stats: { lines, kept: rows.length } };
}
