#!/usr/bin/env node
/**
 * 版本闸门：每条"版本线"（核心一条 + 每个插件一条）在有产物相关改动时必须升号，
 * 否则 verify 失败 —— 把"忘了升 version"从靠自觉变成机器提醒。
 *
 * 判定（对每条线）：
 *   窗口起点 = max(基线提交, 该线 versionFile 最近一次改 version 的提交)
 *   自窗口起若该线目录下有改动（git diff + 工作区未提交，跳过 *.md / docs/），
 *   且 version 仍等于窗口起点的值 → 失败。
 *
 * 为什么不用 git tag：tag 也要人记得打，"最近一次改 version 的提交"完全由历史推导，
 * 零额外纪律；基线文件只解决"从哪一刻开始执行这条规则"（历史欠账不追溯）。
 * 基线更新：升号提交合入后，把 scripts/version-baseline.json 里对应行的 sha
 * 更新为那次提交（不更新只会让 diff 窗口越拉越长，不会漏报）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw err;
  }
}

const pluginIds = fs
  .readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const LINES = [
  {
    id: 'core',
    label: 'core',
    dirs: ['apps/server', 'apps/web', 'packages/shared'],
    versionFile: 'apps/server/package.json',
  },
  ...pluginIds.map((id) => ({
    id: `plugins/${id}`,
    label: `plugins/${id}`,
    dirs: [`plugins/${id}`],
    versionFile: `plugins/${id}/package.json`,
  })),
];

const baselinePath = path.join(root, 'scripts', 'version-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

function versionAt(sha, versionFile) {
  const text = git(['show', `${sha}:${versionFile}`], { allowFailure: true });
  if (!text) return null;
  try {
    return JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}

/** 最近一次真正改过 version 字段的提交；从没改过（或历史里读不到）返回 null */
function lastVersionBump(versionFile) {
  const commits = git(['log', '--format=%H', '-n', '200', '--', versionFile], { allowFailure: true })
    .split('\n')
    .filter(Boolean);
  for (const sha of commits) {
    const cur = versionAt(sha, versionFile);
    const parent = versionAt(`${sha}^`, versionFile);
    if (cur !== null && cur !== parent) return sha;
  }
  return null;
}

/** 返回两个提交里离 HEAD 更近的那个（比较各自到 HEAD 的提交数） */
function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  const countA = Number(git(['rev-list', '--count', `${a}..HEAD`], { allowFailure: true }) || 'Infinity');
  const countB = Number(git(['rev-list', '--count', `${b}..HEAD`], { allowFailure: true }) || 'Infinity');
  return countA <= countB ? a : b;
}

/** 自 since 起（含工作区未提交）该线目录下改动过的文件 */
function changedFiles(dirs, since) {
  const pathspec = ['--', ...dirs];
  const sources = [
    git(['diff', '--name-only', since, 'HEAD', ...pathspec], { allowFailure: true }),
    git(['diff', '--name-only', ...pathspec], { allowFailure: true }),
    git(['diff', '--cached', '--name-only', ...pathspec], { allowFailure: true }),
    git(['status', '--porcelain', ...pathspec], { allowFailure: true })
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3)),
  ];
  const skip = (p) => !p || /\.md$/.test(p) || /(^|\/)docs\//.test(p);
  return [...new Set(sources.join('\n').split('\n').filter((p) => p && !skip(p)))].sort();
}

let failed = false;
for (const line of LINES) {
  const base = baseline[line.id];
  if (!base) {
    console.log(`✘ ${line.label}：version-baseline.json 缺 ${line.id} 基线`);
    failed = true;
    continue;
  }
  const since = newer(base, lastVersionBump(line.versionFile));
  const files = changedFiles(line.dirs, since);
  if (files.length === 0) {
    console.log(`✔ ${line.label} 无改动`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, line.versionFile), 'utf8'));
  const cur = pkg.version ?? null;
  const windowVersion = versionAt(since, line.versionFile);
  if (cur !== windowVersion) {
    console.log(`✔ ${line.label} 已升号 ${windowVersion ?? '?'} → ${cur}（${files.length} 个文件改动）`);
    continue;
  }
  failed = true;
  console.log(`✘ ${line.label}：${files.length} 个文件改动但 ${line.versionFile} 仍是 ${cur}（窗口 ${since.slice(0, 7)} 起）`);
  for (const f of files.slice(0, 5)) console.log(`    ${f}`);
}

process.exit(failed ? 1 : 0);
