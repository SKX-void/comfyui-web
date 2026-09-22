/** 与后端 core-plugin 的清单行一一对应（唯一真源在后端 Loader） */
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

/** 插件某一项的值从哪来（后端算好的，设置页据此显示） */
export type SettingSource = 'plugin' | 'host' | 'unset';

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
  /**
   * 本项**留空**时由宿主全局设置兜底：值是宿主全局项的键（目前只有 `comfyuiBaseUrl`）。
   * 留空 = 跟随设置页里的「统一 ComfyUI 地址」，填了 = 这个插件自定。
   */
  fallback?: string;
}

export interface PluginInfo {
  id: string;
  rowId: string;
  specifier: string;
  enabled: boolean;
  phase: PluginPhase;
  title: string;
  icon?: string;
  order: number;
  packageName?: string;
  version?: string;
  clientUrl?: string;
  settings: PluginSettingField[];
  /** 回给设置页看的配置：跟随统一设置的那些项已经显示成留空 */
  config: Record<string, unknown> | null;
  /** 声明了 fallback 的字段：值从哪来 */
  sources?: Record<string, SettingSource>;
  error?: string;
}

export interface HostInfo {
  profile: string;
  profileDir: string;
  manifestFile: string;
  contract: number;
}

/**
 * 外壳偏好（后端 `/api/ui` ↔ `<dataDir>/ui-prefs.json`）。
 *
 * 只是一份"意愿"：里面可能存着已经卸载的插件 id，也可能指向一个当前跑不起来的插件。
 * 前端负责过滤与回退，所以这里不需要任何"保证有效"的约束。
 */
/** 宿主全局设置：跨插件共用、由设置页统一配置（后端 host-globals.ts） */
export interface HostGlobals {
  /** 统一 ComfyUI 地址；空串 = 未设置（各插件各用自己的） */
  comfyuiBaseUrl: string;
}

export interface UiPrefs {
  /** 标签栏顺序（插件 id） */
  tabOrder: string[];
  /** 默认首页（插件 id）；null = 第一个可用标签页 */
  home: string | null;
  /** 宿主全局设置：插件的留空项可以跟随它 */
  globals: HostGlobals;
  /** 哪些插件在跟随统一设置（插件 id）；跟随者在设置页里显示为留空 */
  following: string[];
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
