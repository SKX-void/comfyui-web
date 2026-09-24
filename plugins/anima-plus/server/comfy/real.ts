import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AppError } from '../errors.js';
import type {
  ComfyClient,
  ComfyEvent,
  HistoryEntry,
  QueueInfo,
  SubmitResult,
  ViewParams,
} from './types.js';
import type { Graph } from '@comfyui-web/shared';
import { assertGraphSafe } from '../safety/limits.js';

interface RealClientOptions {
  baseUrl: string;
  /** 共享的 client_id：所有任务共用，靠 prompt_id 区分归属 */
  clientId: string;
  /** 常规请求超时（毫秒）。默认 30s */
  timeoutMs?: number;
  /** 健康探测超时（毫秒）。默认 3s，保证 /api/system/health 快速返回 */
  probeTimeoutMs?: number;
  log?: (msg: string, meta?: unknown) => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * 真实 ComfyUI 客户端。
 *
 * 依据 docs/archive/v1-api.md §B：
 * - 只有 WebSocket，没有 SSE
 * - progress / progress_state 只投递给提交时的 client_id
 * - 因此全服务只维护**一条**共享连接、所有任务共用一个 clientId，靠 prompt_id 区分归属
 */
export class RealComfyClient implements ComfyClient {
  readonly mode = 'real' as const;

  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly log: (msg: string, meta?: unknown) => void;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly emitter = new EventEmitter();

  private ws: WebSocket | null = null;
  private started = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: RealClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.clientId = opts.clientId;
    this.log = opts.log ?? (() => {});
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 3_000;
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.started = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      await new Promise<void>((resolve) => {
        ws.removeAllListeners();
        ws.once('close', () => resolve());
        ws.close();
        // 兜底：避免 close 事件不触发时挂死
        setTimeout(resolve, 500);
      });
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  subscribe(handler: (evt: ComfyEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  private wsUrl(): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = `?clientId=${encodeURIComponent(this.clientId)}`;
    return u.toString();
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl());
      } catch (err) {
        this.log('WS 创建失败', { err: String(err) });
        this.scheduleReconnect();
        done();
        return;
      }
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.log('WS 已连接', { url: this.wsUrl() });
        done();
      });

      ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
        // ⚠️ 关键：ws 库对**文本帧**同样以 Buffer 投递（不是 string），
        // 因此必须显式转字符串。早期用 `typeof raw !== 'string'` 判断会丢弃所有消息。
        if (isBinary) {
          // ComfyUI 的预览图走二进制帧，v1 暂不处理
          return;
        }
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(raw as ArrayBuffer).toString('utf8');

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (
          parsed &&
          typeof parsed === 'object' &&
          'type' in parsed &&
          'data' in parsed
        ) {
          const evt = parsed as ComfyEvent;
          this.emitter.emit('event', evt);
        }
      });

      ws.on('error', (err: Error) => {
        this.log('WS 错误', { err: err.message });
        done();
      });

      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        if (this.started) this.scheduleReconnect();
        done();
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts += 1;
    this.log('WS 将在稍后重连', { delayMs: delay, attempt: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async request<T>(
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

  async submit(
    graph: Graph,
    clientId: string,
    extraData?: Record<string, unknown>,
  ): Promise<SubmitResult> {
    // 出口断言（plugins/anima-plus/docs/safety.md 第 3 层）：宁可提交失败，也不许把越界值打到 GPU。
    // 正常情况下渲染阶段的护栏已经夹紧过，走到这里还越界说明上游有 bug。
    assertGraphSafe(graph);

    const payload: Record<string, unknown> = { prompt: graph, client_id: clientId };
    if (extraData) payload.extra_data = extraData;
    const body = JSON.stringify(payload);
    const res = await this.request<{
      prompt_id: string;
      number: number;
      node_errors?: Record<string, unknown>;
    }>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return {
      promptId: res.prompt_id,
      number: res.number,
      nodeErrors: res.node_errors ?? {},
    };
  }

  async getHistory(promptId: string): Promise<HistoryEntry | null> {
    const raw = await this.request<Record<string, unknown>>(
      `/history/${encodeURIComponent(promptId)}`,
    );
    const entry = raw[promptId] as
      | {
          outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
          status?: { status_str?: string; completed?: boolean };
        }
      | undefined;
    if (!entry) return null;
    return {
      promptId,
      outputs: entry.outputs ?? {},
      statusStr: entry.status?.status_str ?? 'unknown',
      completed: entry.status?.completed ?? false,
    };
  }

  async getQueue(): Promise<QueueInfo> {
    const raw = await this.request<{
      queue_running?: unknown[][];
      queue_pending?: unknown[][];
    }>('/queue');
    const pick = (rows: unknown[][] | undefined): Array<{ promptId: string | null }> =>
      (rows ?? []).map((row) => ({
        promptId: typeof row[1] === 'string' ? (row[1] as string) : null,
      }));
    return { running: pick(raw.queue_running), pending: pick(raw.queue_pending) };
  }

  async getObjectInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/object_info');
  }

  async getSystemStats(): Promise<unknown> {
    // 用短超时：健康检查不应被不可达的上游拖住
    return this.request<unknown>('/system_stats', { timeoutMs: this.probeTimeoutMs });
  }

  async getModels(folder: string): Promise<string[]> {
    const list = await this.request<unknown>(
      `/models/${encodeURIComponent(folder)}`,
    );
    return Array.isArray(list) ? list.map((x) => String(x)) : [];
  }

  async interrupt(): Promise<void> {
    await this.request<unknown>('/interrupt', { method: 'POST' });
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
