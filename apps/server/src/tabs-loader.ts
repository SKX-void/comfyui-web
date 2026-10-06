import type { Context } from 'cordis';
import type { Logger } from 'pino';

import { message } from './util.js';

export interface MountRequest {
  id: string;
  /** 服务端入口绝对路径 */
  entry: string;
  /**
   * 强制停用。与盘上的 `disabled` 是**或**关系，所以由调用方算好再传
   * （今天只有坏目录会强制停用：它压根不该跑）。
   */
  disabled: boolean;
  /** 重挂时才给：cache-buster token。不同 URL = 不同模块实例（Node 的 ESM 缓存按 URL 记） */
  token?: string;
}

/**
 * 挂一行 tab。
 *
 * id **不带 `:`**：`:` 是 loader 的 group 路径分隔符，带它会让 resolve/remove 找不到这一行。
 *
 * 类型签名把 `id` 排除了（默认由 loader 随机分配），但运行期 `ensureId()` **认调用方给的 id**。
 * 这里必须显式给：**目录名即 id** 是这套东西的全部意义
 * （它同时是路由前缀 `/api/p/<id>` 与前端资源前缀 `/plugins/<id>/`）。
 */
export async function mountEntry(ctx: Context, request: MountRequest): Promise<void> {
  const options = {
    id: request.id,
    name: request.token === undefined ? request.entry : `${request.entry}?v=${request.token}`,
    config: {},
    ...(request.disabled ? { disabled: true } : {}),
  } as unknown as Parameters<typeof ctx.loader.create>[0];
  await ctx.loader.create(options);
}

/** 卸一行 tab：Loader 行与它登记的路由一起放掉（旧 handler 的闭包不该再留在内存里） */
export function unmountEntry(ctx: Context, id: string, logger: Logger): void {
  try {
    ctx.loader.remove(id);
  } catch (err) {
    logger.warn({ id, err: message(err) }, '卸载 tab 失败');
  }
  try {
    ctx.routes.release(id);
  } catch {
    // routes 服务还没就绪（启动早期）时忽略
  }
}
