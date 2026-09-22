#!/usr/bin/env node
/**
 * 统一验证入口：一条命令跑完 typecheck / smoke / build，每步只输出一行结论。
 *
 * 为什么要有它：单独跑这几条命令，光 smoke 一次就 190+ 行、近 10 KB，
 * 全量日志灌进上下文/终端既慢又难看出到底哪步挂了。这里把各步完整输出
 * 落到 .cache/verify/<step>.log，终端只留结论；失败时自动从日志里摘出
 * 失败行回显，需要细节再去看日志文件。
 *
 * 用法：
 *   pnpm verify                     # typecheck → smoke → build
 *   pnpm verify typecheck smoke     # 只跑指定步骤
 *   pnpm verify --no-build          # 跳过构建
 *   pnpm verify --verbose           # 额外把各步完整输出回显到终端
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, '.cache', 'verify');

/**
 * 步骤定义，数组顺序即执行顺序。failRe/failLimit 决定失败时从日志摘哪些行回显。
 * smoke 强制 SMOKE_VERBOSE=1：输出本来就重定向进日志文件，日志里留全量才便于排查。
 */
const STEPS = [
  {
    id: 'typecheck',
    cmd: 'pnpm',
    args: ['-r', 'typecheck'],
    env: {},
    failRe: /error TS\d+|✘/,
    failLimit: 12,
  },
  {
    id: 'smoke',
    cmd: 'pnpm',
    args: ['smoke'],
    env: { SMOKE_VERBOSE: '1' },
    failRe: /✘/,
    failLimit: 20,
  },
  {
    id: 'build',
    cmd: 'pnpm',
    args: ['build'],
    env: {},
    failRe: /\[ERROR\]|error TS\d+|error during build|✘/i,
    failLimit: 12,
  },
];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const picked = argv.filter((a) => !a.startsWith('-'));
const VERBOSE = flags.has('--verbose') || flags.has('-v');

const known = STEPS.map((s) => s.id);
const unknown = picked.filter((p) => !known.includes(p));
if (unknown.length > 0) {
  console.error(`未知步骤：${unknown.join(', ')}（可选：${known.join(' / ')}）`);
  process.exit(2);
}

let steps = picked.length > 0 ? STEPS.filter((s) => picked.includes(s.id)) : STEPS;
if (flags.has('--no-build')) steps = steps.filter((s) => s.id !== 'build');
if (steps.length === 0) {
  console.error('没有要执行的步骤');
  process.exit(2);
}

const rel = (p) => path.relative(root, p) || '.';

/** 同步跑一步，stdout+stderr 一起重定向到日志文件；返回退出码与耗时 */
function runStep(step) {
  const logFile = path.join(logDir, `${step.id}.log`);
  const fd = fs.openSync(logFile, 'w');
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(step.cmd, step.args, {
        cwd: root,
        env: { ...process.env, ...step.env },
        stdio: ['ignore', fd, fd],
      });
    } catch (err) {
      fs.closeSync(fd);
      resolve({ code: 127, ms: Date.now() - t0, logFile, spawnError: err });
      return;
    }
    child.on('error', (err) => {
      fs.closeSync(fd);
      resolve({ code: 127, ms: Date.now() - t0, logFile, spawnError: err });
    });
    child.on('close', (code) => {
      fs.closeSync(fd);
      resolve({ code: code ?? 1, ms: Date.now() - t0, logFile });
    });
  });
}

/** 从日志里摘出失败行；摘不到就退回最后几行，避免“什么都没说” */
function failureSummary(step, logFile) {
  const text = fs.readFileSync(logFile, 'utf8');
  const lines = text.split('\n').map((l) => l.trimEnd());
  const hits = lines.filter((l) => step.failRe.test(l)).slice(0, step.failLimit);
  if (hits.length > 0) return hits;
  return lines.filter((l) => l.trim() !== '').slice(-8);
}

fs.mkdirSync(logDir, { recursive: true });

console.log(`▶ verify（${steps.map((s) => s.id).join(' → ')}）`);

const done = [];
let failed = false;

for (const step of steps) {
  const r = await runStep(step);
  const secs = (r.ms / 1000).toFixed(1);
  const ok = r.code === 0 && !r.spawnError;

  console.log(`${ok ? '✔' : '✘'} ${step.id.padEnd(10)}${secs.padStart(7)}s`);

  if (VERBOSE) {
    const body = fs.readFileSync(r.logFile, 'utf8');
    if (body.trim() !== '') console.log(body.replace(/\n+$/, ''));
  }

  if (!ok) {
    console.log(`  ├ 完整日志：${rel(r.logFile)}`);
    if (r.spawnError) console.log(`  │ 无法启动命令：${r.spawnError.message}`);
    for (const line of failureSummary(step, r.logFile)) console.log(`  │ ${line}`);
    console.log(`❌ verify 失败：${step.id}（${done.length}/${steps.length} 步已完成）`);
    failed = true;
    break;
  }
  done.push(r);
}

if (!failed) {
  const totalSecs = (done.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);
  console.log(`✅ verify 通过（${steps.length} 步，${totalSecs}s）· 日志 ${rel(logDir)}/`);
}

process.exit(failed ? 1 : 0);
