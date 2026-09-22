#!/usr/bin/env node
/**
 * 把 v2 宿主**后端**打成单文件产物 `dist/host/host.mjs`。
 *
 * 为什么打包而不是 `tsc` 输出多文件：宿主要能"整包搬走"（一个文件 + profiles/ + data/），
 * 而且这是"宿主冻结"的物质保证 —— 插件永远不会进这份产物，所以加插件不需要重编。
 * 验收口径：装插件前后 `dist/host/**` 的 sha256 必须完全一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.resolve(appDir, '../../dist/host');

fs.mkdirSync(outDir, { recursive: true });
// 只清理自己的产物：dist/host/web/ 是前端构建的输出，不能被后端构建顺手删掉
for (const stale of ['host.mjs', 'host.mjs.map']) {
  fs.rmSync(path.join(outDir, stale), { force: true });
}

const result = await build({
  absWorkingDir: appDir,
  entryPoints: ['src/index.ts'],
  outfile: path.join(outDir, 'host.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // 产物态：config.ts 用产物所在目录当"仓库根"
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
