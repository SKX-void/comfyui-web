import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { AppError } from './errors.js';
import { RealComfyClient } from './comfy/real.js';
import { MockComfyClient } from './comfy/mock.js';
import type { ComfyClient } from './comfy/types.js';
import { TemplateRegistry } from './templates/loader.js';
import { JobManager } from './jobs/manager.js';
import { WeilinClient } from './weilin/client.js';
import { closeDatabase, openDatabase } from './store/db.js';
import { PresetStore } from './store/presets.js';
import { ThumbnailCache } from './weilin/thumb.js';
import { registerRoutes } from './http/routes.js';
import { MAX_BODY_BYTES } from './safety/quota.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // 启动阶段（Fastify 尚未创建）单独用 pino，方便加载模板时报错可读
  const bootLogger = pino({
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  });

  // 1. 模板：静态校验失败则整体启动失败（快速失败）
  const templates = new TemplateRegistry(config.templatesDir, (msg, meta) =>
    bootLogger.warn({ meta }, msg),
  );
  await templates.load();
  bootLogger.info(
    { count: templates.list().length, dir: config.templatesDir },
    '模板已加载',
  );

  // 2. 持久化（SQLite，用 Node 内置 node:sqlite，无原生依赖）
  const db = (() => {
    try {
      return openDatabase(config.dbFile, (msg, meta) => bootLogger.info({ meta }, msg));
    } catch (err) {
      // 容器部署最常见的坑：./data 是 docker 以 root 建的目录，容器里用 ${UID} 写不进去；
      // 或者 dataDir 指向了一个不存在的路径。原始报错是 ENOENT/EACCES + mkdir，太隐晦。
      throw new Error(
        `数据目录不可用: ${config.dataDir}\n  ${(err as Error).message}\n` +
          '  容器部署请先在宿主机执行 mkdir -p data（否则 docker 会以 root 建目录，容器里的 ${UID} 写不进去）',
      );
    }
  })();
  const presets = new PresetStore(db);
  bootLogger.info({ file: config.dbFile }, 'SQLite 已就绪');

  // 3. ComfyUI 客户端
  //    ⚠️ 所有任务共用同一个 client_id：ComfyUI 的进度只投递给提交者（v1-api.md §B.2）
  const clientId = randomUUID();
  const client: ComfyClient =
    config.comfyMode === 'mock'
      ? new MockComfyClient({
          stepDelayMs: config.mockStepDelayMs,
          log: (msg, meta) => bootLogger.debug({ meta }, `[mock] ${msg}`),
        })
      : new RealComfyClient({
          baseUrl: config.comfyBaseUrl,
          clientId,
          log: (msg, meta) => bootLogger.debug({ meta }, `[comfy] ${msg}`),
        });

  await client.start();
  bootLogger.info(
    {
      mode: client.mode,
      baseUrl: config.comfyBaseUrl,
      configFiles: config.configFiles.length > 0 ? config.configFiles : '(未找到 config.json，使用内置默认值)',
    },
    'ComfyUI 客户端已启动',
  );

  // 4. 任务编排
  const jobs = new JobManager(client, templates, {
    clientId,
    log: (msg, meta) => bootLogger.info({ meta }, msg),
  });
  jobs.start();

  // 4b. LoRA 预览缩略图缓存（WeiLin 原图 1~5MB，必须服务端缩）
  //     走 config.cacheDir 而不是写死 <repoRoot>/.cache：容器部署时应用目录是只读挂载的
  const thumbs = new ThumbnailCache(path.join(config.cacheDir, 'loras-thumbs'), (msg, meta) =>
    bootLogger.debug({ meta }, `[thumb] ${msg}`),
  );

  // 5. WeiLin 适配层（复用其注册在 ComfyUI 上的 REST 路由）
  const weilin = new WeilinClient({
    baseUrl: config.comfyBaseUrl,
    mode: config.comfyMode,
    log: (msg, meta) => bootLogger.debug({ meta }, `[weilin] ${msg}`),
  });
  const weilinStatus = await weilin.probe();
  if (weilinStatus.available) {
    bootLogger.info(
      { loras: weilinStatus.total, isLoading: weilinStatus.isLoading },
      'WeiLin 已就绪',
    );
  } else {
    bootLogger.warn(
      { message: weilinStatus.message },
      'WeiLin 不可用：标签/LoRA 面板将降级，出图链路不受影响',
    );
  }

  // 6. HTTP
  const app = Fastify({
    // 请求体上限：不做图生图，最大的正常请求就是提示词 + LoRA 列表（v1-safety.md §8）
    bodyLimit: MAX_BODY_BYTES,
    logger: {
      level: config.logLevel,
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }),
    },
  });
  await app.register(cors, { origin: true });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = randomUUID();
    if (err instanceof AppError) {
      reply.code(err.status);
      return reply.send({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          requestId,
        },
      });
    }
    if (err.statusCode === 400) {
      reply.code(400);
      return reply.send({
        error: { code: 'BAD_REQUEST', message: err.message, requestId },
      });
    }
    // Fastify 自己抛的 4xx（请求体过大、JSON 语法错误等）别一律当 500 报
    if (err.statusCode === 413) {
      reply.code(413);
      return reply.send({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KB）`,
          requestId,
        },
      });
    }
    req.log.error({ err, requestId }, '未处理的服务端错误');
    reply.code(500);
    return reply.send({
      error: { code: 'INTERNAL', message: err.message, requestId },
    });
  });

  await registerRoutes(app, { config, templates, jobs, client, weilin, thumbs, presets });

  // 7. 托管前端构建产物（若已 pnpm build）。开发期请用 pnpm dev:web（Vite 代理）。
  const webDist = config.webDir;
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // SPA 回退：非 /api 的未知路径交给前端路由
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404);
        return reply.send({
          error: { code: 'NOT_FOUND', message: `未知接口: ${req.url}` },
        });
      }
      return reply.sendFile('index.html');
    });
    bootLogger.info({ webDist }, '已托管前端构建产物');
  } else {
    bootLogger.info('未找到 apps/web/dist，仅提供 API（开发期请运行 pnpm dev:web）');
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { url: `http://${config.host}:${config.port}`, mode: config.comfyMode },
    '轻前端服务器已就绪',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '正在关闭');
    jobs.stop();
    await app.close();
    await client.stop();
    closeDatabase(db);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // 启动阶段失败：直接打印，方便定位
  console.error('\n启动失败:\n');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
