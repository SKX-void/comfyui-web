/**
 * 宿主**全局设置**：跨插件共用、由设置页统一配置的值（目前只有"统一 ComfyUI 地址"）。
 *
 * 它和外壳偏好同住 `<dataDir>/ui-prefs.json`，因为必须**能在运行期改**：
 * `host.config.json` 在 docker 里是只读挂载，设置页写不进去（见 ui-prefs.ts 的说明）。
 *
 * 插件怎么"选择"用统一还是自定：在 manifest 的 `settings[]` 里给某一项声明
 * `fallback: '<全局键>'` —— 意思就是"这一项**留空**时跟随宿主全局值"。于是：
 *   - 插件代码一行都不用改（它照旧只读 `config.comfyuiBaseUrl`）；
 *   - 核也不认识 ComfyUI 的语义，它只知道"这个字段可以由宿主全局值兜底"。
 *
 * 落地方式（改过一版，两版都实测过，理由见 docs/architecture.md §5.7）：设置页里
 * **留空 = 跟随**；宿主把统一值写进该插件的行配置，并在 ui-prefs.json 的 `following`
 * 名单里记一笔 —— 那个名单才是"谁在跟随"的真源，跟随者对前端照旧显示成留空。
 */
export interface HostGlobals {
  /** 统一 ComfyUI 地址；空串 = 未设置（各插件各用自己的） */
  comfyuiBaseUrl: string;
}

export const EMPTY_HOST_GLOBALS: HostGlobals = { comfyuiBaseUrl: '' };

/** 长度上限：纯属防呆，正常地址不会这么长 */
const MAX_GLOBAL_TEXT = 300;

/** 空值判定：undefined / null / 空串 / 纯空白，都算"没填" */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * 清洗全局设置。**只洗形状，不碰语义**（填的地址通不通，由插件自己在连的时候发现）：
 * 去首尾空白、限长、带空白字符的整条丢弃（那一定不是地址）。
 */
export function sanitizeHostGlobals(value: unknown): HostGlobals {
  const source =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const raw = source.comfyuiBaseUrl;
  if (typeof raw !== 'string') return { ...EMPTY_HOST_GLOBALS };
  const url = raw.trim();
  if (url === '' || url.length > MAX_GLOBAL_TEXT || /\s/.test(url)) return { ...EMPTY_HOST_GLOBALS };
  return { comfyuiBaseUrl: url };
}

/** 某个字段的值是从哪来的（设置页据此告诉用户"当前用的是哪个地址"） */
export type SettingSource = 'plugin' | 'host' | 'unset';
