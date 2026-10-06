import fs from 'node:fs';
import path from 'node:path';

import type { CoreHost } from './core-host.js';

/** 插件前端产物里真会出现的类型 */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * 插件前端产物托管：`GET /plugins/:id/*`。
 *
 * 关键：从 tab 目录的真实路径直送，**不复制进 dist**。
 * 一旦改成"构建期拷贝"，整个方案就退化成混合编译了（docs/architecture.md §5.3）。
 */
export function registerAssetRoutes(host: CoreHost): void {
  const { app, config } = host;

  app.get<{ Params: { id: string; '*': string } }>('/plugins/:id/*', async (request, reply) => {
    const id = request.params.id;
    const tab = config.tabs.get(id);
    if (tab === undefined) return reply.code(404).send({ error: `未知插件 ${id}` });

    const rel = request.params['*'];
    const target = path.resolve(tab.dir, rel);
    const guard = tab.dir.endsWith(path.sep) ? tab.dir : tab.dir + path.sep;
    if (!target.startsWith(guard)) {
      return reply.code(403).send({ error: '路径越界' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return reply.code(404).send({ error: `不存在 ${rel}` });
    }

    reply.type(MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
    // 插件产物随包更新，宿主不做缓存判断 —— 交给浏览器协商
    reply.header('cache-control', 'no-cache');
    return reply.send(fs.createReadStream(target));
  });
}
