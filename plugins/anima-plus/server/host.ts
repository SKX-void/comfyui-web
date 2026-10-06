/**
 * 宿主句柄的最小类型 + 适配层（把宿主给的 fastify 实例伪装成插件要的形状）。
 *
 * 插件**不 import cordis、也不 import 宿主源码** —— 引了就等于把宿主内部形状写进插件产物，
 * 所以按用到的成员手写一份（与 `anima-example/server/types.ts` 同一写法）。
 * 组装根在 `index.ts`。
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { AppError } from './errors.js';
import { MAX_BODY_BYTES } from './safety/quota.js';

// ---------------------------------------------------------------------------
// 宿主句柄的最小类型（插件不 import cordis，也不 import 宿主源码）
// ---------------------------------------------------------------------------

export type RouteHandler = (request: any, reply: any) => unknown;

export interface PluginRoutes {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  all(path: string, handler: RouteHandler): void;
}

export interface PluginSpace {
  packageName: string;
  root: string;
  resolve(rel: string): string;
}

export interface PluginLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface PluginContext {
  routes: { for(pluginId: string): PluginRoutes };
  space: { for(packageName: string): PluginSpace };
  logger?: PluginLogger;
  effect?: (fn: () => () => void) => void;
}

// ---------------------------------------------------------------------------
// 适配层：让搬过来的 http/routes.ts 一字不改
// ---------------------------------------------------------------------------

/**
 * 宿主的 `ctx.routes` 门面只有 `get/post/put/patch/delete/all`，路径支持 `:param`；
 * 而 `http/routes.ts` 是按 `app.get<{ Params… }>(path, handler)` 写的
 * （fastify 的泛型写法）。泛型运行期不存在，所以这里造一个"假 fastify"把它接住 ——
 * 换来的是那份 462 行的路由表**原样可用**，不需要为了搬家重写一遍。
 *
 * 同时补回旧服务 `setErrorHandler` 的职责：`AppError` → HTTP 状态码。
 */
export function createRouteHost(routes: PluginRoutes, log: PluginLogger): FastifyInstance {
  const handle = (handler: RouteHandler): RouteHandler => {
    return async (request: any, reply: FastifyReply) => {
      // 旧服务的请求体上限是 256KB（safety/quota 的 MAX_BODY_BYTES）；
      // 宿主那条兜底路由用的是 fastify 默认值，所以这里自己兜一道。
      const declared = Number(request?.headers?.['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return reply.code(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KB）`,
          },
        });
      }
      try {
        return await handler(request, reply);
      } catch (err) {
        return sendError(reply, err, log);
      }
    };
  };

  return {
    get: (p: string, h: RouteHandler) => routes.get(p, handle(h)),
    post: (p: string, h: RouteHandler) => routes.post(p, handle(h)),
    put: (p: string, h: RouteHandler) => routes.put(p, handle(h)),
    patch: (p: string, h: RouteHandler) => routes.patch(p, handle(h)),
    delete: (p: string, h: RouteHandler) => routes.delete(p, handle(h)),
    all: (p: string, h: RouteHandler) => routes.all(p, handle(h)),
  } as unknown as FastifyInstance;
}

/** 旧服务错误响应体形状： `{ error: { code, message, details?, requestId } }` */
export function sendError(reply: FastifyReply, err: unknown, log: PluginLogger): unknown {
  // SSE 已经 hijack 过的响应不能再 send（会抛"reply already sent"）
  if (reply.raw?.headersSent) {
    try {
      reply.raw.end();
    } catch {
      /* 已经断了就算了 */
    }
    return undefined;
  }

  const requestId = randomUUID();
  if (err instanceof AppError) {
    return reply.code(err.status).send({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
  }

  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 400) {
    return reply.code(400).send({
      error: { code: 'BAD_REQUEST', message: (err as Error).message, requestId },
    });
  }
  log.error?.(`未处理的服务端错误 ${requestId}: ${String(err)}`);
  return reply.code(500).send({
    error: { code: 'INTERNAL', message: (err as Error).message ?? String(err), requestId },
  });
}

