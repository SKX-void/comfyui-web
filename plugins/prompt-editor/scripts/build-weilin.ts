/**
 * 预处理：把 WeiLin 的**人工**词库（GitHub `weilin9999/WeiLin-Comfyui-Tools-Prompt`，MIT）
 * 转成插件导入器认的资产 `assets/weilin-zh.csv`。
 *
 * 为什么值得单独做一层：那份表是**人写的**译文，4 千条，带两级分类（11 个大类 / 132 个小类），
 * 而且每条都有中文。它进库时写 `source='builtin'` —— 比 32 万条的机翻表高一个信任级别，
 * 重导机翻表盖不掉它（见 `server/tagdb.ts` 的 `ImportGuard`）。
 *
 * 源是 SQL 转储（tags 目录下按日期分的各个 .sql），三张表靠 UUID 串起来：
 *   `tag_tags.g_uuid` → `tag_subgroups.g_uuid` → `tag_subgroups.p_uuid` == `tag_groups.p_uuid`
 * 后加的提交（如 NSFW 那个文件）不写 `id_index` / `subgroup_id`，只有 UUID —— 所以一律按 UUID 解，
 * 整数 id 只当兜底。
 *
 * 三件事在写出去之前做掉：
 * - **下划线折成空格**（`long_hair` → `long hair`）：源表是 booru 那套写法，我们库里是空格形。
 *   折了才和机翻表落在**同一个键**上（于是人工那条压过机翻那条）。颜文字里的下划线（`^_^`）保留。
 * - **热度 = 机翻最大热度 + 1 + 这个词在机翻表里的热度**：源表没有热度列，而面板是按 `hot DESC`
 *   排的。借同词的热度是为了**层内**排序真实（常用的排前面），整体加一个"机翻最大 + 1"的底座是为了
 *   **人工那层整个排在机翻之上** —— 人工是整理过的译文，本来就该先看见；而 `1boy` / `girl` / `kawaii`
 *   这 1,077 条在机翻表里根本没有（取不到热度），不加底座就正好沉到 32 万条最底下。
 *   底座取"最大 + 1"而不是"最大"：跟机翻最大的那条（`1girl` 8,419,190）不并列，不然两层在榜上会交错。
 * - **`未分类` 不当分类名**：源表里没有这个值，但机翻表那侧有，规则统一放在解析层
 *   （见 `tagcsv.ts`）—— 这里只保证大类/小类原样带出来。
 *
 * 用法（换词库时才跑）：
 *   node plugins/prompt-editor/scripts/build-weilin.ts [--src <dir>] [--hot <csv>] [--out <dir>] [--no-pull]
 * `--src` 默认 `.cache/weilin-prompt`（git 不跟踪），不存在就 clone，存在就 pull。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const REPO_URL = 'https://github.com/weilin9999/WeiLin-Comfyui-Tools-Prompt';
const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-weilin-'));

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

function parseArgs(argv: string[]): { src: string; hot: string; out: string; pull: boolean } {
  let src = path.join(repoRoot, '.cache', 'weilin-prompt');
  let hot = path.join(pluginDir, 'assets', 'danbooru-zh.csv');
  let out = path.join(pluginDir, 'assets');
  let pull = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--src') src = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--hot') hot = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--out') out = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--no-pull') pull = false;
  }
  return { src, hot, out, pull };
}

/** 最小 CSV 转义：带逗号/引号/换行的字段才加引号，内部引号翻倍（导入器的解析器认这两种） */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * SQL 转储里的值元组 → 字符串数组。
 *
 * 手写扫描而不是正则：值里会出现逗号（`'1girl, solo'`）、分号、以及**用两个单引号转义的单引号**
 * （`'don''t'`）—— 正则切这两种都会切错。
 */
function splitValues(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch === "'") {
      let value = '';
      i += 1;
      while (i < body.length) {
        if (body[i] === "'") {
          if (body[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          break;
        }
        value += body[i];
        i += 1;
      }
      i += 1;
      out.push(value);
    } else if (ch === ',' || ch === ' ') {
      i += 1;
    } else {
      let raw = '';
      while (i < body.length && body[i] !== ',') {
        raw += body[i];
        i += 1;
      }
      out.push(raw.trim());
    }
  }
  return out;
}

/** 一条 INSERT 语句：`INSERT OR REPLACE INTO "表" (列…) VALUES (值…);` */
interface Insert {
  table: string;
  row: Record<string, string>;
}

/**
 * 把一个目录下所有 `.sql` 读成 INSERT 列表。
 *
 * 按 `;` 切语句要**跳过引号里的分号**（译文里真的有），所以还是手写扫描。
 */
function readSqlDir(dir: string): Insert[] {
  const inserts: Insert[] = [];
  for (const file of fs.readdirSync(dir).filter((one) => one.endsWith('.sql'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    let start = 0;
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] as string;
      if (quoted) {
        if (ch === "'") {
          if (text[i + 1] === "'") i += 1;
          else quoted = false;
        }
        continue;
      }
      if (ch === "'") {
        quoted = true;
        continue;
      }
      if (ch !== ';') continue;
      const statement = text.slice(start, i);
      start = i + 1;
      const head = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)/is.exec(statement);
      if (head === null) continue;
      const columns = (head[2] as string).split(',').map((one) => one.trim().replace(/^"|"$/g, ''));
      const values = splitValues(head[3] as string);
      const row: Record<string, string> = {};
      columns.forEach((name, index) => {
        row[name] = values[index] ?? '';
      });
      inserts.push({ table: head[1] as string, row });
    }
  }
  return inserts;
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.join(args.src, '.git'))) {
  fs.mkdirSync(path.dirname(args.src), { recursive: true });
  console.log(`clone ${REPO_URL} → ${args.src}`);
  const cloned = spawnSync('git', ['clone', '--depth', '1', '--quiet', REPO_URL, args.src], { stdio: 'inherit' });
  if (cloned.status !== 0) {
    console.error('clone 失败（离线？）—— 也可以自己 clone 到 --src 指定的目录');
    process.exit(1);
  }
} else if (args.pull) {
  // 拉不到不算错：本地那份照样能用（离线 / 代理不通时别把整次构建卡死）
  const pulled = spawnSync('git', ['-C', args.src, 'pull', '--ff-only', '--quiet'], { stdio: 'inherit' });
  if (pulled.status !== 0) console.warn('git pull 失败，用本地已有的一份继续');
}

// `tags/` 下按日期分目录（`2025_03_31/`、`2025_04_01/`…）：全读，别写死日期
const tagsRoot = path.join(args.src, 'tags');
const tagsDirs = fs.existsSync(tagsRoot)
  ? fs
      .readdirSync(tagsRoot, { withFileTypes: true })
      .filter((one) => one.isDirectory())
      .map((one) => path.join(tagsRoot, one.name))
  : [];
const inserts = tagsDirs.flatMap((dir) => readSqlDir(dir));
const groups = inserts.filter((one) => one.table === 'tag_groups');
const subgroups = inserts.filter((one) => one.table === 'tag_subgroups');
const tags = inserts.filter((one) => one.table === 'tag_tags');
if (tags.length === 0) {
  console.error(`没读到 tag_tags：${args.src} 不像那份词库仓（缺 tags/ 目录？）`);
  process.exit(1);
}

// 大类：p_uuid → 名字（子表用它回指父表）
const groupByUuid = new Map<string, string>();
const groupById = new Map<string, string>();
for (const { row } of groups) {
  const name = (row.name ?? '').trim();
  if (name === '') continue;
  if (row.p_uuid) groupByUuid.set(row.p_uuid, name);
  if (row.id_index) groupById.set(row.id_index, name);
}
// 小类：g_uuid → { 名字, 大类 }；整数 id 也留一份兜底
const subByUuid = new Map<string, { name: string; group: string }>();
const subById = new Map<string, { name: string; group: string }>();
for (const { row } of subgroups) {
  const name = (row.name ?? '').trim();
  if (name === '') continue;
  const group = (row.p_uuid ? groupByUuid.get(row.p_uuid) : undefined) ?? groupById.get(row.group_id ?? '') ?? '';
  const sub = { name, group };
  if (row.g_uuid) subByUuid.set(row.g_uuid, sub);
  if (row.id_index) subById.set(row.id_index, sub);
}

const plugin = (await loadPlugin()) as unknown as {
  parseTagCsv: (
    text: string,
    options?: { keepPlaceholders?: boolean },
  ) => {
    rows: { key: string; hot: number }[];
    stats: { sources: Record<string, number>; grouped: number; duplicates: number };
    /** 分类的父子关系（小类 → 大类） */
    parents: Map<string, string>;
  };
  foldUnderscore: (input: string) => string;
};

/** 机翻表的热度：key → hot（那份表的 key 已经是空格形，两边折完就能对上） */
const hot = new Map<string, number>();
if (fs.existsSync(args.hot)) {
  for (const row of plugin.parseTagCsv(fs.readFileSync(args.hot, 'utf8'), { keepPlaceholders: true }).rows) {
    hot.set(row.key, row.hot);
  }
}
/**
 * 人工那层的热度底座：机翻表里最大的那条 + 1（当前是 `1girl` 的 8,419,190）。
 * 于是人工这 4 千条整个排在机翻 32 万条之上，层内再按借来的热度排（常用的还是前面）。
 * 机翻表读不到（`--hot` 指错 / 文件不在）就退回 1：至少层内排序还在，不至于全 0。
 */
const hotBase = ((): number => {
  // 32 万条不能 `Math.max(...values)`（展开成实参直接爆栈），走一遍循环
  let max = 0;
  for (const one of hot.values()) if (one > max) max = one;
  return max + 1;
})();

const lines = ['tag,zh,group,sub,count,source'];
const seen = new Set<string>();
const stats = { rows: 0, groups: new Set<string>(), subs: new Map<string, string>(), folded: 0, hotMerged: 0, hotBase, unresolved: 0, quoted: 0 };
for (const { row } of tags) {
  const raw = (row.text ?? '').trim();
  const zh = (row.desc ?? '').trim();
  if (raw === '' || zh === '') continue;
  // 下划线折成空格（颜文字里的保留）—— 折完才和机翻表同一个键
  const tag = plugin.foldUnderscore(raw);
  const sub = (row.g_uuid ? subByUuid.get(row.g_uuid) : undefined) ?? subById.get(row.subgroup_id ?? '') ?? { name: '', group: '' };
  const borrowed = hot.get(tag.toLowerCase()) ?? 0;
  const count = hotBase + borrowed;
  // 同一份表里同一个词写两遍（3,872 个唯一词 / 4,087 行）：留第一条，解析层也会去重。
  // **统计放在去重之后**：不然报出来的数比产物里的行数还大（之前 `hotMerged` 就多算了那 259 条重复）
  const dedupe = tag.toLowerCase();
  if (seen.has(dedupe)) continue;
  seen.add(dedupe);
  if (tag !== raw) stats.folded += 1;
  if (sub.name === '') stats.unresolved += 1;
  if (borrowed > 0) stats.hotMerged += 1;
  if (sub.group !== '') stats.groups.add(sub.group);
  if (sub.name !== '') stats.subs.set(sub.name, sub.group);
  const cells = [tag, zh, sub.group, sub.name, String(count), 'builtin'];
  if (cells.some((one) => /[",\n]/.test(one))) stats.quoted += 1;
  lines.push(cells.map(csvCell).join(','));
  stats.rows += 1;
}

fs.mkdirSync(args.out, { recursive: true });
const csv = `${lines.join('\n')}\n`;
const target = path.join(args.out, 'weilin-zh.csv');
fs.writeFileSync(target, csv);

// 自检：拿导入器自己的解析器读一遍产物，确认列认得出来、来源是 builtin、下划线真的折了
const parsed = plugin.parseTagCsv(csv, { keepPlaceholders: true });
console.log(
  JSON.stringify(
    {
      out: target,
      bytes: Buffer.byteLength(csv),
      built: {
        rows: stats.rows,
        groups: stats.groups.size,
        subgroups: stats.subs.size,
        foldedUnderscore: stats.folded,
        hotMerged: stats.hotMerged,
        unresolvedSubgroup: stats.unresolved,
        quoted: stats.quoted,
      },
      parsedByPlugin: {
        rows: parsed.rows.length,
        sources: parsed.stats.sources,
        grouped: parsed.stats.grouped,
        parents: parsed.parents.size,
        duplicates: parsed.stats.duplicates,
        sample: parsed.rows.slice(0, 3).map((one) => one.key),
      },
    },
    null,
    1,
  ),
);
