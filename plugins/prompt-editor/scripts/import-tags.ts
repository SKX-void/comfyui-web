/**
 * 词库导入（命令行）：把 danbooru 的机翻表灌进 `tags.db`。
 *
 * 解析规则（列怎么对、哪些行跳过）在 `server/tagcsv.ts`，与面板那个「导入内置机翻表」
 * 按钮**共用一份** —— 这里只剩"读文件 / 报数 / 开库"这点命令行的事。
 *
 * ## 两条硬规矩（与面板那条路一致）
 *
 * - **不覆盖手改过的条目**（`source='user'`）：你在面板里改过译文、挪过分类的都算你的，
 *   重导一次（比如换个 `--min-count`）不会把它们打回原形。
 * - 导入的条目 `updated_at = 0`：面板排序是 `updated_at DESC, hot DESC`，
 *   于是"你碰过的"永远压在"一整批导入的"前面，导入的那批内部按热度排。
 *
 * ## 用法
 *
 *   node plugins/prompt-editor/scripts/import-tags.ts <csv> [--min-count N] [--keep-placeholders]
 *                                                    [--cooccur <tsv>] [--dry-run] [--db <tags.db>]
 *   pnpm -C plugins/prompt-editor import:tags <csv> -- --min-count 500
 *
 * `--keep-placeholders`：把"译文 == 正名"的占位行也收进来（专有名词命中即原文）。面板那条路
 * 默认开着，CLI 默认关 —— 命令行拿别的表来导时，那些占位多半真是没翻出来的。
 * `--cooccur`：顺手灌共现邻居表（`词<TAB>邻居|邻居`，产物里那份是 `assets/cooccur.tsv`）。
 *
 * 面板那条路（`POST /tags/import`）读的是**产物自带的** `assets/danbooru-zh.csv`；
 * 这个脚本读你给的任意文件，写的是同一个 `tags.db`（WAL 允许宿主同时读，宿主那份计数缓存
 * 靠 `PRAGMA data_version` 自己发现外部写入，不用重启、不用重挂 tab）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
/** 宿主的插件空间：`data/plugins/<包名，/ 换成 +>/`（见 docs/config.md 的五层表） */
const DEFAULT_DB = path.join(repoRoot, 'data', 'plugins', '@comfyui-web+prompt-editor', 'tags.db');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-import-'));

/**
 * 打包再 import：`server/*.ts` 之间用的是 `./x.js` 说明符（由 esbuild 解析），
 * Node 直接 import 会找不到文件（与 scripts/scale-bench.ts 同一个理由）。
 * 打的是插件入口 `index.ts` —— 它把 `parseTagCsv` / `looksLikeLfsPointer` / `openTagDb` 都再导出了，
 * 打一次就够。
 */
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

function parseArgs(argv: string[]): {
  file: string;
  db: string;
  minCount: number;
  cooccur: string;
  keepPlaceholders: boolean;
  source: string;
  dryRun: boolean;
} {
  const rest: string[] = [];
  let db = DEFAULT_DB;
  let minCount = 0;
  let cooccur = '';
  let keepPlaceholders = false;
  let source = 'import';
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--db') db = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--min-count') minCount = Number(argv[(i += 1)] ?? 0) || 0;
    else if (arg === '--cooccur') cooccur = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--keep-placeholders') keepPlaceholders = true;
    else if (arg === '--source') source = (argv[(i += 1)] ?? '').trim().toLowerCase() || 'import';
    else if (arg === '--dry-run') dryRun = true;
    else rest.push(arg);
  }
  return { file: rest[0] ?? '', db, minCount, cooccur, keepPlaceholders, source, dryRun };
}

const args = parseArgs(process.argv.slice(2));
if (args.file === '' || !fs.existsSync(args.file)) {
  console.error(
    '用法：node scripts/import-tags.ts <csv 文件> [--source user|import|builtin] [--min-count N] [--keep-placeholders] [--cooccur <tsv>] [--dry-run] [--db <tags.db>]',
  );
  console.error(`默认库：${DEFAULT_DB}`);
  process.exit(1);
}
if (!['user', 'import', 'builtin'].includes(args.source)) {
  console.error(`--source 只能是 user / import / builtin（收到「${args.source}」）`);
  process.exit(1);
}
/**
 * 守卫跟着来源走：`import`（机翻）只许盖机翻那层，人工来源（`builtin`）只不许盖手改的
 * —— 于是同一批词里人工译文压过机翻，而重导机翻表永远冲不掉它（见 `tagdb.ts` 的 `ImportGuard`）。
 */
const guard = args.source === 'import' ? 'import' : 'user';

const plugin = (await loadPlugin()) as unknown as {
  looksLikeLfsPointer: (text: string) => boolean;
  parseTagCsv: (text: string, options?: { minCount?: number; keepPlaceholders?: boolean; defaultSource?: string }) => {
    rows: {
      key: string;
      en: string;
      zh: string;
      categories: string[];
      aliases: string[];
      source: string;
      updatedAt: number;
      hot: number;
    }[];
    stats: {
      lines: number;
      header: string[];
      noTag: number;
      noZh: number;
      placeholder: number;
      grouped: number;
      sources: Record<string, number>;
      filtered: number;
      duplicates: number;
    };
    /** 分类的父子关系（小类 → 大类） */
    parents: Map<string, string>;
  };
  parseCooccurTsv: (text: string) => { rows: [string, string, number][]; stats: { lines: number; kept: number } };
  openTagDb: (options: { db: string; tagsJson: string; legacyDictJson: string }) => {
    importEntries(rows: unknown[], parents?: Map<string, string>, guard?: 'user' | 'import'): number;
    importCooccur(rows: [string, string, number][]): number;
    count(): number;
    close(): void;
  };
};
const { looksLikeLfsPointer, parseTagCsv, parseCooccurTsv, openTagDb } = plugin;

const started = performance.now();
const raw = fs.readFileSync(args.file, 'utf8');
if (looksLikeLfsPointer(raw)) {
  // 这份 CSV 在源码里走 git-lfs：没装 lfs（或 clone 时 GIT_LFS_SKIP_SMUDGE=1）拿到的就是这一行指针
  console.error(`${args.file} 是 git-lfs 指针，不是真文件：先 git lfs pull`);
  process.exit(1);
}

const { rows, stats, parents } = parseTagCsv(raw, {
  minCount: args.minCount,
  keepPlaceholders: args.keepPlaceholders,
  defaultSource: args.source,
});
console.log(`读入 ${stats.lines} 行${stats.header.length === 0 ? '' : ` · 列序 ${stats.header.join(',')}`}`);
console.log(
  `跳过：无 tag ${stats.noTag} · 无译文 ${stats.noZh}` +
    `${args.keepPlaceholders ? '' : ` · 译文同正名 ${stats.placeholder}`}` +
    `${args.minCount > 0 ? ` · count < ${args.minCount} 过滤掉 ${stats.filtered}` : ''}` +
    `${stats.duplicates > 0 ? ` · 同键重复 ${stats.duplicates}` : ''}`,
);
console.log(
  `入库候选 ${rows.length} 条（来源 ${Object.entries(stats.sources).map(([one, n]) => `${one} ${n}`).join(' / ')}）` +
    ` · 带人工分类 ${stats.grouped} 条 · 分类父子关系 ${parents.size} 对`,
);

if (args.dryRun) {
  console.log('--dry-run：没写库');
} else {
  const db = openTagDb({
    db: args.db,
    tagsJson: path.join(path.dirname(args.db), 'tags.json'),
    legacyDictJson: path.join(path.dirname(args.db), 'dict.json'),
  });
  const before = db.count();
  const written = db.importEntries(rows, parents, guard);
  const after = db.count();
  let cooccur = 0;
  if (args.cooccur !== '') {
    const parsed = parseCooccurTsv(fs.readFileSync(args.cooccur, 'utf8'));
    cooccur = db.importCooccur(parsed.rows);
  }
  db.close();
  console.log(`入库 ${written} 条（${rows.length - written} 条是你手改过的，跳过）· 库内 ${before} → ${after} 条`);
  if (args.cooccur !== '') console.log(`共现邻居 ${cooccur} 对`);
  console.log(`库文件 ${args.db} · ${(fs.statSync(args.db).size / 1024 / 1024).toFixed(1)}MB`);
}

const groups = new Map<string, number>();
for (const entry of rows) {
  const name = entry.categories[0] ?? '未分类';
  groups.set(name, (groups.get(name) ?? 0) + 1);
}
const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`);
console.log(`分类：${top.join(' · ')}`);
console.log(`耗时 ${((performance.now() - started) / 1000).toFixed(1)}s`);

fs.rmSync(outDir, { recursive: true, force: true });
