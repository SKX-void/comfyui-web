#!/usr/bin/env node
/**
 * 打包成目录型 tab：产物写进 tabs/anima-plus/。
 *
 * 两步：① esbuild 把 server/ 那 14 个模块打成**一个** server.js（理由见 build-server.mjs）；
 * ② vite 打前端 client.js + client.css（vue 走页面 import map，必须 external）。
 * 资产（assets/、readme.md）按"产物在 tab 根"的相对路径拷过去 —— 插件里
 * `new URL('./assets/', import.meta.url)` 就是照这个布局写的。
 */
import path from 'node:path';
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
  extras: ['assets', 'readme.md'],
  watch,
});
