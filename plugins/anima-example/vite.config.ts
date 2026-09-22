import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const clientSrc = fileURLToPath(new URL('./client/src', import.meta.url));

/**
 * 插件前端产物 = 一个自包含 ESM（`lib/client.js`）+ 一个 CSS（`lib/client.css`）。
 *
 * - `vue` / `vue-router` 必须 external：由宿主页面的 import map 提供**同一份**实例，
 *   打进产物就会出现两个 Vue，组件树直接崩；
 * - CSS 走 `lib/client.css`，插件运行期用 `import.meta.url` 定位后以 <link> 注入。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': clientSrc },
  },
  build: {
    outDir: 'lib',
    emptyOutDir: true,
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
