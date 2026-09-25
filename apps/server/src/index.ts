import fs from 'node:fs';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pino } from 'pino';

import { loadHostConfig } from './config.js';
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
  // 配置先于日志：logLevel 就住在 data/host.json 里。这条调用还会**初始化空 data 卷**
  // （建 data/plugins/、写默认 host.json），所以宿主起来不需要任何"先跑个脚本"的前置。
  const loaded = loadHostConfig();
  const config = loaded.config;
  const transport = prettyTransport();

  const logger = pino({
    level: config.logLevel,
    ...(transport !== undefined ? { transport } : {}),
  });

  if (loaded.dataDirCreated) {
    logger.info({ dataDir: config.dataDir }, '数据目录不存在，已创建（插件空间 data/plugins/）');
  }
  if (loaded.settingsCreated) {
    logger.info({ settingsFile: config.settingsFile }, '配置文件不存在，已写入默认值');
  } else if (loaded.settingsProblem !== undefined) {
    // 读不出来就用默认值跑，但**不动原文件** —— 用户手写的错误不该被静默重置
    logger.warn(
      { settingsFile: config.settingsFile, problem: loaded.settingsProblem },
      '配置文件读不出来，本次用内置默认值（原文件未改动）',
    );
  }
  if (loaded.migratedLegacyPrefs !== undefined) {
    logger.info(
      { from: loaded.migratedLegacyPrefs, to: config.settingsFile },
      '已把旧的 ui-prefs.json 搬进 host.json（旧文件保留，确认无误后自己删）',
    );
  }

  // 传 pino 实例会让 FastifyInstance 带上具体 logger 泛型，与句柄里用的默认
  // FastifyInstance 不兼容；宿主的日志实例与框架类型解耦，这里统一收敛到默认类型。
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 4 * 1024 * 1024,
  }) as unknown as FastifyInstance;

  const host = await bootHost({
    app,
    dataDir: config.dataDir,
    tabsDir: config.tabsDir,
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
    '宿主已启动',
  );
}

main().catch((err: unknown) => {
  // 启动期失败：直接打原始栈，不要被日志格式吞掉
  console.error(err);
  process.exit(1);
});
