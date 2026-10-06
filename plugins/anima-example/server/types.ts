/**
 * 与宿主的交接面：宿主句柄的最小类型 + 本插件对前端的 HTTP 载荷。
 *
 * 宿主句柄为什么要手写一份：插件**不 import cordis，也不 import 宿主源码**
 * （引了就等于把宿主内部形状写进插件产物），所以按用到的成员手写
 * （与 `anima-plus/server/index.ts` 同一写法）。
 *
 * 跑起来之后流来流去的对象（作业/库行/设置/绑定/ComfyUI 应答）在 `model.ts`。
 */
import type { JobValues, QueueCounts, WorkflowDefaults } from './model.js';

// ---------------------------------------------------------------------------
// 宿主句柄（只写用到的部分）
// ---------------------------------------------------------------------------

/** request / reply 是 fastify 的对象；插件不引 fastify 的类型，用到哪几个成员就写哪几个 */
export interface RouteRequest {
  /**
   * 路径参数：宿主按路由模板匹配，模板里写到的键一定有值 —— 所以这里逐个列出来，
   * 不写索引签名（`Record<string, string>` 在 `noUncheckedIndexedAccess` 下取值是 `string | undefined`），
   * 顺带把"键名写错"变成编译期错误。
   */
  params: { id: string; jobId: string; idx: string };
  query?: Record<string, string | undefined>;
  body?: unknown;
  raw: { on(event: string, listener: () => void): void };
}

export interface RouteReply {
  code(status: number): RouteReply;
  send(payload: unknown): unknown;
  header(name: string, value: string): RouteReply;
  hijack(): void;
  raw: {
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string): void;
    end(): void;
  };
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

/** `GET /options` 的载荷（前端 `api.ts` 的 `PluginOptions` 是它的镜像） */
export interface OptionsPayload {
  reachable: boolean;
  unet: string[];
  clip: string[];
  clipType: string[];
  vae: string[];
  lora: string[];
  sampler: string[];
  scheduler: string[];
  rotation: string[];
  defaults: WorkflowDefaults & {
    description: string;
    negative: string;
    hasRotateNode: boolean;
    hasLoraNode: boolean;
  };
  workflow: { nodes: number; file: string };
  bindings: Record<string, string | null>;
}

/** `GET /status` 的载荷（前端 `api.ts` 的 `PluginStatus` 是它的镜像） */
export interface StatusPayload {
  comfyuiBaseUrl: string;
  wsConnected: boolean;
  lastError: string | null;
  inFlight: number;
  comfyui?: {
    reachable: boolean;
    version?: string | null;
    device?: string | null;
    queue?: QueueCounts;
    error?: string;
  };
}

/** 校验结果：`errors` 非空时 `values` 是"能填多少填多少"的兜底值，调用方直接 400 */
export interface ValidatedValues {
  values: JobValues;
  errors: string[];
}
