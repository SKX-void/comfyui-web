import type { Graph } from '@comfyui-server/shared';

/** ComfyUI 上游事件类型（v1-api.md §B.2） */
export type ComfyEventType =
  | 'status'
  | 'execution_start'
  | 'execution_cached'
  | 'executing'
  | 'progress'
  | 'progress_state'
  | 'executed'
  | 'execution_error'
  | 'execution_interrupted';

export interface ComfyEvent {
  type: ComfyEventType;
  data: Record<string, unknown>;
}

export interface ComfyOutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface SubmitResult {
  promptId: string;
  number: number;
  nodeErrors: Record<string, unknown>;
}

export interface HistoryEntry {
  promptId: string;
  /** nodeId -> 输出（含 images） */
  outputs: Record<string, { images?: ComfyOutputImage[] } & Record<string, unknown>>;
  statusStr: string;
  completed: boolean;
}

export interface QueueInfo {
  running: Array<{ promptId: string | null }>;
  pending: Array<{ promptId: string | null }>;
}

export interface ViewParams {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * ComfyUI 客户端抽象。
 *
 * 有两个实现：
 * - RealComfyClient：HTTP + WebSocket（v1-api.md §B）
 * - MockComfyClient：进程内模拟（无需 ComfyUI 即可跑通链路）
 *
 * ⚠️ 关键约束：ComfyUI 的进度事件只投递给「提交时的 client_id」，
 * 因此本服务器对所有任务使用**同一个 clientId**，并靠 prompt_id 区分归属。
 */
export interface ComfyClient {
  readonly mode: 'real' | 'mock';
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  submit(graph: Graph, clientId: string): Promise<SubmitResult>;
  getHistory(promptId: string): Promise<HistoryEntry | null>;
  getQueue(): Promise<QueueInfo>;
  getObjectInfo(): Promise<Record<string, unknown>>;
  getSystemStats(): Promise<unknown>;
  /** 枚举某类模型（对应 ComfyUI /models/{folder}） */
  getModels(folder: string): Promise<string[]>;
  interrupt(): Promise<void>;

  /** 订阅上游事件，返回取消订阅函数 */
  subscribe(handler: (evt: ComfyEvent) => void): () => void;

  /** 拉取产出图片的二进制内容 */
  fetchImage(params: ViewParams): Promise<{ data: Buffer; contentType: string }>;
}
