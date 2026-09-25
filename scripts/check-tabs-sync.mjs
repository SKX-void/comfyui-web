#!/usr/bin/env node
/**
 * 校验 tabs/ 里的产物确实能被宿主装载，且每个源码工程都构建过（D16/D17，见 docs/architecture.md §4.1、§14.5）。
 *
 * 为什么不比对 git：tabs/ 的子目录都是构建产物，**不入库**（.gitignore 里整个 tabs/ 只留 README 与 hello/），
 * 于是"产物与源码一致"只能靠结构性检查 —— 改了源码忘了构建，这里就会看到 tabs/<id>/ 缺文件、
 * 入口名对不上。逐字节一致性不查：构建字节稳定（16/16），宿主本来就按目录指纹装载，
 * 多一道 diff 不增加信息量。
 *
 * exit 1（产物不可装载 / 没构建）：
 *   - plugins/<id>/scripts/pack.mjs 存在，但 tabs/<id>/ 缺 package.json / server.js / client.js（或为空文件）
 *   - tabs/<id>/package.json 的 main 不是 server.js，或 plugin.client 不是 client.js
 *   - tabs/<id>/node_modules 存在（目录型 tab 必须自包含）
 * exit 0（只提示）：
 *   - 没有源码工程的 tab（手写或别人拷进来的：丢目录就能用，见 tabs/README.md）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsDir = path.join(root, 'tabs');
const pluginsDir = path.join(root, 'plugins');

/** 顶层子目录名（文件不算），排序保证输出稳定 */
function subdirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const problems = [];
const notices = [];

// 源码工程 = 带构建脚本的目录（不带脚本的可能只是共享代码，不产出 tab）
const sources = subdirs(pluginsDir).filter((id) => fs.existsSync(path.join(pluginsDir, id, 'scripts', 'pack.mjs')));
const withSource = new Set(sources);
const tabs = subdirs(tabsDir);

for (const id of sources) {
  const dir = path.join(tabsDir, id);
  for (const file of ['package.json', 'server.js', 'client.js']) {
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) {
      problems.push('tabs/' + id + '/' + file + ' 缺失：plugins/' + id + ' 还没构建（pnpm build:plugins）');
    } else if (fs.statSync(target).size === 0) {
      problems.push('tabs/' + id + '/' + file + ' 是空文件：构建没写完，或产物被清空');
    }
  }
  const manifest = path.join(dir, 'package.json');
  if (fs.existsSync(manifest)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.main !== 'server.js') {
        problems.push('tabs/' + id + '/package.json 的 main = ' + JSON.stringify(pkg.main) + '：宿主认死 server.js');
      }
      const client = pkg.plugin && pkg.plugin.client;
      if (client !== 'client.js') {
        problems.push(
          'tabs/' + id + '/package.json 的 plugin.client = ' + JSON.stringify(client) + '：前端入口认死 client.js',
        );
      }
    } catch (err) {
      problems.push('tabs/' + id + '/package.json 不是合法 JSON：' + err.message);
    }
  }
}

for (const id of tabs) {
  if (fs.existsSync(path.join(tabsDir, id, 'node_modules'))) {
    problems.push('tabs/' + id + '/node_modules：目录型 tab 必须自包含，第三方库要 bundle 进产物');
  }
}

const handwritten = tabs.filter((id) => !withSource.has(id));
if (handwritten.length > 0) {
  notices.push('没有源码工程、直接放在这儿的 tab（合法）：' + handwritten.join(' '));
}

if (problems.length === 0 && sources.length === 0) {
  problems.push('plugins/ 下没有任何带 scripts/pack.mjs 的源码工程：tabs-sync 无从校验');
}

for (const n of notices) console.log('· ' + n);
if (problems.length > 0) {
  console.log('✘ tabs/ 里的产物不可装载（' + problems.length + ' 处）：');
  for (const p of problems.slice(0, 12)) console.log('✘ ' + p);
  console.log('✘ 处理：pnpm build:plugins');
  process.exit(1);
}
console.log(
  '✔ tabs/ 与 plugins/* 对得上（' + sources.length + ' 个源码工程都有可装载的产物，另有 ' + handwritten.length + ' 个手写 tab）',
);
