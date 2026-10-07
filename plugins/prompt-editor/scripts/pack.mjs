#!/usr/bin/env node
/**
 * 打包成目录型 tab：产物写进 tabs/prompt-editor/（宿主真正加载的就是它）。
 *
 * 两步：① esbuild 把 server/ 那十来个模块打成**一个** server.js ——
 * 重挂时宿主只给入口说明符加 `?v=<token>`，多文件的话兄弟模块会命中 Node 的 ESM 缓存
 * （理由见 build-server.mjs）；② vite 打前端 client.js + client.css（vue 走页面 import map，必须 external）。
 */
import { fileURLToPath } from 'node:url';

import { packTab } from '../../../scripts/pack-tab.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');

await packTab({
  pluginDir,
  build: [
    ['node', ['scripts/build-server.mjs', ...(watch ? ['--watch'] : [])]],
    ['vite', ['build']],
  ],
  // assets/ = 运行期资产：内置机翻表（danbooru-zh.csv）。服务端按 import.meta.url 找它，
  // 所以它必须躺在产物目录里（dist/ 整包搬走也带得上，LFS 只在源码 checkout 那一侧存在）。
  extras: ['README.md', 'assets'],
  watch,
});
