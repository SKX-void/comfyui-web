/**
 * 与宿主的交接面：宿主句柄的最小类型。
 *
 * 插件**不 import cordis、也不 import 宿主源码** —— 引了就等于把宿主内部的形状写进插件产物，
 * 所以按用到的成员手写一份（与 `plugins/anima-example/server/types.ts` 同一写法）。
 */

/** request / reply 是 fastify 的对象；插件不引 fastify 的类型，用到哪几个成员就写哪几个 */
export interface RouteRequest {
  /**
   * 路径参数：宿主按路由模板匹配，模板里写到的键一定有值 —— 所以逐个列出来，
   * 不写索引签名（`Record<string, string>` 在 `noUncheckedIndexedAccess` 下取值是 `string | undefined`），
   * 顺带把"键名写错"变成编译期错误。
   */
  params: { id: string };
  query?: Record<string, string | undefined>;
  /** 请求体：外部输入，字段形状靠逐个现查（所以是 `unknown`） */
  body?: unknown;
}

export interface RouteReply {
  code(status: number): RouteReply;
  send(payload: unknown): unknown;
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
  /** 收尾注册（D20 的契约）：宿主必给，所以这里是必选 —— 宿主不给就是契约破了，越早炸越好 */
  effect: (fn: () => () => void) => void;
}
