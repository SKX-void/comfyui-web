/**
 * ComfyUI 客户端：HTTP + 一条共享 WebSocket。
 *
 * 只 import node 内置模块（`fetch` / `WebSocket` / `AbortSignal.timeout` 都是运行期全局），
 * 不引任何第三方依赖 —— 这是"服务端能打成单文件"的前提。
 */
import { randomUUID } from 'node:crypto';

import type {
  ComfyEvent,
  ComfyImage,
  Graph,
  HistoryResult,
  ImageBytes,
  ObjectInfo,
  QueueCounts,
  SubmitResult,
  SystemStats,
} from './model.js';

/** 事件处理器：`data` 的形状按 type 各不相同，收窄在 jobs.ts 里做 */
export type ComfyEventHandler = (event: ComfyEvent) => void;

/** `/prompt` 的应答：字段一律宽松，下面各查各的 */
interface PromptResponse {
  prompt_id?: unknown;
  number?: unknown;
  node_errors?: unknown;
}

/** `/history/<id>` 里的那一条 */
interface HistoryEntry {
  outputs?: Record<string, { images?: unknown } | undefined>;
  status?: { completed?: unknown; status_str?: unknown; messages?: unknown };
}

/** `/view` 的查询参数 */
interface ViewParams {
  filename: string;
  subfolder?: string;
  type?: string;
}

export class ComfyClient {
  baseUrl: string;
  clientId: string;
  log: (msg: string) => void;
  handlers: Set<ComfyEventHandler>;
  ws: WebSocket | null;
  started: boolean;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastError: string | null;

  constructor(baseUrl: string, log: (msg: string) => void) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = randomUUID();
    this.log = log;
    this.handlers = new Set<ComfyEventHandler>();
    this.ws = null;
    this.started = false;
    this.retry = 0;
    this.timer = null;
    this.lastError = null;
  }

  setBaseUrl(baseUrl: string): void {
    const next = baseUrl.replace(/\/+$/, '');
    if (next === this.baseUrl) return;
    this.baseUrl = next;
    this.#closeWs();
    if (this.started) this.#connect();
  }

  onEvent(handler: ComfyEventHandler): () => boolean {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start(): void {
    this.started = true;
    this.#connect();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.#closeWs();
  }

  #closeWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
    }
  }

  /**
   * 本仓所有任务共用一个 clientId、只维护**一条**共享连接
   * （原因见 plugins/anima-plus/server/comfy/real.ts 的注释），靠 prompt_id 区分归属。
   * progress 事件在部分版本里不带 prompt_id，靠 execution_start 记住当前在跑哪个 prompt。
   */
  #connect() {
    if (!this.started) return;
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = `?clientId=${encodeURIComponent(this.clientId)}`;

    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      this.#scheduleReconnect(`WS 创建失败: ${err}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.lastError = null;
      this.log(`ComfyUI WS 已连接 ${url.host}`);
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return; // 二进制帧是预览图，本插件不处理
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object' || !payload.type) return;
      for (const handler of this.handlers) {
        try {
          handler(payload);
        } catch (err) {
          this.log(`事件处理器抛错: ${err}`);
        }
      }
    });

    ws.addEventListener('error', () => {
      this.lastError = 'WebSocket 错误';
    });

    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.#scheduleReconnect('WS 断开');
    });
  }

  #scheduleReconnect(reason: string): void {
    if (!this.started || this.timer) return;
    const delay = Math.min(500 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.lastError = reason;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#connect();
    }, delay);
    if (this.retry === 1) this.log(`${reason}，${delay}ms 后重连`);
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === 1;
  }

  async #json<T = unknown>(pathname: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const isTimeout = name === 'TimeoutError' || name === 'AbortError';
      throw new Error(
        isTimeout
          ? `ComfyUI 请求超时（${timeoutMs}ms）: ${pathname}`
          : `连不上 ComfyUI (${this.baseUrl}): ${err}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ComfyUI ${pathname} 返回 ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  async prompt(graph: Graph): Promise<SubmitResult> {
    const data = await this.#json<PromptResponse>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    return {
      promptId: String(data.prompt_id ?? ''),
      number: Number(data.number ?? 0),
      nodeErrors: (data.node_errors ?? {}) as Record<string, unknown>,
    };
  }

  /** 只问单个 prompt：ComfyUI 的 /history/<id> 会返回一个单键对象 */
  async history(promptId: string): Promise<HistoryResult | null> {
    const raw = await this.#json<Record<string, HistoryEntry> | null>(
      `/history/${encodeURIComponent(promptId)}`,
    );
    const entry = raw ? raw[promptId] : undefined;
    if (!entry) return null;
    return {
      images: collectImages(entry.outputs ?? {}),
      completed: Boolean(entry.status?.completed),
      statusStr: String(entry.status?.status_str ?? ''),
      messages: entry.status?.messages ?? [],
    };
  }

  async view({ filename, subfolder = '', type = 'output' }: ViewParams): Promise<ImageBytes> {
    // 路径穿越防护：filename 只能是一个文件名
    if (filename.includes('..') || filename.startsWith('/')) {
      throw new Error(`非法文件名: ${filename}`);
    }
    const qs = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${this.baseUrl}/view?${qs}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`取图返回 ${res.status}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/png',
    };
  }

  async interrupt(): Promise<void> {
    await this.#json('/interrupt', { method: 'POST' });
  }

  async deleteQueued(promptId: string): Promise<void> {
    await this.#json('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  async queue(): Promise<QueueCounts> {
    const raw = await this.#json<{ queue_running?: unknown[]; queue_pending?: unknown[] }>('/queue');
    return {
      running: (raw.queue_running ?? []).length,
      pending: (raw.queue_pending ?? []).length,
    };
  }

  async objectInfo(): Promise<ObjectInfo> {
    return this.#json<ObjectInfo>('/object_info', {}, 30_000);
  }

  async stats(): Promise<SystemStats> {
    return this.#json<SystemStats>('/system_stats', {}, 3_000);
  }
}

/** ComfyUI 的 outputs 形如 { "21": { images: [{filename, subfolder, type}] } } */
function collectImages(outputs: Record<string, { images?: unknown } | undefined>): ComfyImage[] {
  const out: ComfyImage[] = [];
  for (const [nodeId, output] of Object.entries(outputs)) {
    const images = Array.isArray(output?.images) ? output.images : [];
    for (const image of images) {
      if (image && typeof image.filename === 'string') {
        out.push({
          nodeId,
          filename: image.filename,
          subfolder: image.subfolder ?? '',
          type: image.type ?? 'output',
        });
      }
    }
  }
  return out;
}
