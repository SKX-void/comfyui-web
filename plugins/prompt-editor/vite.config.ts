import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const clientSrc = fileURLToPath(new URL('./client/src', import.meta.url));

/**
 * 前端产物 = 一个自包含 ESM（`client.js`）+ 一个 CSS（`client.css`），落在 tab 目录
 * （`TAB_OUT_DIR` 由 scripts/pack.mjs 传入）。
 *
 * `vue` / `vue-router` 必须 external：宿主页面的 import map 提供**同一份实例**
 * （两个 Vue 副本会让 provide/inject 与组件树全部失效，见 docs/architecture.md §7.1）。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': clientSrc },
  },
  build: {
    // tab 目录里还住着 pack.mjs 放好的 server.js / package.json，不能清空它
    outDir: process.env.TAB_OUT_DIR ?? 'lib',
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./client/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: ['vue', 'vue-router'],
      output: {
        assetFileNames: 'client.[ext]',
      },
    },
  },
});
