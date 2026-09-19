#!/usr/bin/env node
/**
 * 服务端打包：把 apps/server 打成**一个** ESM 文件。
 *
 *   pnpm --filter @comfyui-server/server bundle
 *   → apps/server/dist/server.mjs   （不需要 node_modules 就能跑）
 *
 * 它是"一个进程同时当 API 服务器 + 前端静态文件服务器"：
 *   node apps/server/dist/server.mjs
 * 前端产物在 apps/web/dist（先跑 vite build），由 @fastify/static 托管。
 *
 * 几条必须记住的约束（每条都对应一个真实的坑）：
 *
 * 1. **必须是 ESM 输出**。源码用 `import.meta.url` 定位仓库根目录（config.ts），
 *    CJS 输出下 esbuild 会把 `import.meta` 抹成 `{}`，所有路径立刻全乱。
 *
 * 2. **NODE_ENV 固化进产物**。pino 的 transport 是运行时按**模块名** spawn
 *    worker 线程加载的（pino-pretty），打不进包里；固化成 production 之后
 *    这条分支根本不会走。开发用 tsx 跑源码，日志照样是彩色的。
 *
 * 3. **pino-pretty / bufferutil / utf-8-validate 必须标 external**。
 *    后两个是 ws 的可选原生加速件，没装就走纯 JS —— 不标 external，
 *    esbuild 会因为"解析不到"直接构建失败。
 *
 * 4. **运行期数据不打进包**：config.json / templates/ / .data/ / 前端 dist
 *    都由 config.ts 在运行时按目录定位。所以换模板、改配置、重新构建前端
 *    都不需要重新打后端。
 *
 * 5. **sharp 是变量形式的动态 import**（weilin/thumb.ts 里的可选依赖），
 *    esbuild 不分析它，运行期 import 失败会被 catch 掉，降级为"不缩放"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const repoRoot = path.resolve(pkgDir, '..', '..');
const distDir = path.join(repoRoot, 'dist');
const outFile = path.join(distDir, 'server.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

const externals = [
  // pino 的 transport 目标：运行时按名字解析，必须外置（见文件头 §2）
  'pino-pretty',
  // ws 的可选原生加速件
  'bufferutil',
  'utf-8-validate',
];

const result = await build({
  entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  // node:sqlite 需要 Node >= 22.5（无 flag 需要 >= 23.4），产物按 Node 24 对齐
  target: 'node24',
  format: 'esm',
  // 不生成 .map：产物就一个文件，要 sourcemap 请临时加 --sourcemap 自行构建
  sourcemap: false,
  define: {
    'process.env.NODE_ENV': '"production"',
    // 告诉 config.ts "我现在是打包产物"，它据此决定目录解析基准
    __BUNDLED__: 'true',
  },
  external: externals,
  // 让 `import type` 之外的遗留 CJS 包在动态 require 时也能工作
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  metafile: true,
  logLevel: 'warning',
});

const bytes = fs.statSync(outFile).size;
const inputs = Object.keys(result.metafile.inputs).length;
const bundled = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules'));

/**
 * 模板跟着产物走。
 *
 * 模板不是"用户数据"，而是**强代码耦合的配置**：`template.json` 里的 bindings 直接
 * 指向 graph 的节点/字段，`requirements.nodes` 指向具体的节点类，transform 名字要能在
 * transforms.ts 里找到 —— 模板与 server 必须同版本。所以打进 dist/，与 server.mjs 锁在一起，
 * 部署时不需要单独挂载（要热改模板时再用 TEMPLATES_DIR 指到外面）。
 */
const templatesSrc = path.join(repoRoot, 'templates');
const templatesDst = path.join(distDir, 'templates');
if (fs.existsSync(templatesSrc)) {
  fs.rmSync(templatesDst, { recursive: true, force: true });
  fs.cpSync(templatesSrc, templatesDst, { recursive: true });
}
const templateCount = fs.existsSync(templatesDst) ? fs.readdirSync(templatesDst).length : 0;
const webIndex = path.join(distDir, 'web', 'index.html');

const rel = (p) => path.relative(repoRoot, p);
console.log('✔ 构建完成，dist/ 是**自包含**的（可整体搬走部署）\n');
console.log('  dist/');
console.log(`  ├── server.mjs   ${(bytes / 1024 / 1024).toFixed(2)} MB · ${inputs} 个模块（${bundled.length} 个来自 node_modules）`);
console.log(
  fs.existsSync(webIndex)
    ? '  ├── web/         前端静态产物（vite build）'
    : '  ├── web/         ⚠️ 不存在 —— 先跑 pnpm build:web（前端产物由 vite 生成）',
);
console.log(`  └── templates/   ${templateCount} 个模板（与 server.mjs 版本锁定）`);
console.log(`\n  运行：node ${rel(outFile)}`);
console.log(`  前端目录固定为 <server.mjs 所在目录>/web → ${rel(path.join(distDir, 'web'))}/`);
console.log(`  外置（运行时才需要）：${externals.join(', ')}`);
console.log(
  `  运行时按目录读取：config.json / dataDir / cacheDir（基准 = ${rel(repoRoot) || '.'}，可用 REPO_ROOT 覆盖）`,
);
console.log(`  版本：${pkg.name}@${pkg.version}`);
