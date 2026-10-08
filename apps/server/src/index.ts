import fs from 'node:fs';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pino } from 'pino';

import { loadHostConfig, type LogFormat } from './config.js';
import { bootHost } from './kernel.js';

/**
 * pino-pretty 只在开发态可用（是 devDependency，打包产物里解析不到）。
 * 解析不到就退回 JSON 日志 —— 而不是让宿主起不来。
 *
 * `COMFYUI_WEB_LOG_FORMAT=json` 直接跳过这条路径（采集器只认 JSON，也别为一个 worker 花钱）。
 */
function prettyTransport(format: LogFormat): { target: string; options: Record<string, unknown> } | undefined {
  if (format === 'json') return undefined;
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
  const transport = prettyTransport(config.logFormat);

  const logger = pino({
    level: config.logLevel,
    ...(transport !== undefined ? { transport } : {}),
  });

  // 级别/格式的环境变量写错了：回落默认值跑，但必须让人看见（不然"我明明设了 debug"会变成悬案）
  for (const problem of loaded.logProblems ?? []) {
    logger.warn(problem);
  }

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
    // 插件的 SSE（任务事件流）是 `reply.hijack()` 后永不结束的响应。fastify 5 的
    // forceCloseConnections 默认是 'idle'（只关空闲连接），这类**活跃**请求会让
    // app.close() 永不返回 —— 退出时表现为"打完中断后挂住"。见下面的 shutdown。
    forceCloseConnections: true,
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
    // wildcard 必须开着（默认值）：它按**请求**现读磁盘。
    // 曾经写成 `wildcard: false` —— 那会在启动时 glob 一遍、只给当时存在的文件登记路由，
    // 于是"重新 build:web 后刷新"这个最正常的动作会碎：vite 换掉 hash 文件名，新文件没有
    // 路由 → 落到下面的 notFoundHandler → 用 index.html 冒充 CSS，浏览器报
    // "MIME type text/html is not text/css"，整个外壳的样式全丢（实测复现）。
    // 文件真不存在时 fastify-static 会 `reply.callNotFound()`，所以 SPA 兜底仍走下面那条。
    await app.register(fastifyStatic, { root: config.webDir });
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

  /**
   * 退出：先卸插件树，再关 HTTP。
   *
   * 两条都是踩过的坑：
   * - 信号会来好几次（连按 Ctrl+C、或 cmd 的 "Terminate batch job"）：重复进入会让
   *   dispose/close 并发跑，所以第二次信号直接强退。
   * - 任何一步都可能卡住（SSE 那条见 Fastify 的 forceCloseConnections），所以兜一个超时：
   *   用户按了 Ctrl+C 就不该再等。
   */
  const SHUTDOWN_TIMEOUT_MS = 5_000;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, '再次收到退出信号，强制退出');
      process.exit(0);
    }
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，正在卸载');

    // 兜底：正常路径会 clearTimeout，这里只是"卡住也不吊着用户"。
    // unref 是为了它自己不成为活锁——真卡住时是别的句柄撑着事件循环。
    const hardExit = setTimeout(() => {
      logger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, '卸载超时，强制退出');
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();

    try {
      await host.dispose();
      await app.close();
    } catch (err) {
      logger.warn({ err: String(err) }, '卸载时出错');
    } finally {
      clearTimeout(hardExit);
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
