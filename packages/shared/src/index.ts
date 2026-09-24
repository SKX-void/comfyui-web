/**
 * 前后端共享类型。
 *
 * 设计依据：docs/archive/v1-api.md（对外契约）、docs/archive/v1-templates.md（模板格式）。
 */

// ---------------------------------------------------------------------------
// ComfyUI graph
// ---------------------------------------------------------------------------

/** ComfyUI 图中一个节点的连线引用：[来源节点ID, 输出序号] */
export type NodeLink = [string, number];

/** ComfyUI 图中一个节点 */
export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

/** ComfyUI API 格式的工作流图：nodeId -> 节点 */
export type Graph = Record<string, GraphNode>;

// ---------------------------------------------------------------------------
// 模板（docs/archive/v1-templates.md）
// ---------------------------------------------------------------------------

/** 表单控件类型 */
export type InputType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'switch'
  | 'seed'
  | 'model-select'
  | 'lora-select'
  | 'tag-selector'
  | 'image-upload';

/** 选项数据来源 */
export interface InputSource {
  kind: 'comfy' | 'weilin' | 'static';
  /** kind=comfy 时：模型目录，如 diffusion_models / loras */
  folder?: string;
  /** kind=weilin 时：WeiLin 端点的语义名，如 tags / random-template */
  endpoint?: string;
  /** kind=static 时的固定选项 */
  options?: Array<{ label: string; value: string }>;
}

export interface TemplateInput {
  key: string;
  label: string;
  type: InputType;
  required?: boolean;
  default?: unknown;
  description?: string;
  source?: InputSource;
  ui?: {
    rows?: number;
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    multiple?: boolean;
    /**
     * 同行布局：`ui.row` 相同的字段排在同一行（按首次出现顺序）。
     * 用于「种子/步数/CFG」这类短数值字段。
     */
    row?: string;
    /**
     * 一键交换：点击 ⇄ 时把本字段的值与 `swap` 指向的字段互换。
     * 典型用法：宽与高互换（`width` 声明 `swap: "height"`）。
     */
    swap?: string;
    /**
     * 预设绑定。决定该字段（或该行）显示预设切换器，并声明预设值覆盖哪些字段。
     *
     * - 字符串简写：`"prompt"` —— 类别即 kind，目标默认是本字段
     * - 对象形式：`{ kind: "size", targets: ["width","height"] }`
     *   —— 一条预设同时改多个字段（如宽高对）
     */
    preset?: string | { kind: string; targets?: string[] };
  };
  /** 条件显示：按另一个 input 的值决定是否显示 */
  visibleIf?: { key: string; equals?: unknown; notEquals?: unknown };
}

/** 值变换器名称 */
export type TransformName =
  | 'seed'
  | 'join'
  | 'json'
  | 'weilinTokens'
  | 'weilinLora'
  | 'weilinLoraTags'
  | 'prefixComma'
  | 'clamp';

export interface Binding {
  /** 目标写入路径："<nodeId>.inputs.<field>" */
  target: string;
  /** 取值来源（inputs[].key）；省略则用 const */
  from?: string;
  /** 常量写入 */
  const?: unknown;
  transform?: TransformName;
  /** transform 的参数 */
  args?: Record<string, unknown>;
  /** 条件绑定：不满足则跳过，保留 graph 原值 */
  when?: { key: string; equals?: unknown; truthy?: boolean };
}

/** WeiLin 提示词节点绑定（docs/archive/v1-templates.md §3.4） */
export interface PromptBinding {
  node: string;
  positiveField: string;
  tempStrField?: string;
  /** LoRA 堆叠节点（若走 Q15 方案 B） */
  loraStackNode?: string;
}

/**
 * 需要用户自己装的节点包。
 *
 * `url` **由作者手写、不走 ComfyUI-Manager 的推测**：它的"类 → 包"映射并不可靠
 * （同名包、改过名的目录都会猜错），原因见 plugins/anima-plus/scripts/gen-deps.mjs 的注释。
 * 写上地址的另一个好处是 WeiLin 这种**不在 Manager 上**的包，用户也能一眼找到去装的地方。
 */
export interface PackRequirement {
  name: string;
  /** 仓库地址（GitHub 等） */
  url: string;
  /** 这个包提供的节点类（`class_type`）—— 用来回答"缺的这个节点该装谁" */
  provides: string[];
  /** 可选包：缺了不拦提交（只在依赖面板里提示） */
  optional?: boolean;
  note?: string;
}

export interface TemplateRequirements {
  /**
   * 模板需要的节点类。**由 graph.json 推导、运行期由 loader 填**，作者不要手写：
   * 手写过一次就漂了（模板列 9 种、图里实际 17 种，缺的那 8 种一路跑到 ComfyUI 才报错）。
   */
  nodes?: string[];
  /** ComfyUI 自带（`nodes` / `comfy_extras`）；缺了说明 ComfyUI 版本太老 */
  builtin?: string[];
  /** 需要另外安装的节点包 */
  packs?: PackRequirement[];
  weilin?: boolean;
}

export interface TemplateDef {
  id: string;
  name: string;
  description?: string;
  version: string;
  source?: { file: string; capturedAt?: string };
  requirements?: TemplateRequirements;
  inputs: TemplateInput[];
  bindings: Binding[];
  promptBinding?: PromptBinding;
  outputs: { nodes: string[]; type: 'image' | 'video' | 'audio' | 'file' };
}

/** 模板详情（对外响应，含 graph 供调试） */
export interface TemplateDetail extends TemplateDef {
  graphNodeCount: number;
}

// ---------------------------------------------------------------------------
// LoRA / 标签（前端表单值）
// ---------------------------------------------------------------------------

/** 前端 LoRA 选择项 */
export interface LoraRef {
  /** 不含 .safetensors 的名称，如 "Anima\\画师\\taffy-style" */
  name: string;
  /** 含扩展名的完整名；缺省由 name 补 .safetensors */
  lora?: string;
  weight: number;
  clipWeight: number;
  triggerWeight?: number;
  displayName?: string;
  /** 用户编辑的触发词（仅供前端显示；节点不读取） */
  loraWorks?: string;
  hidden?: boolean;
}

export interface TagRef {
  text: string;
  translate?: string;
  color?: string | null;
}

// ---------------------------------------------------------------------------
// 任务（docs/archive/v1-api.md §A.3）
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface JobProgress {
  value: number;
  max: number;
  node?: string | null;
}

export interface JobAsset {
  assetId: string;
  url: string;
  filename: string;
  subfolder: string;
  type: string;
}

export interface JobError {
  code: string;
  message: string;
  node?: string | null;
  detail?: unknown;
}

export interface Job {
  jobId: string;
  promptId: string | null;
  templateId: string;
  templateVersion: string;
  status: JobStatus;
  progress: JobProgress | null;
  values: Record<string, unknown>;
  assets: JobAsset[];
  error: JobError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queuePosition?: number | null;
}

export interface CreateJobRequest {
  templateId: string;
  values: Record<string, unknown>;
  options?: { autoRandom?: boolean; clientToken?: string };
}

export interface CreateJobResponse {
  jobId: string;
  promptId: string | null;
  status: JobStatus;
  queuePosition?: number | null;
  createdAt: string;
}

/** SSE 事件（docs/archive/v1-api.md §A.3） */
export type JobEventType =
  | 'snapshot'
  | 'queued'
  | 'started'
  | 'progress'
  | 'node'
  | 'completed'
  | 'error'
  | 'canceled';

export interface JobEvent {
  type: JobEventType;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 错误（docs/archive/v1-api.md §A.6）
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_VALIDATION_FAILED'
  | 'GRAPH_VALIDATION_FAILED'
  | 'JOB_NOT_FOUND'
  | 'COMFYUI_UNREACHABLE'
  | 'COMFYUI_ERROR'
  | 'EXECUTION_FAILED'
  | 'WEILIN_UNAVAILABLE'
  | 'PAYLOAD_TOO_LARGE'
  | 'QUEUE_FULL'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

// ---------------------------------------------------------------------------
// 系统
// ---------------------------------------------------------------------------

/** 依赖检查的单个包：声明 + 这个包当前缺了什么 */
export interface DepsPackView extends PackRequirement {
  /** 这个包里当前缺失的节点类（空数组 = 齐） */
  missing: string[];
}

/** 依赖检查的单个模板 */
export interface DepsTemplateView {
  id: string;
  name: string;
  ready: boolean;
  missing: string[];
}

/** `GET /api/deps` 的响应 */
export interface DepsReport {
  /**
   * true = 齐了；false = 确实缺；**null = 没查成**（ComfyUI 不可达 / 超时）。
   *
   * 三态是刻意的：把"连不上"说成"缺依赖"会把用户引去装一堆本来就在的包。
   */
  ok: boolean | null;
  checkedAt: string | null;
  /** ok === null 时的原因 */
  error?: string;
  /** 结果是否来自缓存（object_info 约 9MB / 2s，必须缓存） */
  cached?: boolean;
  /** ComfyUI 已注册的节点类数量 */
  nodeCount?: number;
  /** 内置节点却缺失（ComfyUI 版本太老，装不了插件包解决） */
  missingBuiltin: string[];
  /** 缺失的节点 → 出处；声明里没写地址时为 null（界面显示"出处未声明"） */
  missing: Array<{ classType: string; pack: { name: string; url: string } | null }>;
  packs: DepsPackView[];
  templates: DepsTemplateView[];
}

/** `GET /api/help` 的响应：包内 md 的原文（text 为 null = 读不到，`error` 给原因） */
export interface HelpDoc {
  file: string;
  text: string | null;
  bytes: number;
  updatedAt: string | null;
  error?: string;
}

export interface HealthResponse {
  server: 'ok';
  comfyMode: 'real' | 'mock';
  comfyui: { reachable: boolean; version?: string; baseUrl: string };
  ws: { connected: boolean };
  /** WeiLin 插件状态（plugins/anima-plus/docs/weilin.md §3.2；不可用时前端降级） */
  weilin: {
    available: boolean;
    isLoading: boolean;
    progress: number;
    total: number;
  };
  /** 本次实际加载的配置文件（按优先级从低到高） */
  configFiles: string[];
}

// ---------------------------------------------------------------------------
// WeiLin 数据源（docs/archive/v1-api.md §A.2）
// ---------------------------------------------------------------------------

export interface LoraListItem {
  /** 不含扩展名，可直接写入模板的 lora 字段 */
  name: string;
  /** 含扩展名的完整名 */
  lora: string;
  displayName: string;
  folder: string;
}

/** LoRA 目录浏览：一层的内容（子目录 + 直属文件），不递归 */
export interface LoraFolderEntry {
  path: string;
  name: string;
  /** 该目录**直属**的 LoRA 数（不含更深层） */
  count: number;
}

export interface LoraBreadcrumb {
  name: string;
  path: string;
}

export interface LoraBrowseResponse {
  /** 当前目录（根为 ""） */
  path: string;
  breadcrumbs: LoraBreadcrumb[];
  /** 直属子目录，可逐层进入 */
  folders: LoraFolderEntry[];
  /** 当前目录直属的 LoRA（不含子目录内容） */
  items: LoraListItem[];
  total: number;
}

export interface LoraMeta {
  file: string;
  triggerWords: string[];
  /** 用户编辑的触发词（WeiLin 节点不读取，仅展示） */
  loraWorks: string;
  civitaiName: string;
  nsfwLevel: number | null;
  baseModel: string;
}

export interface TagItem {
  id: number;
  text: string;
  translate: string;
  color: string;
  topGroup: string;
  group: string;
}

// ---------------------------------------------------------------------------
// 预设（每类别一张表；uid 预留多用户，目前固定 'local'）
// ---------------------------------------------------------------------------

/** 预设字段元数据：dialog 据此展示"详细内容"与生成新建表单 */
export interface PresetField {
  /** 数据库列名 */
  column: string;
  /** 模板 input 的 key —— 套用时写这个键 */
  inputKey: string;
  label: string;
  type: 'text' | 'int';
}

/** 单条预设（不含原始列值，只有服务端派生的 values） */
export interface PresetRecord {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** 键为模板 input 的 key，可直接写进表单值 */
  values: Record<string, unknown>;
}

/** 某类别的完整载荷 */
export interface PresetKindPayload {
  kind: string;
  label: string;
  fields: PresetField[];
  items: PresetRecord[];
}

export interface TagGroupItem {
  id: number;
  name: string;
  color: string;
  tagCount: number;
  subgroups: Array<{ id: number; name: string; color: string; tagCount: number }>;
}
