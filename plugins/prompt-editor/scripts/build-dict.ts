/**
 * 预处理：把词库包（`词库.bmz`）解开后的原始层转成插件导入器认的资产。
 *
 * 原始层（`.cache/dictpack/`，由 `scripts/unpack-bmz.mjs` 从第三方词库包解出，**不进仓**）
 * → 两个交付资产：
 *   - `assets/danbooru-zh.csv`：`tag,category,count,zh,group,sub`（6 列，导入器按表头名认）
 *   - `assets/cooccur.tsv`：共现邻居，原样搬（`词<TAB>邻居|邻居|…`）
 *
 * 两个资产都走 git-lfs（12.6MB / 2.4MB）。这个脚本只在**换词库**时跑一次，产物是要入库的东西 ——
 * 所以别把原始层放回 `assets/`：`pack.mjs` 的 extras 是整个 `assets/` 目录，15MB 会跟着进
 * `tabs/` 和 `dist/`。
 *
 * 三个转换规则，都是为了对上插件现有的库结构：
 *
 * - `count`（热度）从**旧机翻表**按 `tagKey` 合并：新表没有热度列，旧表只能覆盖 38.8%，
 *   其余留 0。旧表退役前这是唯一一次拿热度的机会。
 * - `group/sub` 来自 `标签分类.tsv`（它正好 = 新表里 category=0 的那 52,514 条）。
 *   源表里的 `未分类` 是"还没细分类"的意思，**不建这个分类**（它和面板内置的「未分类」
 *   伪筛选同名），这些词只挂大类。
 * - 译文与正名相同的行（77,237 条，画师/作品这类专有名词）**照写**：导入侧开着
 *   `keepPlaceholders`，它们在库里算命中，翻译时把英文当译文返回，比让机翻去翻 `hololive` 更对。
 *
 * 用法：
 *   node plugins/prompt-editor/scripts/build-dict.ts [--src <dir>] [--hot <csv>] [--out <dir>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-dict-'));

/** 打一次包再 import：`server/*.ts` 之间用 `./x.js` 说明符，Node 直接 import 找不到（同 import-tags.ts） */
async function loadPlugin(): Promise<Record<string, never>> {
  const outfile = path.join(outDir, 'plugin.mjs');
  await build({
    entryPoints: [path.join(pluginDir, 'server', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'warning',
  });
  return (await import(pathToFileURL(outfile).href)) as never;
}

function parseArgs(argv: string[]): { src: string; hot: string; out: string } {
  // 原始层放 `.cache/`（git 不跟踪），别放 `assets/` —— 那里整个目录都会被打进产物
  let src = path.join(repoRoot, '.cache', 'dictpack');
  let hot = path.join(pluginDir, 'assets', 'danbooru-zh.csv');
  let out = path.join(pluginDir, 'assets');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--src') src = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--hot') hot = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--out') out = path.resolve(argv[(i += 1)] ?? '');
  }
  return { src, hot, out };
}

/** 最小 CSV 转义：带逗号/引号/换行的字段才加引号，内部引号翻倍（导入器的解析器认这两种） */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const rowsOf = (file: string): string[][] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'));

const args = parseArgs(process.argv.slice(2));
const tagsFile = path.join(args.src, 'danbooru_tags.txt');
const groupFile = path.join(args.src, '标签分类.tsv');
const coocFile = path.join(args.src, '共现邻居.tsv');
for (const file of [tagsFile, groupFile, coocFile]) {
  if (!fs.existsSync(file)) {
    console.error(`缺输入：${file}（先用 unpack-bmz 把 词库.bmz 解开到 --src 目录）`);
    process.exit(1);
  }
}

const plugin = (await loadPlugin()) as unknown as {
  parseTagCsv: (text: string, options?: { keepPlaceholders?: boolean }) => { rows: { key: string; hot: number }[] };
};

/**
 * 旧表的热度：key → count（`key` 已经是 tagKey 归一过的，新表也是空格形，直接对得上）。
 *
 * 默认读的就是 `assets/danbooru-zh.csv` **自己**（第一次跑时它还是那份旧机翻表）：那时候旧表是
 * 唯一的热度来源，按 key 归一后覆盖新表的 38.8%。之后重跑读的是上一轮的产物（`count` 列已经是
 * 合并过的），所以**重跑是幂等的** —— 但 `keepPlaceholders` 必须开着，否则占位行在这一步被丢掉，
 * 重跑会把那 7.7 万条的热度清零。
 */
const hot = new Map<string, number>();
if (fs.existsSync(args.hot)) {
  for (const row of plugin.parseTagCsv(fs.readFileSync(args.hot, 'utf8'), { keepPlaceholders: true }).rows) {
    hot.set(row.key, row.hot);
  }
}

/** 词 → [大类, 小类]；源表里的 `未分类` 不当分类（只留大类） */
const groups = new Map<string, [string, string]>();
for (const [word = '', group = '', sub = ''] of rowsOf(groupFile)) {
  groups.set(word.trim().toLowerCase(), [group.trim(), sub.trim() === '未分类' ? '' : sub.trim()]);
}

const lines = ['tag,category,count,zh,group,sub'];
const stats = { rows: 0, hotMerged: 0, grouped: 0, subbed: 0, placeholder: 0, quoted: 0 };
for (const [en = '', zh = '', category = ''] of rowsOf(tagsFile)) {
  const tag = en.trim();
  if (tag === '') continue;
  const [group = '', sub = ''] = groups.get(tag.toLowerCase()) ?? [];
  const count = hot.get(tag.toLowerCase()) ?? 0;
  if (count > 0) stats.hotMerged += 1;
  if (group !== '') stats.grouped += 1;
  if (sub !== '') stats.subbed += 1;
  if (zh.trim().toLowerCase() === tag.toLowerCase()) stats.placeholder += 1;
  const cells = [tag, category.trim(), String(count), zh.trim(), group, sub];
  if (cells.some((one) => /[",\n]/.test(one))) stats.quoted += 1;
  lines.push(cells.map(csvCell).join(','));
  stats.rows += 1;
}

fs.mkdirSync(args.out, { recursive: true });
const csv = `${lines.join('\n')}\n`;
fs.writeFileSync(path.join(args.out, 'danbooru-zh.csv'), csv);
fs.copyFileSync(coocFile, path.join(args.out, 'cooccur.tsv'));

// 自检：拿导入器自己的解析器读一遍产物，确认列认得出来（这一步能挡住转义/列序写错）
const parsed = plugin.parseTagCsv(csv);
console.log(
  JSON.stringify(
    {
      out: args.out,
      csvBytes: Buffer.byteLength(csv),
      csvMB: Number((Buffer.byteLength(csv) / 1048576).toFixed(1)),
      coocBytes: fs.statSync(path.join(args.out, 'cooccur.tsv')).size,
      built: stats,
      parsedByPlugin: { rows: parsed.rows.length, header: ['tag', 'category', 'count', 'zh'] },
    },
    null,
    1,
  ),
);
