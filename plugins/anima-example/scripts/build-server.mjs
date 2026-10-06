#!/usr/bin/env node
/**
 * 后端打包：把 `server/` 打成**一个** ESM 文件 `server.js`（写进 tab 目录，见 scripts/pack.mjs）。
 *
 *   pnpm --filter @comfyui-web/anima-example build:server
 *   → tabs/anima-example/server.js   （宿主按 tab 的 package.json 的 main 加载它）
 *
 * ## 为什么必须打包（原来是"拷源码就是产物"）
 *
 * 重挂 tab 时宿主只给**入口说明符**加 `?v=<token>`（apps/server/src/tabs-loader.ts），
 * 而入口里 `import './store.js'` 这类兄弟模块解析出来的 URL **不带 query** ——
 * Node 的 ESM 缓存按 URL 记，于是"改完点重新扫描"会命中旧模块，D20 的承诺当场失效。
 * 打成单文件后：入口 URL 变 = 整个产物都变。
 *
 * ## 约束
 *
 * 1. **必须 ESM 输出**。`workflow.ts` 用 `import.meta.url` 定位 `workflow.json`，
 *    CJS 输出下 esbuild 会把 `import.meta` 抹成 `{}`，路径立刻全乱。
 *    （源码是 .ts，但 esbuild **只剥类型、不做类型检查**；类型检查挂在 tsconfig.json 的
 *    server/ 目录上，由 `pnpm typecheck` 的 vue-tsc 跑。）
 * 2. **没有 external 清单**：本插件只 import node 内置模块（`node:sqlite` 也是内置），
 *    所以产物里不会出现动态 require，也不用 `createRequire` 那段 banner。
 * 3. **运行期资产不打进包**：`workflow.json` 由 `import.meta.url` 在运行时定位，
 *    换工作流不需要重新打包。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(pkgDir, 'server', 'index.ts')],
  // TAB_OUT_DIR 由 scripts/pack.mjs 指到 tabs/anima-example/；不经 pack 单独跑时退回本包 lib/
  outfile: path.join(process.env.TAB_OUT_DIR ?? path.join(pkgDir, 'lib'), 'server.js'),
  bundle: true,
  platform: 'node',
  // node:sqlite 需要 Node >= 22.5；产物按 Node 24 对齐（与宿主一致）
  target: 'node24',
  format: 'esm',
  // 产物只有一个文件，不打 sourcemap
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[anima-example] 正在监听 server/ 的变化…');
} else {
  await build(options);
}
