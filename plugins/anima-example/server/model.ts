/**
 * 本插件自己的数据形状：作业 / 库行 / 设置 / 工作流绑定 / ComfyUI 应答。
 *
 * 与宿主的交接面（句柄、HTTP 载荷）在 `types.ts`；这里只放"跑起来之后流来流去的那些对象"。
 *
 * 工作流图直接用 `@comfyui-web/shared` 的 `Graph`：**类型 import**，构建时被剥掉，
 * 产物里没有这个包（`Graph`/`GraphNode` 也从这里再导出，全插件只在这一处碰 shared）。
 */
import type { Graph, GraphNode } from '@comfyui-web/shared';

export type { Graph, GraphNode };

// ---------------------------------------------------------------------------
// 作业
// ---------------------------------------------------------------------------

/** 作业状态；终态见 meta.ts 的 TERMINAL */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface JobValues {
  description: string;
  positive: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  batch: number;
  rotation: string | null;
  lora: string | null;
  loraStrength: number | null;
  unet: string | null;
  clip: string | null;
  vae: string | null;
}

export interface JobProgress {
  value: number;
  max: number;
}

export interface JobAsset {
  idx: number;
  url: string;
  filename: string;
  mime: string;
  bytes: number;
}

export interface JobError {
  code: string;
  message: string;
  node?: string | null;
}

export interface Job {
  jobId: string;
  promptId: string | null;
  status: JobStatus;
  progress: JobProgress | null;
  node: string | null;
  values: JobValues;
  assets: JobAsset[];
  error: JobError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type JobListener = (type: string, data: unknown) => void;

/** 内存表里的一条：作业 + 它的 SSE 订阅者 + 真正要发出去的图 */
export interface JobEntry {
  job: Job;
  listeners: Set<JobListener>;
  graph: Graph;
}

/** `jobs` 表的一行（列名与 store.ts 的建表语句一一对应） */
export interface JobRow {
  id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  description: string;
  positive: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  batch: number;
  rotation: string | null;
  lora: string | null;
  lora_strength: number | null;
  unet: string | null;
  clip: string | null;
  vae: string | null;
  prompt_id: string | null;
  error: string | null;
}

/** `assets` 表的一行 */
export interface AssetRow {
  idx: number;
  file: string;
  mime: string;
  bytes: number;
}

/** `assets` 表里定位一张图要的两列 */
export interface AssetFileRow {
  file: string;
  mime: string;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/** 本次装载真正生效的设置（越界已收敛） */
export interface SettingsValues {
  comfyuiBaseUrl: string;
  negativePrompt: string;
  defaultSteps: number;
  defaultCfg: number;
  defaultWidth: number;
  defaultHeight: number;
  historyLimit: number;
}

/** 盘上的原始值（`values` 是没筛过的 JSON 对象，`error` 只在读坏时出现） */
export interface StoredSettings {
  file: string;
  values: Record<string, unknown>;
  error?: string;
}

export interface ResolvedSettings {
  values: SettingsValues;
  stored: StoredSettings;
  /** 写盘（键在 settings.ts 里筛）；返回写到的文件路径 */
  write(incoming: unknown): string;
}

// ---------------------------------------------------------------------------
// 工作流绑定
// ---------------------------------------------------------------------------

/** 工作流自带的当前值 = 表单的初始值 */
export interface WorkflowDefaults {
  positive: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  batch: number;
  rotation: string | null;
  lora: string | null;
  loraStrength: number | null;
  unet: string;
  clip: string;
  clipType: string;
  vae: string;
}

export interface WorkflowBindings {
  samplerId: string;
  positiveId: string;
  negativeId: string;
  latentId: string;
  rotateId: string | null;
  loraId: string | null;
  unetId: string;
  clipId: string;
  vaeId: string;
  saveId: string;
  current: WorkflowDefaults;
}

/** 顺着连线找到的节点：[节点号, 节点] */
export type NodeRef = [string, GraphNode];

// ---------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------

export interface ComfyImage {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
}

export interface HistoryResult {
  images: ComfyImage[];
  completed: boolean;
  statusStr: string;
  messages: unknown;
}

/** `/ws` 推来的事件；`data` 的形状按 type 各不相同，用到的字段在 jobs.ts 里收窄 */
export interface ComfyEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** `/object_info` 里一个节点的声明（只用到 input 那两层） */
export interface ObjectInfoNode {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
}

export type ObjectInfo = Record<string, ObjectInfoNode>;

export interface SystemStats {
  system?: { comfyui_version?: string };
  devices?: Array<{ name?: string }>;
}

export interface QueueCounts {
  running: number;
  pending: number;
}

export interface SubmitResult {
  promptId: string;
  number: number;
  nodeErrors: Record<string, unknown>;
}

export interface ImageBytes {
  data: Buffer;
  contentType: string;
}
