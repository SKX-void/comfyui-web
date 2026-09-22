#!/usr/bin/env node
/**
 * 把 Vue / Vue Router 的**浏览器 ESM 构建**复制到 public/vendor/。
 *
 * 为什么需要这一步：宿主 index.html 里的 import map 必须给插件一个**真实存在的 URL**，
 * 插件的 bundle 里 `import { ref } from 'vue'` 才能被浏览器解析到**同一份** Vue 实例。
 * 两个 Vue 副本 = provide/inject、响应式、组件树全部失效。
 *
 * Vue 复制 dev/prod 两份：dev 用带警告的版本，构建产物用压缩版
 * （由 vite.config.ts 的 transformIndexHtml 替换 index.html 里的占位符）。
 *
 * ⚠️ vue-router **只复制 prod 版**，dev 版不能用：
 *   `vue-router.esm-browser.js` 第 7 行是 `import { setupDevtoolsPlugin } from "@vue/devtools-api"`，
 *   而浏览器里的 import map 没有这个包 —— 裸说明符解析失败，整个模块图挂掉，页面直接白屏。
 *   prod 版只依赖 `vue`（已在 map 里）。代价是少了 router 的 dev 警告，可以接受。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const outDir = path.join(appDir, 'public', 'vendor');

const FILES = [
  ['vue/dist/vue.esm-browser.js', 'vue.esm-browser.js'],
  ['vue/dist/vue.esm-browser.prod.js', 'vue.esm-browser.prod.js'],
  ['vue-router/dist/vue-router.esm-browser.prod.js', 'vue-router.esm-browser.prod.js'],
];

fs.mkdirSync(outDir, { recursive: true });

for (const [from, to] of FILES) {
  const source = path.join(appDir, 'node_modules', from);
  if (!fs.existsSync(source)) {
    console.error(`[vendor] 找不到 ${from}：先跑 pnpm install`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(outDir, to));
}

console.log(`[vendor] 已复制 ${FILES.length} 个共享运行时文件到 public/vendor/`);
