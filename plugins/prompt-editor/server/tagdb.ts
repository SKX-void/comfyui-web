/**
 * 词库的 SQLite 存储（`tags.db`）：**一张表两用** —— 翻译按 `key` / 别名命中，面板按 `tag_categories` 分组。
 *
 * ## 为什么是 SQLite、为什么不用 FTS5
 *
 * 词库要装外部导入的十几万条（官方 danbooru 数据 14 万条），整文件 JSON 在这个量级上
 * 每次写都要重写整份（14 万条实测 387ms/次，还全是同步 IO，堵的是整个宿主的事件循环）。
 *
 * 面板搜索用 `LIKE '%词%'` 全表扫，**不上 FTS5**：中文子串在 SQLite 自带的分词器里没有能用的那个
 * —— `unicode61` 把一整串中文当成一个 token（只有前缀能命中），`trigram` 只认 3 个字符以上
 * （1~2 字的中文查不到），而 node:sqlite 没有注册自定义分词器的入口。
 *
 * 全表扫的实测（14 万条，见 `scripts/scale-bench.ts`）：命中一堆的查询 0.5ms（列表提前收尾 +
 * 总数封顶），**一条都不命中的 50~70ms** —— 那是一次完整的全表扫，`ORDER BY` 走索引也救不了
 * 它（`EXPLAIN QUERY PLAN` 就是 `SCAN t`；给 `search` 建覆盖索引实测没用，白搭 10MB 和写放大）。
 * 这个量级够用：面板有 250ms 防抖，一次按键最多一次查询，WeiLin 的 danbooru 库也是这么扫的。
 *
 * ## 连接寿命
 *
 * 打开一次、用到底（宿主是单进程单事件循环，同步 API 不会被打断）。收尾由 `routes.ts` 的
 * `ctx.effect` 负责关 —— 重挂 = 新闭包（D20），不关就是句柄 + WAL 文件泄漏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { tagKey } from './prompt.js';
import { readJson } from './store.js';
import {
  escapeLike,
  mergeTag,
  sanitizeTags,
  tagSearchBlob,
  type TagListEntry,
  type TagLookup,
  type TagQuery,
  type TagQueryResult,
} from './tags.js';
import { clampInt } from './util.js';

/**
 * 分类 / 别名在一行里怎么拼回来：`GROUP_CONCAT` 的分隔符用一个正文里不可能出现的控制字符
 * （用逗号的话，分类名里带逗号就会被拆成两个）。
 */
const SEP = '\u001f';
const SEP_SQL = 'char(31)';

/**
 * 面板每一行要的东西。分类 / 别名走相关子查询而不是 JOIN：JOIN 两张一对多的表会按行数乘起来，
 * 还得在 JS 里重新分组；子查询每行只回一个字符串。
 */
const ROW_COLUMNS = `t.key, t.en, t.zh, t.source, t.hot, t.updated_at,
  (SELECT GROUP_CONCAT(c.name, ${SEP_SQL}) FROM tag_categories c WHERE c.tag_key = t.key) AS categories,
  (SELECT GROUP_CONCAT(a.alias, ${SEP_SQL}) FROM tag_aliases a WHERE a.tag_key = t.key) AS aliases`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tags (
     key TEXT PRIMARY KEY,
     en TEXT NOT NULL,
     zh TEXT NOT NULL,
     source TEXT NOT NULL,
     hot INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     search TEXT NOT NULL
   )`,
  // 面板的排序是"最近改的在前，其余按热度"：这条索引让无搜索的首屏变成一次索引扫描，
  // 不建的话十几万条要全表排序（14 万条实测 132ms → 0.4ms）；带搜索时也靠它按序走、
  // 凑够一页就收（命中一堆的查询实测 0.5ms）。
  // 旧的 `(updated_at, key)` 索引在 hot 列加进来后就不够用了，每次开库顺手丢掉。
  'DROP INDEX IF EXISTS idx_tags_updated',
  'CREATE INDEX IF NOT EXISTS idx_tags_rank ON tags(updated_at DESC, hot DESC, key ASC)',
  `CREATE TABLE IF NOT EXISTS tag_categories (
     tag_key TEXT NOT NULL,
     name TEXT NOT NULL,
     PRIMARY KEY (tag_key, name)
   )`,
  // 分类树那条 GROUP BY 靠它做索引扫描（否则每次开面板都要建临时表排序）
  'CREATE INDEX IF NOT EXISTS idx_tag_categories_name ON tag_categories(name)',
  // 分类本身也是一张表：`tag_categories` 只记"谁属于谁"，光靠它就没法存在**还没有词用的空分类**
  // （新建一个立刻消失）。这张表只存名字，计数仍然从 `tag_categories` 现算 —— 两边都留一份计数
  // 就得同步，而同步一定会漂。写入时顺手注册（见 writeEntry），老库开库时把在用的名字补进来。
  `CREATE TABLE IF NOT EXISTS categories (
     name TEXT PRIMARY KEY
   )`,
  `CREATE TABLE IF NOT EXISTS tag_aliases (
     tag_key TEXT NOT NULL,
     alias_key TEXT NOT NULL,
     alias TEXT NOT NULL,
     PRIMARY KEY (tag_key, alias_key)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_tag_aliases_key ON tag_aliases(alias_key)',
];

/**
 * 手动排序（面板里拖出来的顺序）用的排序索引。
 *
 * **这条是必须的，不是调优**：`ORDER BY (sort IS NULL), sort, updated_at DESC, hot DESC, key`
 * 跟 `idx_tags_rank` 的列对不上，没它 SQLite 就退化成"全表扫 + 临时 B 树排序"
 * —— 14 万条实测 **0.2ms → 22.9ms**。表达式索引要跟 ORDER BY 里的表达式**逐字对应**才用得上。
 */
const RANK2_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_tags_rank2 ON tags((sort IS NULL), sort ASC, updated_at DESC, hot DESC, key ASC)';

/**
 * 手动顺序的间隔：铺序号时按 `index * SPACING` 写，新插入的取左右邻居的**中点**。
 *
 * 所以拖一下只写 1 行（不是重写整页）。中点会把缝对半切，同一个缝切 ~50 次（double 的
 * 尾数位数）就切不出严格居中的值了 —— 那时退回"整页重铺"（见 `setOrder`）。
 */
const SPACING = 1000;

/** 一次手动排序的结果：`rebuilt` = 序号用尽 / 还没铺过，整页重铺了间隔 */
export interface OrderResult {
  written: number;
  rebuilt: boolean;
}

interface TagRow {  key: string;
  en: string;
  zh: string;
  source: string;
  hot: number;
  updated_at: number;
  categories: string | null;
  aliases: string | null;
}

const splitJoined = (joined: string | null): string[] => (joined === null || joined === '' ? [] : joined.split(SEP));

const toEntry = (row: TagRow): TagListEntry => ({
  key: row.key,
  en: row.en,
  zh: row.zh,
  source: row.source,
  hot: Number(row.hot),
  updatedAt: Number(row.updated_at),
  categories: splitJoined(row.categories),
  aliases: splitJoined(row.aliases),
});

export interface TagDbOptions {
  /** `tags.db` 的绝对路径 */
  db: string;
  /** 迁移来源：新版 `tags.json`（在就先读它） */
  tagsJson: string;
  /** 迁移来源：老 `dict.json` 平表（只有 en/zh/source） */
  legacyDictJson: string;
}

export interface TagDb extends TagLookup {
  /** 比 `TagLookup` 的契约更宽：库里查到的就是整行（面板 / 脚本要 `hot` / `updatedAt`） */
  lookup(text: unknown): TagListEntry | null;
  upsert(patch: Record<string, unknown>, now?: number): TagListEntry | null;
  remove(en: unknown): boolean;
  query(options?: TagQuery): TagQueryResult;
  count(): number;
  /** 手动排序：把 `moved` 挪到 `keys` 里的位置；`rebuilt` = 序号用尽、整页重铺了 */
  setOrder(keys: string[], moved?: string | null): OrderResult;
  /** 新建分类（只加名字，不动词）；返回是否真的新建了（重名 = false） */
  createCategory(name: string): boolean;
  /** 删掉分类**连它下面的归属**；返回受影响的词条数（`tags` 一条都不删） */
  removeCategory(name: string): number;
  /** 重命名分类（两张表一起改）；`-1` = 目标名字已经存在（不合并） */
  renameCategory(from: string, to: string): number;
  /** 批量入库（导入 / 迁移用）：一个事务写完，十几万条也就秒级；返回真正入库的条数（跳过 `user` 行） */
  importEntries(rows: TagListEntry[]): number;
  close(): void;
}

/**
 * 写 tags 行。`guardUser` 是**导入路径**专用的：已经进过库、而且是 `user` 的行整条跳过
 * （`DO UPDATE ... WHERE`）—— 导入十几万条时，你手改过的那几条不该被同一批数据冲回去。
 * 面板自己的写入当然不带这个条件（不然就改不动了）。
 */
const insertTagSql = (guardUser: boolean): string => `INSERT INTO tags (key, en, zh, source, hot, updated_at, search)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET en = excluded.en, zh = excluded.zh, source = excluded.source,
    hot = excluded.hot, updated_at = excluded.updated_at, search = excluded.search${
      guardUser ? " WHERE tags.source <> 'user'" : ''
    }`;

export function openTagDb(options: TagDbOptions): TagDb {
  // 目录可能被人手动删掉（docs/config.md 把"删掉＝回到默认"写成用法）：SQLite 不会替你建目录
  fs.mkdirSync(path.dirname(options.db), { recursive: true });
  const db = new DatabaseSync(options.db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // 这条是**必须**的，不是调优：本环境 /var/tmp 存在但不可写，SQLite 挑临时目录时会落到它头上，
  // 数据一大、排序 / 分组一溢出到磁盘就是 SQLITE_CANTOPEN（14 万条时必现）。
  db.exec('PRAGMA temp_store = MEMORY');
  for (const sql of SCHEMA) db.exec(sql);

  // `sort` 是后加的列：老库靠 `CREATE TABLE IF NOT EXISTS` 补不上，得自己探一下再 ALTER。
  // **顺序要紧**：先把列和类型弄对再建索引，否则建索引那条会报 no such column: sort。
  const sortColumn = (db.prepare('PRAGMA table_info(tags)').all() as { name: string; type: string }[]).find(
    (one) => one.name === 'sort',
  );
  if (sortColumn === undefined) {
    db.exec('ALTER TABLE tags ADD COLUMN sort REAL');
  } else if (sortColumn.type.toUpperCase() !== 'REAL') {
    // 早先落过 INTEGER（整页重编号那版）。整数列也能存 1.5，但类型名会说谎，
    // 而 SQLite 改不了列类型 —— 只能重建这一列：先把已排的值抄下来，再写回去。
    // DDL 也在事务里，要么全成要么全不成（你拖出来的顺序不能丢）。
    db.exec('BEGIN');
    try {
      const kept = db.prepare('SELECT key, sort FROM tags WHERE sort IS NOT NULL').all() as {
        key: string;
        sort: number;
      }[];
      const put = db.prepare('UPDATE tags SET sort = ? WHERE key = ?');
      db.exec('DROP INDEX IF EXISTS idx_tags_rank2');
      db.exec('ALTER TABLE tags DROP COLUMN sort');
      db.exec('ALTER TABLE tags ADD COLUMN sort REAL');
      for (const row of kept) put.run(row.sort, row.key);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.exec(RANK2_INDEX);

  // 老库的分类只存在于 `tag_categories` 里，`categories` 是空的 —— 把在用的名字补进去。
  // `UNION` 而不是只查 `tag_categories`：手工 SQL 造出来的孤儿名字也得认。
  db.exec('INSERT OR IGNORE INTO categories (name) SELECT name FROM tag_categories');

  // 语句按 SQL 文本缓存：形状只有固定几种（面板查询 q × category 的组合），
  // 每次请求重新 prepare 是白花钱
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let prepared = cache.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql);
      cache.set(sql, prepared);
    }
    return prepared;
  };

  const one = (sql: string, ...params: (string | number)[]): number => {
    const row = stmt(sql).get(...params) as Record<string, unknown> | undefined;
    return Number(row?.c ?? 0);
  };

  /**
   * 全局计数（面板头部"共 N 条 · 未分类 M" + 分类树）与搜索条件无关，**只有写才变** ——
   * 缓存它，面板里连续输入就只剩那条列表查询。14 万条实测：两条计数查询 26ms，缓存后 0。
   *
   * 缓存要能自己发现**别的进程**写过库（`scripts/import-tags.ts` 灌十几万条时宿主正跑着）：
   * `PRAGMA data_version` 只在别的连接提交后才变，本连接自己写它不动（我们自己会置 null）。
   */
  let statsCache: { counts: TagQueryResult['counts']; categories: TagQueryResult['categories'] } | null = null;
  let statsVersion = -1;
  const stats = (): NonNullable<typeof statsCache> => {
    const version = Number(
      (stmt('PRAGMA data_version').get() as { data_version?: number } | undefined)?.data_version ?? 0,
    );
    if (statsCache !== null && version === statsVersion) return statsCache;
    const total = one('SELECT COUNT(*) AS c FROM tags');
    // 没分类的 = 总数 - 在 tag_categories 里出现过的（主键前半段就是 tag_key，COUNT DISTINCT 走索引）
    const categorized = one('SELECT COUNT(DISTINCT tag_key) AS c FROM tag_categories');
    // 分类树 = `categories`（含空分类）并上 `tag_categories` 里出现过的名字（防手工 SQL 造出的孤儿）。
    // 计数现算：`idx_tag_categories_name` 让 LEFT JOIN 走索引，几个名字的规模实测 ~1ms。
    const rows = stmt(
      `SELECT x.name AS name, COUNT(tc.tag_key) AS c
         FROM (SELECT name FROM categories UNION SELECT name FROM tag_categories) AS x
         LEFT JOIN tag_categories tc ON tc.name = x.name
        GROUP BY x.name
        ORDER BY c DESC, x.name ASC`,
    ).all() as unknown as { name: string; c: number }[];
    statsVersion = version;
    statsCache = {
      counts: { total, uncategorized: total - categorized },
      categories: rows.map((row) => ({ name: row.name, count: Number(row.c) })),
    };
    return statsCache;
  };

  const readByKey = (key: string): TagListEntry | null => {
    const row = stmt(`SELECT ${ROW_COLUMNS} FROM tags t WHERE t.key = ?`).get(key) as unknown as TagRow | undefined;
    return row === undefined ? null : toEntry(row);
  };

  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  /**
   * 新建分类：只往 `categories` 里放个名字，**一条词都不动** —— 这样"先建分类、再往里放词"才走得通。
   * 重名不当错误（`INSERT OR IGNORE`）：面板上再点一次「新建」不该报错，只是什么也没发生。
   */
  const createCategory = (name: string): boolean => {
    statsCache = null;
    return Number(stmt('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name).changes) > 0;
  };

  /**
   * 删掉一个分类：**连它下面的归属一起删**（`tag_categories` 里那些行），所以是批量破坏性操作 ——
   * 面板会先把影响多少条摆给人看再确认。词条本身（`tags`）一条都不删，它们只是变回未分类。
   */
  const removeCategory = (name: string): number =>
    transaction(() => {
      statsCache = null;
      const members = Number(stmt('DELETE FROM tag_categories WHERE name = ?').run(name).changes);
      stmt('DELETE FROM categories WHERE name = ?').run(name);
      return members;
    });

  /**
   * 重命名：两张表一起改（`categories` 里那一行 + 所有归属行）。
   *
   * **撞名不合并**：目标名字已经存在时直接返回 `-1` 让调用方报错。合并两个分类是不可逆的
   * （合完就分不出来了），而"打错了字"这种情况重打一次就行 —— 不值得为它引入一个说不清的操作。
   */
  const renameCategory = (from: string, to: string): number => {
    const taken = stmt('SELECT 1 AS x FROM categories WHERE name = ?').get(to) !== undefined;
    if (taken) return -1;
    return transaction(() => {
      statsCache = null;
      stmt('UPDATE categories SET name = ? WHERE name = ?').run(to, from);
      return Number(stmt('UPDATE tag_categories SET name = ? WHERE name = ?').run(to, from).changes);
    });
  };

  /**
   * 手动排序：把 `moved` 这一条挪到 `keys` 里它现在所在的位置上（`keys` 是当前这一页的新顺序）。
   *
   * **取左右邻居的中点，只写 1 行**；两种情况退回"整页重铺间隔"（`rebuilt: true`）：
   * - 这一页有行还没有序号（第一次拖，或刚"加载更多"带进来一批）—— 没序号就没法取中点；
   * - 浮点也用尽（同一个缝里对半切 ~50 次）—— `(lo+hi)/2` 不再严格落在两者之间。
   *
   * 页 = **全库的前缀**（排序只在「全部」且没搜索时可用，见客户端），所以"页顶"就是"全库最前"，
   * 顶 / 底那侧没有邻居时留一个 `SPACING` 的余量就够。
   *
   * **不动 `updated_at` / `source`**：排序是"我怎么摆这一页"，不是"我改了这条的内容" ——
   * 动 `updated_at` 会连带改掉"最近改的在前"那段回退顺序，也等于宣称这条被你认领了。
   */
  const setOrder = (keys: string[], moved?: string | null): OrderResult => {
    const read = stmt('SELECT sort FROM tags WHERE key = ?');
    const sorts = keys.map((key) => (read.get(key) as { sort: number | null } | undefined)?.sort ?? null);

    /** 整页重铺：按 `index * SPACING` 给每个 key 一个新序号 */
    const seed = (): OrderResult =>
      transaction(() => {
        const put = stmt('UPDATE tags SET sort = ? WHERE key = ?');
        let written = 0;
        for (const [index, key] of keys.entries()) written += Number(put.run((index + 1) * SPACING, key).changes);
        return { written, rebuilt: true };
      });

    if (sorts.some((one) => one === null)) return seed();
    const at = moved == null ? -1 : keys.indexOf(moved);
    const key = at < 0 ? undefined : keys[at];
    if (key === undefined) return seed();
    const prev = at > 0 ? sorts[at - 1] ?? null : null;
    const next = at + 1 < sorts.length ? sorts[at + 1] ?? null : null;
    const lo = prev ?? (next === null ? 0 : next - 2 * SPACING);
    const hi = next ?? (prev === null ? 2 * SPACING : prev + 2 * SPACING);
    const mid = (lo + hi) / 2;
    if (!(mid > lo && mid < hi)) return seed();
    return transaction(() => ({
      written: Number(stmt('UPDATE tags SET sort = ? WHERE key = ?').run(mid, key).changes),
      rebuilt: false,
    }));
  };

  /** 返回是否真的写进去了（导入撞上 `user` 行时整条跳过） */
  const writeEntry = (entry: TagListEntry, guardUser: boolean): boolean => {
    statsCache = null;
    const result = stmt(insertTagSql(guardUser)).run(
      entry.key,
      entry.en,
      entry.zh,
      entry.source,
      entry.hot,
      entry.updatedAt,
      tagSearchBlob(entry),
    );
    // 被 `WHERE tags.source <> 'user'` 挡下的行，连分类 / 别名都不能动 ——
    // 下面这几条 DELETE 是无条件的，不提前返回就把人家手改过的分类抹了
    if (guardUser && Number(result.changes) === 0) return false;
    // 分类 / 别名整组替换：改一条时它们可能变少，增量更新要自己算差集，不如删了重写
    stmt('DELETE FROM tag_categories WHERE tag_key = ?').run(entry.key);
    for (const name of entry.categories) {
      stmt('INSERT OR IGNORE INTO tag_categories (tag_key, name) VALUES (?, ?)').run(entry.key, name);
      // 顺手把名字注册成"真分类"：不然编辑框里打出来的新名字只是 tag 上的一个字符串，
      // 左边分类树里没有它的位置（尤其它是这一条唯一的分类时）
      stmt('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
    }
    stmt('DELETE FROM tag_aliases WHERE tag_key = ?').run(entry.key);
    for (const alias of entry.aliases) {
      const aliasKey = tagKey(alias);
      if (aliasKey === '' || aliasKey === entry.key) continue;
      stmt('INSERT OR IGNORE INTO tag_aliases (tag_key, alias_key, alias) VALUES (?, ?, ?)').run(entry.key, aliasKey, alias);
    }
    return true;
  };

  /** 批量入库（导入用）：一个事务写完，十几万条也就秒级；返回真正入库的条数 */
  const importEntries = (rows: TagListEntry[]): number => {
    let written = 0;
    transaction(() => {
      for (const row of rows) {
        if (writeEntry(row, true)) written += 1;
      }
    });
    return written;
  };

  const count = (): number => one('SELECT COUNT(*) AS c FROM tags');

  /**
   * 一次性搬迁：库是空的、盘上还有老文件时才做。
   * `tags.json` 在就用它，否则退回老 `dict.json`；搬完把来源改名（见下）。
   */
  const migrate = (): void => {
    if (count() > 0) return;
    const fromTags = readJson(options.tagsJson, null);
    const source = fromTags !== null ? options.tagsJson : options.legacyDictJson;
    const raw = fromTags ?? readJson(options.legacyDictJson, null);
    if (raw === null) return;
    const rows = sanitizeTags(raw);
    if (rows.length === 0) return;
    importEntries(rows);
    // 老文件改名而不是删掉：一是留个原件（迁移出问题还能翻），
    // 二是**免得它复活** —— 不然删了 tags.db，下次开库又把这批老条目灌回来。
    try {
      fs.renameSync(source, `${source}.migrated`);
    } catch {
      // 改名失败（权限/占用）不该让插件起不来：数据已经进库了
    }
  };

  migrate();

  return {
    lookup: (text: unknown): TagListEntry | null => {
      const key = tagKey(text);
      if (key === '') return null;
      // 正名优先：别名撞上某个正名时以正名为准（面板里给某条起了个别名，别名又正好是另一条的正名）
      const direct = readByKey(key);
      if (direct !== null) return direct;
      const row = stmt(
        `SELECT ${ROW_COLUMNS} FROM tag_aliases x JOIN tags t ON t.key = x.tag_key WHERE x.alias_key = ? ORDER BY t.key LIMIT 1`,
      ).get(key) as unknown as TagRow | undefined;
      return row === undefined ? null : toEntry(row);
    },

    upsert: (patch: Record<string, unknown>, now: number = Date.now()): TagListEntry | null => {
      const key = tagKey(patch?.en ?? patch?.text ?? '');
      const current = key === '' ? null : readByKey(key);
      const next = mergeTag(current, patch, now);
      if (next === null) return null;
      transaction(() => writeEntry(next, false));
      return next;
    },

    remove: (en: unknown): boolean => {
      const key = tagKey(en);
      if (key === '') return false;
      return transaction(() => {
        const result = stmt('DELETE FROM tags WHERE key = ?').run(key);
        stmt('DELETE FROM tag_categories WHERE tag_key = ?').run(key);
        stmt('DELETE FROM tag_aliases WHERE tag_key = ?').run(key);
        statsCache = null;
        return Number(result.changes) > 0;
      });
    },

    query: (options2: TagQuery = {}): TagQueryResult => {
      const needle = tagKey(options2.q);
      const category = String(options2.category ?? '');
      const limit = clampInt(options2.limit, 1, 1000, 200);
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (needle !== '') {
        clauses.push("t.search LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(needle)}%`);
      }
      if (category === '__none__') {
        clauses.push('NOT EXISTS (SELECT 1 FROM tag_categories c WHERE c.tag_key = t.key)');
      } else if (category !== '') {
        clauses.push('EXISTS (SELECT 1 FROM tag_categories c WHERE c.tag_key = t.key AND c.name = ?)');
        params.push(category);
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const rows = stmt(
        `SELECT ${ROW_COLUMNS} FROM tags t${where} ORDER BY (t.sort IS NULL), t.sort ASC, t.updated_at DESC, t.hot DESC, t.key ASC LIMIT ?`,
      ).all(...params, limit) as unknown as TagRow[];
      // 精确总数要再全表扫一遍（14 万条实测 22ms），而面板只显示一页 —— 封顶在 limit+1，
      // 超过 limit 就只表示"还有更多"。宽查询实测 22ms → 0.06ms；一条都不命中的查询本来就
      // 要全扫，封顶不增不减（SQLite 得扫完才知道凑不满）。
      const total = one(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM tags t${where} LIMIT ?)`, ...params, limit + 1);
      const { counts, categories } = stats();
      return {
        tags: rows.map(toEntry),
        total,
        counts,
        categories,
      };
    },

    count,
    setOrder,
    createCategory,
    removeCategory,
    renameCategory,
    importEntries,

    close: (): void => {
      cache.clear();
      db.close();
    },
  };
}
