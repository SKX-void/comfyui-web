import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ComfyEvent } from './types.js';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** 共享的 ComfyUI WebSocket 连接与重连（依据见 comfy/real.ts 的类注释）。 */
export class ComfySocket {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly log: (msg: string, meta?: unknown) => void;
  private readonly emitter = new EventEmitter();

  private ws: WebSocket | null = null;
  private started = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(baseUrl: string, clientId: string, log: (msg: string, meta?: unknown) => void) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.log = log;
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
}
