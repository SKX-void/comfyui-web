/**
 * 词库规模基准 —— 量的是**发货的那套代码**（`tagdb.ts` 的 SQLite 存储），不是照抄一遍的算法
 * （抄的那份迟早和实现漂移）。顺带量另外两个还是 JSON 的文件，以及"为什么不上 FTS5"。
 *
 * 为什么先打包再跑：`server/*.ts` 之间用的是 `./x.js` 说明符（由 esbuild 解析），
 * Node 直接 import 会找不到文件。这里用 esbuild 现打一份到临时目录再 import。
 *
 * 用法：node plugins/prompt-editor/scripts/scale-bench.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-scale-'));

/** 打一个模块出来并 import 它（临时目录里的产物用完就删） */
async function loadModule(entry: string): Promise<Record<string, (...args: never[]) => unknown>> {
  const outfile = path.join(outDir, `${path.basename(entry, '.ts')}.mjs`);
  await build({
    entryPoints: [path.join(pluginDir, 'server', entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'warning',
  });
  return (await import(pathToFileURL(outfile).href)) as never;
}

const now = (): number => performance.now();
function median(runs: number, fn: () => void): number {
  const list: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = now();
    fn();
    list.push(now() - start);
  }
  list.sort((a, b) => a - b);
  return list[Math.floor(list.length / 2)] ?? 0;
}
const ms = (value: number): string => `${value.toFixed(value < 1 ? 3 : 1)}ms`;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

interface TagRowLike {
  key: string;
  en: string;
  zh: string;
  categories: string[];
  aliases: string[];
  source: string;
  updatedAt: number;
  hot: number;
}

interface TagDbLike {
  lookup(text: unknown): TagRowLike | null;
  upsert(patch: Record<string, unknown>, now?: number): TagRowLike | null;
  remove(en: unknown): boolean;
  query(options?: { q?: unknown; category?: unknown; limit?: unknown }): {
    tags: TagRowLike[];
    total: number;
    counts: { total: number; uncategorized: number };
    categories: { name: string; count: number }[];
  };
  count(): number;
  importEntries(rows: TagRowLike[]): number;
  close(): void;
}

/** 形状贴近真实：英文 tag 十来二十个字符、中文译文、一个分类、1/3 有别名、带热度 */
function makeRows(count: number): TagRowLike[] {
  const categories = ['画质', '光照', '人物', '风格', '构图'];
  return Array.from({ length: count }, (_, i) => {
    const en = `tag number ${i} detailed quality shot`;
    return {
      key: en,
      en,
      zh: `标签${i}的译文`,
      categories: [categories[i % 5] ?? '画质'],
      aliases: i % 3 === 0 ? [`alias${i}`] : [],
      source: 'import',
      // 导入的行都是"还没被人碰过"（updated_at = 0）+ 一个热度，跟 scripts/import-tags.ts 一致
      updatedAt: 0,
      hot: count - i,
    };
  });
}

const tagdb = await loadModule('tagdb.ts');
const doc = await loadModule('doc.ts');
const openTagDb = tagdb.openTagDb as unknown as (options: { db: string; tagsJson: string; legacyDictJson: string }) => TagDbLike;
const sanitizePreset = doc.sanitizePreset as (input: unknown) => unknown;
const storedFromRaw = doc.storedFromRaw as (input: unknown) => unknown;
const rawFromStored = doc.rawFromStored as (input: unknown) => unknown;

const missing = path.join(outDir, 'not-there.json');

console.log('词库 tags.db（现在发货的形态：SQLite + LIKE 全表扫；单进程同步 API，耗时直接算在宿主身上）\n');
console.log('  条目数\t库文件\t批量入库\t翻译命中(1000次)\t改一条\t面板(写后首次)\t面板(连续输入)\t搜索(英文)\t搜索(中文2字)');
for (const count of [1000, 5000, 20000, 100000, 140000]) {
  const file = path.join(outDir, `tags-${count}.db`);
  const db = openTagDb({ db: file, tagsJson: missing, legacyDictJson: missing });
  const start = now();
  db.importEntries(makeRows(count));
  const importMs = now() - start;
  const tLookup = median(3, () => {
    for (let i = 0; i < 1000; i += 1) db.lookup(`tag number ${i} detailed quality shot`);
  });
  const tWrite = median(5, () => db.upsert({ en: `brand new tag ${count}`, zh: '新词' }));
  // 写后首次：全局计数缓存刚被写操作打掉，这一下要把计数重算一遍
  const tCold = median(5, () => {
    db.upsert({ en: `cold probe ${count}`, zh: '冷启动探针' });
    db.query({ limit: 300 });
  });
  const tWarm = median(5, () => db.query({ limit: 300 }));
  const tEn = median(5, () => db.query({ q: 'quality', limit: 300 }));
  const tZh = median(5, () => db.query({ q: '标签1', limit: 300 }));
  db.close();
  const bytes = fs.statSync(file).size;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  console.log(
    `  ${count}\t${mb(bytes)}\t${ms(importMs)}\t${ms(tLookup / 1000)}/次\t${ms(tWrite)}\t${ms(tCold)}\t${ms(tWarm)}\t${ms(tEn)}\t${ms(tZh)}`,
  );
}

console.log('\n对照：换库前的整文件 JSON（parse 一次 + 每次查询全表扫 + 全表排序再切片）\n');
console.log('  条目数\t文件\t载入\t改一条(全量 stringify)\t面板查询');
for (const count of [20000, 140000]) {
  const entries: Record<string, unknown> = {};
  for (const row of makeRows(count)) {
    entries[row.en] = { en: row.en, zh: row.zh, categories: row.categories, aliases: row.aliases, source: row.source, updatedAt: row.updatedAt };
  }
  const body = JSON.stringify({ version: 2, entries });
  const tLoad = median(3, () => JSON.parse(body));
  const tWrite = median(3, () => {
    const lib = JSON.parse(body) as { entries: Record<string, unknown> };
    lib.entries['brand new tag'] = { en: 'brand new tag', zh: '新词' };
    JSON.stringify(lib);
  });
  const tQuery = median(3, () => {
    const lib = JSON.parse(body) as { entries: Record<string, { en: string; updatedAt: number }> };
    const all = Object.entries(lib.entries).map(([key, entry]) => ({ key, ...entry }));
    all.filter((entry) => entry.en.includes('quality'));
    all.sort((a, b) => b.updatedAt - a.updatedAt || a.en.localeCompare(b.en));
    all.slice(0, 300);
  });
  console.log(`  ${count}\t${mb(body.length)}\t${ms(tLoad)}\t${ms(tWrite)}\t${ms(tQuery)}`);
}

console.log('\n草稿 draft.json（还是 JSON：每个区块编辑一次 = 全量读 + 全量写；上限 5000 条）\n');
console.log('  条目数\t文件\t读(parse+sanitize)\t写(stringify+落盘)');
for (const total of [1000, 5000]) {
  const per = Math.ceil(total / 10);
  const blocks = Array.from({ length: 10 }, (_, index) => ({
    id: `b${index}`,
    title: `区块 ${index}`,
    color: '#6ea8fe',
    mode: 'tag',
    items: Array.from({ length: per }, (_, i) => ({
      id: `id-${index * per + i}`,
      text: `tag number ${index * per + i} detailed quality shot`,
      enabled: true,
      translation: `标签${index * per + i}`,
      source: 'dict',
    })),
  }));
  const stored = {
    version: 1,
    structure: blocks.map(({ items, ...meta }) => meta),
    items: Object.fromEntries(blocks.map((block) => [block.id, block.items])),
  };
  const body = JSON.stringify(stored);
  const tRead = median(5, () => storedFromRaw(JSON.parse(body)));
  const tWrite = median(5, () => JSON.stringify(rawFromStored(stored)));
  console.log(`  ${total}\t${(body.length / 1024).toFixed(0)}KB\t${ms(tRead)}\t${ms(tWrite)}`);
}

console.log('\n预设库 presets.json（还是 JSON：**每个请求**都全量读 + 逐条 sanitize；上限 300 条）\n');
console.log('  预设数\t文件\t一次读');
for (const count of [100, 300]) {
  const presets = Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    name: `预设 ${index}`,
    updatedAt: 1700000000000,
    doc: { version: 1, blocks: [{ id: 'b0', title: '区块', color: '#6ea8fe', mode: 'tag', items: makeRows(60) }] },
  }));
  const body = JSON.stringify({ version: 1, presets });
  const tRead = median(5, () => {
    const raw = JSON.parse(body) as { presets: unknown[] };
    raw.presets.map(sanitizePreset).filter((preset) => preset !== null);
  });
  console.log(`  ${count}\t${(body.length / 1024).toFixed(0)}KB\t${ms(tRead)}`);
}

// 面板搜索为什么不用 FTS5：中文子串在 SQLite 自带的分词器里没有能用的那个 ——
// trigram 只认 3 个字符以上（1~2 字的中文直接查不到），unicode61 把整串中文当一个 token。
// node:sqlite 又没有注册自定义分词器的入口（DatabaseSync 上没有对应方法）。
console.log('\n为什么不上 FTS5（同一个库、同一批数据：trigram 索引 vs LIKE 全表扫）\n');
{
  const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite');
  const db = new DatabaseSync(path.join(outDir, 'fts.db'));
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(en, zh, tokenize='trigram')");
  const insert = db.prepare('INSERT INTO fts VALUES (?, ?)');
  const start = now();
  db.exec('BEGIN');
  for (let i = 0; i < 140000; i += 1) insert.run(`tag number ${i} detailed quality shot`, `标签${i}的译文`);
  db.exec('COMMIT');
  console.log(`  14 万条建 trigram 索引：${ms(now() - start)}`);
  const match = db.prepare('SELECT en FROM fts WHERE fts MATCH ? LIMIT 5');
  const like = db.prepare("SELECT en FROM fts WHERE zh LIKE '%' || ? || '%' LIMIT 5");
  const probes: [string, string][] = [
    ['英文 ≥3 字符 quality', 'quality'],
    ['中文 3 字 标签1', '标签1'],
    ['中文 2 字 标签', '标签'],
  ];
  for (const [label, needle] of probes) {
    const hits = match.all(needle).length;
    const t = median(5, () => match.all(needle));
    console.log(`  MATCH ${label.padEnd(20)} 命中 ${hits} 条 · ${ms(t)}`);
  }
  console.log(`  LIKE 中文 2 字（FTS5 覆盖不到的那档）  命中 ${like.all('标签').length} 条 —— 它的耗时见上面「搜索(中文 2 字)」那列`);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(outDir, `fts.db${suffix}`), { force: true });
}

fs.rmSync(outDir, { recursive: true, force: true });
