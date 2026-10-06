import { AppError } from '../errors.js';
import type { ViewParams } from './types.js';

/** 上游 HTTP 调用（comfy/real.ts 的 HTTP 侧）：超时与非 2xx 统一收敛成 AppError。 */
export interface ComfyHttpOptions {
  baseUrl: string;
  /** 常规请求超时（毫秒）。默认 30s */
  timeoutMs?: number;
  /** 健康探测超时（毫秒）。默认 3s，保证 /api/system/health 快速返回 */
  probeTimeoutMs?: number;
}

export class ComfyHttp {
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly probeTimeoutMs: number;

  constructor(opts: ComfyHttpOptions) {
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 3_000;
  }

  protected async request<T>(
    pathname: string,
    init?: RequestInit & { timeoutMs?: number },
  ): Promise<T> {
    const timeout = init?.timeoutMs ?? this.timeoutMs;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw AppError.comfyUnreachable(
          `ComfyUI (${this.baseUrl}) 请求超时（${timeout}ms）: ${pathname}`,
        );
      }
      throw AppError.comfyUnreachable(
        `无法连接 ComfyUI (${this.baseUrl}): ${String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw AppError.comfyError(
        `ComfyUI ${pathname} 返回 ${res.status}`,
        text.slice(0, 2000),
      );
    }
    return (await res.json()) as T;
  }

  async fetchImage(params: ViewParams): Promise<{ data: Buffer; contentType: string }> {
    // 防路径穿越（docs/archive/v1-api.md §B.4）
    if (params.filename.includes('..') || params.filename.startsWith('/')) {
      throw AppError.badRequest(`非法文件名: ${params.filename}`);
    }
    const qs = new URLSearchParams({
      filename: params.filename,
      subfolder: params.subfolder ?? '',
      type: params.type ?? 'output',
    });
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/view?${qs.toString()}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw AppError.comfyUnreachable(`取图超时（${this.timeoutMs}ms）`);
      }
      throw AppError.comfyUnreachable(`取图失败: ${String(err)}`);
    }
    if (!res.ok) {
      throw AppError.comfyError(`取图返回 ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      data: buf,
      contentType: res.headers.get('content-type') ?? 'image/png',
    };
  }
}
