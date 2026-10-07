import { ComfyHttp } from './http.js';
import { ComfySocket } from './ws.js';
import type {
  ComfyClient,
  ComfyEvent,
  HistoryEntry,
  QueueInfo,
  SubmitResult,
} from './types.js';
import type { Graph } from '@comfyui-web/shared';
import { assertGraphSafe } from '../safety/describe.js';

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

/**
 * 真实 ComfyUI 客户端。
 *
 * 依据 docs/archive/v1-api.md §B：
 * - 只有 WebSocket，没有 SSE
 * - progress / progress_state 只投递给提交时的 client_id
 * - 因此全服务只维护**一条**共享连接、所有任务共用一个 clientId，靠 prompt_id 区分归属
 */
export class RealComfyClient extends ComfyHttp implements ComfyClient {
  readonly mode = 'real' as const;

  private readonly log: (msg: string, meta?: unknown) => void;
  private readonly socket: ComfySocket;

  constructor(opts: RealClientOptions) {
    super(opts);
    this.log = opts.log ?? (() => {});
    this.socket = new ComfySocket(opts.baseUrl, opts.clientId, this.log);
  }

  async start(): Promise<void> {
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.stop();
  }

  isConnected(): boolean {
    return this.socket.isConnected();
  }

  subscribe(handler: (evt: ComfyEvent) => void): () => void {
    return this.socket.subscribe(handler);
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

  async deleteQueueItems(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;
    await this.request<unknown>('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    });
  }
}
