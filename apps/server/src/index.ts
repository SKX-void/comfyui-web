import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pino, type Logger } from 'pino';

import { loadHostConfig, type LogFormat } from './config.js';
import { bootHost } from './kernel.js';

/**
 * pino-pretty 只在开发态可用（是 devDependency，打包产物/容器里解析不到）。
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

/** pino 的数字级别 → 名字（宿主不注册自定义级别，所以就是这几个） */
const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** 已经进了前缀、或纯属噪音的字段，text 行里不再重复 */
const TEXT_SKIP = new Set(['level', 'time', 'pid', 'hostname', 'msg']);

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 一条 pino JSON 记录 → 一行文本；解析不出来就原样透传（绝不吞日志） */
function textLine(raw: string): string {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const at = typeof rec.time === 'number' ? new Date(rec.time) : new Date();
  const stamp = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;

  const fields: string[] = [];
  let stack = '';
  for (const [key, value] of Object.entries(rec)) {
    if (TEXT_SKIP.has(key)) continue;
    if (key === 'err' && value !== null && typeof value === 'object') {
      const err = value as { message?: unknown; stack?: unknown };
      fields.push(`err=${typeof err.message === 'string' ? err.message : JSON.stringify(value)}`);
      if (typeof err.stack === 'string') stack = err.stack;
      continue;
    }
    const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    fields.push(`${key}=${text}`);
  }

  const level = LEVEL_NAMES[Number(rec.level)] ?? String(rec.level);
  const msg = typeof rec.msg === 'string' ? rec.msg : '';
  const head = `[${stamp}] ${level}: ${msg}${fields.length > 0 ? `  ${fields.join(' ')}` : ''}`;
  // 栈另起一段缩进：塞进同一行就没人看了
  return stack === '' ? head : `${head}\n${stack.split('\n').map((l) => `    ${l}`).join('\n')}`;
}

/**
 * 自带的 `text` 格式：**不依赖 pino-pretty**（它是 devDependency，产物态/容器里解析不到），
 * 所以 `COMFYUI_WEB_LOG_FORMAT=text` 在 docker 里也能拿到给人看的日志 —— 加它的理由就是这个。
 */
function textDestination(): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const lines: string[] = [];
      for (const raw of String(chunk).split('\n')) {
        if (raw.trim() !== '') lines.push(textLine(raw));
      }
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
      callback();
    },
  });
}

/** 三种格式的落地：`text` = 自带 formatter；`default` = 能 pretty 就 pretty；`json` = 不加任何东西 */
function createLogger(level: string, format: LogFormat): Logger {
  if (format === 'text') return pino({ level }, textDestination());
  const transport = format === 'default' ? prettyTransport() : undefined;
  return pino({ level, ...(transport !== undefined ? { transport } : {}) });
}

async function main(): Promise<void> {
  // 配置先于日志：logLevel 就住在 data/host.json 里。这条调用还会**初始化空 data 卷**
  // （建 data/plugins/、写默认 host.json），所以宿主起来不需要任何"先跑个脚本"的前置。
  const loaded = loadHostConfig();
  const config = loaded.config;
  const logger = createLogger(config.logLevel, config.logFormat);

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
    // Fastify 自带的 request 日志是 **info** 级：默认级别就是 info，于是每个请求两行，
    // 把启动信息和真正的错误全淹掉。关掉它，下面用同一套字段自己记（成功 debug、4xx warn、5xx error）。
    // 注意：顶层的 `disableRequestLogging` 在 fastify 5.12 已废弃（FSTDEP023，6.0 删除），
    // 现在必须传一个 LogController 实例。
    logController: new LogController({ disableRequestLogging: true }),
    // 插件的 SSE（任务事件流）是 `reply.hijack()` 后永不结束的响应。fastify 5 的
    // forceCloseConnections 默认是 'idle'（只关空闲连接），这类**活跃**请求会让
    // app.close() 永不返回 —— 退出时表现为"打完中断后挂住"。见下面的 shutdown。
    forceCloseConnections: true,
  }) as unknown as FastifyInstance;

  // 字段形状照抄 Fastify 的（req / res / responseTime）：request.log 上挂着它的 req/res 序列化器，
  // 所以直接传 request / reply 就能得到同样干净的输出。
  app.addHook('onRequest', (request, _reply, done) => {
    request.log.debug({ req: request }, 'incoming request');
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const line = { res: reply, responseTime: reply.elapsedTime };
    if (reply.statusCode >= 500) request.log.error(line, 'request failed');
    else if (reply.statusCode >= 400) request.log.warn(line, 'request rejected');
    else request.log.debug(line, 'request completed');
    done();
  });
  // `disableRequestLogging` 把 defaultErrorLog 一起关了（它也看这个开关），所以错误的
  // message/stack 得在这里补回来 —— 否则失败只剩一行状态码，等于把线索删了。
  app.addHook('onError', (request, reply, error, done) => {
    if (reply.statusCode >= 500) request.log.error({ err: error }, error.message);
    else request.log.warn({ err: error }, error.message);
    done();
  });

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
