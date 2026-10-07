import type { Graph } from '@comfyui-web/shared';

/** ComfyUI 上游事件类型（docs/archive/v1-api.md §B.2） */
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
 * 唯一实现是 RealComfyClient：HTTP + WebSocket（docs/archive/v1-api.md §B）。
 * （旧服务里的 MockComfyClient 随旧服务一起删了。）
 *
 * ⚠️ 本仓所有任务共用一个 clientId（原因见 server/comfy/real.ts 的注释），靠 prompt_id 区分归属。
 */
export interface ComfyClient {
  readonly mode: 'real' | 'mock';
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  /**
   * 提交任务。
   * `extraData` 会原样放进请求体的 `extra_data`（如 extra_pnginfo），
   * ComfyUI 的保存节点可据此把额外信息写进图片元数据。
   */
  submit(graph: Graph, clientId: string, extraData?: Record<string, unknown>): Promise<SubmitResult>;
  getHistory(promptId: string): Promise<HistoryEntry | null>;
  getQueue(): Promise<QueueInfo>;
  getObjectInfo(): Promise<Record<string, unknown>>;
  getSystemStats(): Promise<unknown>;
  /** 枚举某类模型（对应 ComfyUI /models/{folder}） */
  getModels(folder: string): Promise<string[]>;
  /** 打断**正在执行**的那条任务（ComfyUI /interrupt 只作用于当前执行的 prompt） */
  interrupt(): Promise<void>;
  /**
   * 把**还在排队**的任务从上游队列里摘掉（ComfyUI `POST /queue {"delete":[…]}`）。
   *
   * 和 interrupt 是两件事：排队中的任务 interrupt 打不到它，只会误伤正在跑的那条。
   * 见 jobs/manager.ts 的 cancel()。
   */
  deleteQueueItems(promptIds: string[]): Promise<void>;

  /** 订阅上游事件，返回取消订阅函数 */
  subscribe(handler: (evt: ComfyEvent) => void): () => void;

  /** 拉取产出图片的二进制内容 */
  fetchImage(params: ViewParams): Promise<{ data: Buffer; contentType: string }>;
}
