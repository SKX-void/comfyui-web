#!/usr/bin/env node
/**
 * 后端打包：把 `server/` 打成**一个** ESM 文件 `server.js`（写进 tab 目录，见 scripts/pack.mjs）。
 *
 *   pnpm --filter @comfyui-web/prompt-editor build:server
 *   → tabs/prompt-editor/server.js   （宿主按 tab 的 package.json 的 main 加载它）
 *
 * ## 为什么必须打包（原来是"拷源码就是产物"）
 *
 * 重挂 tab 时宿主只给**入口说明符**加 `?v=<token>`（apps/server/src/tabs-loader.ts），
 * 而入口里 `import './routes.js'` 这类兄弟模块解析出来的 URL **不带 query** ——
 * Node 的 ESM 缓存按 URL 记，于是"改完点重新扫描"会命中旧模块，D20 的承诺当场失效。
 * 打成单文件后：入口 URL 变 = 整个产物都变。
 *
 * ## 约束
 *
 * 1. **必须 ESM 输出**（tab 的 package.json 是 type: module）。
 * 2. **没有 external 清单**：本插件只 import node 内置模块，产物里不会出现动态 require。
 * 3. 源码是 .ts，但 esbuild **只剥类型、不做类型检查**；类型检查挂在 tsconfig.json 的
 *    `server/` 目录上，由 `pnpm typecheck` 的 vue-tsc 跑。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(pkgDir, 'server', 'index.ts')],
  // TAB_OUT_DIR 由 scripts/pack.mjs 指到 tabs/prompt-editor/；不经 pack 单独跑时退回本包 lib/
  outfile: path.join(process.env.TAB_OUT_DIR ?? path.join(pkgDir, 'lib'), 'server.js'),
  bundle: true,
  platform: 'node',
  // 与宿主一致：Node 24
  target: 'node24',
  format: 'esm',
  // 产物只有一个文件，不打 sourcemap
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[prompt-editor] 正在监听 server/ 的变化…');
} else {
  await build(options);
}
