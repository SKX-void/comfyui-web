/**
 * 与宿主的交接面：宿主句柄的最小类型 + 本插件对前端的 HTTP 载荷。
 *
 * 宿主句柄为什么要手写一份：插件**不 import cordis，也不 import 宿主源码**
 * （引了就等于把宿主内部形状写进插件产物），所以按用到的成员手写。
 *
 * 跑起来之后流来流去的对象（图/设置/反推结果）在 `model.ts`。
 */

// ---------------------------------------------------------------------------
// 宿主句柄（只写用到的部分）
// ---------------------------------------------------------------------------

/** request / reply 是 fastify 的对象；插件不引 fastify 的类型，用到哪几个成员就写哪几个 */
export interface RouteRequest {
  params: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface RouteReply {
  code(status: number): RouteReply;
  send(payload: unknown): unknown;
  header(name: string, value: string): RouteReply;
}

export type RouteHandler = (request: RouteRequest, reply: RouteReply) => unknown;

export interface PluginRoutes {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
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
}

export interface PluginContext {
  routes: { for(pluginId: string): PluginRoutes };
  space: { for(packageName: string): PluginSpace };
  logger?: PluginLogger;
  /** 收尾注册（D20 的契约）：必给，所以这里是必选 —— 宿主不给就是契约破了，越早炸越好 */
  effect: (fn: () => () => void) => void;
}

// ---------------------------------------------------------------------------
// 对前端的 HTTP 载荷
// ---------------------------------------------------------------------------

/** 请求体：外部输入，字段形状靠逐个现查（所以值是 `unknown`） */
export type RequestBody = Record<string, unknown>;
