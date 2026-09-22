#!/usr/bin/env node
/**
 * 后端打包：把 `plugins/anima-plus/server/` 打成**一个** ESM 文件 `lib/server.js`。
 *
 *   pnpm --filter @comfyui-web/anima-plus build:server
 *   → plugins/anima-plus/lib/server.js    （宿主按 package.json 的 main 加载它）
 *
 * ## 为什么本插件要打包（anima-example 就没有这一步）
 *
 * 这里搬进来的是旧服务的一整套后端（~2800 行 / 14 个文件），逐字搬运比照着重写一遍
 * 安全得多 —— 尤其是 `safety/limits.ts` 那份 657 行的显存护栏。打包让这些文件保持原状
 * （原样的 `.ts` + `.js` 后缀相对导入），一行都不用为了"免构建"而改。
 *
 * ## 约束（每条都对应一个真实的坑）
 *
 * 1. **必须 ESM 输出**。`server/index.ts` 用 `import.meta.url` 定位 `assets/`，
 *    CJS 输出下 esbuild 会把 `import.meta` 抹成 `{}`，路径立刻全乱。
 * 2. **ws 的可选原生加速件必须标 external**：没装时 esbuild 会因为解析不到直接构建失败。
 * 3. **图像编解码是纯 JS 依赖**（`purejsimage`，见 `weilin/thumb-codec.ts`）：它会被完整打进
 *    产物（`lib/server.js` 因此从 232KB 涨到 785KB）。**不要再引入原生模块**（sharp 之类）——
 *    `.node` 没法内联，单文件交付这条就断了。
 * 4. **运行期资产不打进包**：`assets/templates/` 由 `import.meta.url` 在运行时定位，
 *    所以换模板不需要重新打包。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(pkgDir, 'server', 'index.ts')],
  outfile: path.join(pkgDir, 'lib', 'server.js'),
  bundle: true,
  platform: 'node',
  // node:sqlite 需要 Node >= 22.5；产物按 Node 24 对齐（与宿主一致）
  target: 'node24',
  format: 'esm',
  // 产物只有一个文件，不打 sourcemap
  sourcemap: false,
  // ws 的可选原生加速件（见文件头 §2）
  external: ['bufferutil', 'utf-8-validate'],
  // 让被 bundle 进来的遗留 CJS 包（ws / fastify 等）在动态 require 时也能工作。
  // 少了这一行，宿主加载插件时会直接报 `Dynamic require of "events" is not supported`
  // —— ESM 输出里没有 require，esbuild 只能把它留成裸调用。
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[anima-plus] 正在监听 server/ 与 client/ 的变化…');
} else {
  await build(options);
}
