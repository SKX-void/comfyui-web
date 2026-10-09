/**
 * 图、设置、反推结果 —— 跑起来之后流来流去的对象。
 *
 * 图与节点沿用 `@comfyui-web/shared` 的形状（宿主与其它插件也这么认），
 * 这里只声明本插件真正读写的字段。
 */

export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type Graph = Record<string, GraphNode>;

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/** 本插件认识的设置项（键名与 package.json 的 plugin.settings 一致） */
export interface SettingsValues {
  comfyuiBaseUrl: string;
  threshold: number;
  characterThreshold: number;
  replaceUnderscore: boolean;
  trailingComma: boolean;
  excludeTags: string;
}

export interface StoredSettings {
  file: string;
  values: Record<string, unknown>;
  error?: string;
}

export interface ResolvedSettings {
  values: SettingsValues;
  stored: StoredSettings;
  /** 整体替换（设置面板用） */
  write(incoming: unknown): string;
  /** 读改写：只覆盖提到的键（「这次用的参数」写回默认值用） */
  merge(incoming: unknown): string;
}

// ---------------------------------------------------------------------------
// 工作流绑定
// ---------------------------------------------------------------------------

/** 三个节点号都靠 class_type 现找，一个都不写死 */
export interface WorkflowBindings {
  /** `LoadImage`：它的 `image` 输入要被换成刚上传的文件名 */
  loadImageId: string;
  /** `WD14Tagger|pysssss`：参数在这里，文本也从它的 history 输出里取 */
  taggerId: string;
  /**
   * tagger 节点 `inputs.model` 的值 —— **模型是工作流的事实，不是插件的设置**：
   * 换模型就换 `workflow.json`（重新导出），插件一个字段都不改。
   * 节点上没写就是空串。
   */
  taggerModel: string;
  /** `PreviewAny`（可选）：拿不到 tagger 的 `tags` 时从它兜底 */
  previewId: string | null;
}

/** 一次反推真正用到的参数（设置里的默认值 + 本次请求的覆盖） */
export interface TaggerParams {
  threshold: number;
  characterThreshold: number;
  replaceUnderscore: boolean;
  trailingComma: boolean;
  excludeTags: string;
}

// ---------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------

/** `/upload/image` 的应答 */
export interface UploadedImage {
  name: string;
  subfolder: string;
  type: string;
}

/** `/history/<id>` 里的那一条（只声明用到的字段） */
export interface HistoryEntry {
  outputs: Record<string, unknown>;
  completed: boolean;
  statusStr: string;
  error?: string;
}

export interface InferResult {
  promptId: string;
  /** 反推出来的 tags（一整串，逗号分隔） */
  tags: string;
  /** 本次真正用的模型 —— 来自 `workflow.json` 的 tagger 节点，插件从不覆盖它 */
  model: string;
  /** 上传到 ComfyUI 后的落点，排障用（同一个文件会一直留在 input/ 下） */
  uploaded: UploadedImage;
  /** 从提交到拿到结果的总耗时 */
  elapsedMs: number;
}
