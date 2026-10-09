#!/usr/bin/env node
/**
 * 后端打包：把 `server/` 打成**一个** ESM 文件 `server.js`（写进 tab 目录）。
 *
 * 必须打包的原因见 plugins/README.md §2.4：重挂只给**入口**说明符加 `?v=`，
 * 入口里 `import './comfy.js'` 解析出来的 URL 不带 query，会命中 Node 的 ESM 缓存。
 *
 * 约束：ESM 输出（`workflow.ts` 用 `import.meta.url` 定位 workflow.json，CJS 下会被抹掉）；
 * 只 import node 内置模块，所以没有 external 清单、也不需要 createRequire banner。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(pkgDir, 'server', 'index.ts')],
  outfile: path.join(process.env.TAB_OUT_DIR ?? path.join(pkgDir, 'lib'), 'server.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[image-reverse-inference] 正在监听 server/ 的变化…');
} else {
  await build(options);
}
