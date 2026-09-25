#!/usr/bin/env node
/**
 * 打包成目录型 tab：产物写进 tabs/anima-example/（宿主真正加载的就是它）。
 *
 * 本插件的服务端**不需要打包**：server.js 只 import node 内置模块和宿主句柄，
 * 拷过去就是可直接加载的产物（anima-plus 那套 14 个模块的旧服务才需要 esbuild）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packTab } from '../../../scripts/pack-tab.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));

await packTab({
  pluginDir,
  build: [['vite', ['build']]],
  extras: ['server.js', 'workflow.json'],
  watch: process.argv.includes('--watch'),
});
