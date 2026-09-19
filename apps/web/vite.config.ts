import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 后端端口**只从 config.json 读**，保证与后端配置永远一致。
 * 要换端口就改 config.json 的 `port` —— 不要再在这里或环境变量里维护第二份，
 * 两处事实来源必然漂移（本文件早期版本就踩过这个坑）。
 */
function readBackendPort(): number {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8');
    // 只提取 port 字段：不需要完整 JSONC 解析，且不会误匹配字符串里的 URL
    const m = /"port"\s*:\s*(\d+)/.exec(raw);
    return m ? Number(m[1]) : 8080;
  } catch {
    return 8080;
  }
}

const apiTarget = `http://127.0.0.1:${readBackendPort()}`;

/**
 * Vite 的 Host 校验（防 DNS rebinding）：用容器名/自定义域名访问时会被拦下，
 * 报 `Blocked request. This host ("xxx") is not allowed.`
 *
 * 默认只放行常见开发主机名（含本容器名 dsh-env）。从其它主机名访问时：
 *   VITE_ALLOWED_HOSTS=my.host pnpm dev:web     # 追加指定主机
 *   VITE_ALLOWED_HOSTS='*' pnpm dev:web         # 全部放行（仅限可信内网）
 */
const allowedHosts = (() => {
  const raw = process.env.VITE_ALLOWED_HOSTS;
  if (!raw) return ['dsh-env', 'localhost', '.local'];
  if (raw.trim() === '*') return true;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
})();

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    /**
     * 前端产物直接落到**仓库根的 `dist/web`**，与后端单文件 `dist/server.mjs` 并列：
     *
     *   dist/
     *   ├── server.mjs     ← esbuild 产物
     *   └── web/           ← vite 产物（index.html + assets/）
     *
     * 这样"前端目录"相对服务端就是一个**固定路径**（`<server.mjs 所在目录>/web`），
     * 整个 dist/ 可以整体搬走部署，不需要任何额外的路径配置。
     */
    outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)),
    // 清空的是 dist/web 本身，不会碰到旁边的 server.mjs
    emptyOutDir: true,
  },
  server: {
    // 监听所有网卡，便于从其它机器访问（局域网调试）
    host: '0.0.0.0',
    port: 5173,
    // 端口被占用时直接失败，而不是悄悄换到 5174 —— 避免访问错端口
    strictPort: true,
    allowedHosts,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // SSE（/api/jobs/:id/events）需要长连接，禁用代理侧缓冲
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
});
