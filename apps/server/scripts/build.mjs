#!/usr/bin/env node
/**
 * 把宿主**后端**打成单文件产物 `dist/app/server.mjs`。
 *
 * 为什么打包而不是 `tsc` 输出多文件：宿主要能"整包搬走"（dist/ 一个目录就是完整结构：
 * app/server.mjs + app/web/ + tabs/ + data/），而且这是"宿主冻结"的物质保证 ——
 * 插件永远不会进这份产物，所以加插件不需要重编。
 * 验收口径：装插件前后 `dist/app/**` 的 sha256 必须完全一致。
 *
 * 不带 sourcemap：产物要直接进镜像，3.4MB 的 map 只有本地调试用得上，而本地跑的是 tsx。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.resolve(appDir, '../../dist/app');

fs.mkdirSync(outDir, { recursive: true });
// 旧布局 dist/host/ 整个退役：留着会让人以为还能 `node dist/host/host.mjs`
fs.rmSync(path.resolve(appDir, '../../dist/host'), { recursive: true, force: true });
// 只清理自己的产物：dist/app/web/ 是前端构建的输出，不能被后端构建顺手删掉
for (const stale of ['server.mjs', 'host.mjs', 'host.mjs.map']) {
  fs.rmSync(path.join(outDir, stale), { force: true });
}

const result = await build({
  absWorkingDir: appDir,
  entryPoints: ['src/index.ts'],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  // 产物态：config.ts 用产物上级目录（dist/）当"仓库根"
  define: { __BUNDLED__: 'true' },
  // 动态 require / 可选依赖不要拖进来
  external: ['pino-pretty'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs).map(
  ([file, info]) => `  ${path.relative(appDir, file)}  ${(info.bytes / 1024).toFixed(1)} kB`,
);
console.log(`[build] 已生成宿主后端（${outputs.length} 个文件）：\n${outputs.join('\n')}`);
