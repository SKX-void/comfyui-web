/** 与后端 core-plugin 的 /api/plugins 行一一对应（行只来自 /tabs 扫描，D16/D19） */
export type PluginPhase =
  | 'active'
  | 'pending'
  | 'loading'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'unresolved'
  | 'disabled'
  | 'rejected';

/** 插件声明的设置字段**形状**（元数据）；值是插件自己的事，宿主不持有 */
export interface PluginSettingField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea';
  label?: string;
  description?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  secret?: boolean;
}

export interface PluginInfo {
  id: string;
  /** 服务端入口绝对路径（排障用） */
  entry: string;
  enabled: boolean;
  phase: PluginPhase;
  title: string;
  icon?: string;
  order: number;
  packageName?: string;
  version?: string;
  clientUrl?: string;
  settings: PluginSettingField[];
  error?: string;
}

export interface HostInfo {
  /** 数据目录（宿主配置 + 插件空间） */
  dataDir: string;
  /** tab 目录：每个子目录就是一个插件 */
  tabsDir: string;
  contract: number;
}

/** `POST /api/tabs/rescan` 的返回：重扫到底做了什么（D20 后这是唯一的装载入口） */
export interface RescanResult {
  added: string[];
  removed: string[];
  /** 代码变了、被就地重挂的 tab */
  reloaded: string[];
  failed: Array<{ id: string; reason: string }>;
}

/** 宿主全局设置：统一 ComfyUI 地址，只是宿主给的**只读默认值**（D16） */
export interface HostGlobals {
  /** 统一 ComfyUI 地址；空串 = 未设置 */
  comfyuiBaseUrl: string;
}

/**
 * 外壳偏好（后端 `/api/ui` ↔ `<dataDir>/host.json` 的偏好段）。
 *
 * 只是一份"意愿"：里面可能存着已经卸载的插件 id，也可能指向一个当前跑不起来的插件。
 * 前端负责过滤与回退，所以这里不需要任何"保证有效"的约束。
 */
export interface UiPrefs {
  /** 标签栏顺序（插件 id） */
  tabOrder: string[];
  /** 默认首页（插件 id）；null = 第一个可用标签页 */
  home: string | null;
  /** tab 的显示别名（插件 id → 顶栏上的名字）；没有这个键 = 用插件自己的 title */
  tabAliases: Record<string, string>;
  /** 顶栏品牌链接（首页 `/home`）的显示名；空串 = 用外壳内置名 */
  homeLabel: string;
  /**
   * 常驻（切走不卸载）的插件 id；空 = 全部切走即卸载（默认，= 历史行为）。
   *
   * 真源是宿主偏好（`data/host.json`），不是插件自述：常驻的代价是内存和可能活着的连接，
   * 由用户在设置页按插件决定。外壳只把它翻成 `<KeepAlive :include>` 的名单（D26）。
   */
  keepAlive: string[];
  globals: HostGlobals;
}

/** tab 栏条目：来自插件前端入口的默认导出 */
export interface TabEntry {
  id: string;
  title: string;
  order: number;
  /** 前端加载失败时带上原因 —— 坏插件必须可见，而不是静默消失 */
  error?: string;
}

/**
 * 插件前端入口契约。宿主只认这一份形状：
 * 插件不创建 app、不碰 router、不渲染 tab 栏。
 */
export interface PluginClient {
  tabs?: Array<{ id: string; title?: string; order?: number }>;
  routes?: Array<{ path: string; component: unknown }>;
}
