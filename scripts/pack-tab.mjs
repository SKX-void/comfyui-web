#!/usr/bin/env node
/**
 * 把**插件源码目录**（plugins/<id>/）打包成**目录型 tab**（tabs/<id>/，D16）。
 *
 * 为什么要有这一步：tab 的要求是"目录里全是编译完的文件"（宿主不构建、也没有 node_modules），
 * 而源码工程（devDependencies + vite/esbuild）留在 plugins/<id>/。于是构建的产物目标就是
 * tabs/<id>/ —— 于是 tabs/ 里看到的就是宿主真正加载的东西，不存在"改了 lib/ 但宿主管不着"这种影子产物。
 * tabs/ 是构建产物、不入库（D17，见 docs/architecture.md §4.1）。
 *
 * 产物布局（tab 根就是入口所在）：
 *
 *   tabs/<id>/package.json   manifest：由源码 package.json 派生（只留宿主会读的字段）
 *   tabs/<id>/server.js      服务端入口（esbuild bundle，或直接拷源码）
 *   tabs/<id>/client.js     前端入口（vite build）+ client.css
 *   tabs/<id>/…              该插件自己声明的运行期资产（assets/、readme.md、workflow.json …）
 *
 * 约定（改这里之前先读）：
 * - **入口名固定** `server.js` / `client.js`，产物落在 tab 根 —— 插件里所有
 *   `new URL('./x', import.meta.url)` 都按"产物在 tab 根"来写（见 anima-plus 的 assets 路径）。
 * - 源码 manifest 里的 `plugin` 段（contract/title/order/settings）**原样带过去**，
 *   只把 client/入口路径改写成 tab 里的名字：字段形状只有一份，不抄第二份。
 * - 构建命令用插件自己的 node_modules/.bin（工作区里每个包都有）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/** tab 目录：目录名即 id（与插件目录同名），与宿主 tabs.ts 的约定一致 */
export function tabOutDir(pluginDir) {
  return path.join(repoRoot, 'tabs', path.basename(pluginDir));
}

/** 优先用插件自己的 .bin（pnpm 会在每个工作区包里放一份） */
function resolveBin(pluginDir, cmd) {
  const local = path.join(pluginDir, 'node_modules', '.bin', cmd);
  return fs.existsSync(local) ? local : cmd;
}

function copyInto(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyInto(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** 从源码 manifest 派生 tab 的 manifest：只留宿主会读的字段 */
function writeTabManifest(pkg, outDir) {
  const plugin = { ...(pkg.plugin ?? {}) };
  // 入口名固定为 tab 根下的 server.js / client.js（见文件头）
  plugin.client = 'client.js';
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: 'module',
    ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
    main: 'server.js',
    plugin,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return plugin.client;
}

/**
 * @param {{ pluginDir: string, extras?: string[], build?: Array<[string, string[]]>, watch?: boolean }} options
 *   extras: 相对插件目录的额外文件/目录（运行期资产）
 *   build:  [命令, 参数] 列表，按顺序在插件目录里跑（产物通过 TAB_OUT_DIR 指到 tab 目录）
 *   watch:  true = 各构建命令各自 watch（用于 pnpm dev），不阻塞返回
 */
export async function packTab({ pluginDir, extras = [], build = [], watch = false }) {
  const id = path.basename(pluginDir);
  const outDir = tabOutDir(pluginDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));

  // 先清空产物目录：extras 是"拷贝"而不是"同步"，源里删掉的文件在产物里会一直活着。
  // 踩过：assets/templates/ 删掉后，产物里仍留着旧副本，装载的其实是过期资产。
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const extra of extras) copyInto(path.join(pluginDir, extra), path.join(outDir, extra));
  writeTabManifest(pkg, outDir);

  const env = { ...process.env, TAB_OUT_DIR: outDir };
  const opts = { cwd: pluginDir, env, stdio: 'inherit' };
  const withWatch = (args) => (watch && !args.includes('--watch') ? [...args, '--watch'] : args);

  if (watch) {
    // watch 态：不等待（子进程活着，父进程就不会退出），由各自的 --watch 持续写产物
    for (const [cmd, args] of build) spawn(resolveBin(pluginDir, cmd), withWatch(args), opts);
    console.log('[pack-tab] ' + id + ' → watch 模式，产物写入 ' + path.relative(repoRoot, outDir));
    return outDir;
  }

  for (const [cmd, args] of build) {
    const r = spawnSync(resolveBin(pluginDir, cmd), args, opts);
    if (r.status !== 0) {
      throw new Error('[pack-tab] ' + id + '：' + cmd + ' ' + args.join(' ') + ' 退出码 ' + String(r.status));
    }
  }

  const files = fs.readdirSync(outDir).sort();
  console.log('[pack-tab] ' + id + ' → ' + path.relative(repoRoot, outDir) + '/  ' + files.join(' '));
  return outDir;
}
