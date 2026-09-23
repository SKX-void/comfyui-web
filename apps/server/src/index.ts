import fs from 'node:fs';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pino } from 'pino';

import { loadHostConfig, profileDir, profileManifest, profileManifestTemplate } from './config.js';
import { bootHost } from './kernel.js';

/**
 * pino-pretty 只在开发态可用（是 devDependency，打包产物里解析不到）。
 * 解析不到就退回 JSON 日志 —— 而不是让宿主起不来。
 */
function prettyTransport(): { target: string; options: Record<string, unknown> } | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
}

async function main(): Promise<void> {
  const config = loadHostConfig();
  const transport = prettyTransport();

  const logger = pino({
    level: config.logLevel,
    ...(transport !== undefined ? { transport } : {}),
  });

  // 传 pino 实例会让 FastifyInstance 带上具体 logger 泛型，与句柄里用的默认
  // FastifyInstance 不兼容；宿主的日志实例与框架类型解耦，这里统一收敛到默认类型。
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 4 * 1024 * 1024,
  }) as unknown as FastifyInstance;

  const dir = profileDir(config);
  const manifest = profileManifest(config);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 清单是**本机部署状态**（不入库），入库的是剥掉部署值的模板。清单缺失就从模板复制一份：
  // Include 拿到不存在的文件会抛 ConfigFileError 直接让宿主起不来，所以这一步必须在这里兜住
  // （新克隆、新 profile、或换了台机器只搬了仓库文件时都会走到）。
  const template = profileManifestTemplate(config);
  if (!fs.existsSync(manifest)) {
    if (fs.existsSync(template)) {
      fs.copyFileSync(template, manifest);
      logger.info({ manifest, template }, '清单不存在，已从模板复制（本机部署状态，不入库）');
    } else {
      logger.error(
        { manifest, template },
        '既没有清单也没有模板：插件树挂载会失败。跑 `pnpm plugin add <包>` 或 `pnpm plugin snapshot` 生成一个',
      );
    }
  }

  const host = await bootHost({
    app,
    profile: config.profile,
    profileDir: dir,
    manifestFile: manifest,
    dataDir: config.dataDir,
    logger,
  });

  // 宿主前端产物：存在才托管（开发态由 vite dev server 提供）
  const hasWeb = fs.existsSync(config.webDir) && fs.existsSync(`${config.webDir}/index.html`);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? '';
      if (url.startsWith('/api') || url.startsWith('/plugins')) {
        return reply.code(404).send({ error: `未找到 ${url}` });
      }
      return reply.sendFile('index.html');
    });
    logger.info({ webDir: config.webDir }, '已托管宿主前端产物');
  } else {
    app.setNotFoundHandler((request, reply) => {
      void request;
      return reply.code(404).send({ error: '宿主前端未构建（开发态请用 vite dev server）' });
    });
    logger.warn(
      { webDir: config.webDir },
      '未找到宿主前端产物：只提供 API（跑 pnpm build:web 生成）',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '收到退出信号，正在卸载');
    try {
      await host.dispose();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}` },
    'v2 宿主已启动',
  );
}

main().catch((err: unknown) => {
  // 启动期失败：直接打原始栈，不要被日志格式吞掉
  console.error(err);
  process.exit(1);
});
