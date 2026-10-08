import fs from 'node:fs';
import path from 'node:path';

/**
 * `data/host.json` —— 宿主的**唯一配置文件**（部署段 + 运行期偏好段）。
 *
 * 为什么住 data/：data/ 是这台装置唯一可写、唯一需要持久化的卷（docker 只挂它），
 * 而这些值**都必须能在运行期改**（设置页写、换端口重启）。分两个文件只会多出
 * "这个值该写哪儿"的判断成本，还多一份能写坏的状态。
 *
 * 为什么单文件、不加中间目录：顶层扫一眼就看完。另外**会被程序重写的文件不写注释**
 * （所以这里不用 JSONC），解释写在 docs/config.md。
 *
 * 健壮性约定（沿用原 ui-prefs.ts 的三条）：
 * - **读侧永不抛**：文件不存在 / 不是 JSON / 字段类型不对 → 逐字段回落默认值；
 * - **坏文件不重写**：用户手写的东西轮不到宿主静默重置，只把 `problem` 报上去；
 * - **写侧原子**：先写 `.tmp` 再 rename。
 *
 * 唯一的鸡生蛋：dataDir 本身不能写在它管的文件里 —— 见 config.ts 的 resolveDataDir()。
 */
export interface HostGlobals {
  /** 统一 ComfyUI 地址；空串 = 未设置（各插件各用自己的） */
  comfyuiBaseUrl: string;
}

export const EMPTY_HOST_GLOBALS: HostGlobals = { comfyuiBaseUrl: '' };

export interface HostSettings {
  /** 监听地址与端口（宿主唯一的端口） */
  host: string;
  port: number;
  logLevel: string;
  /** 插件目录（编译完的插件产物），相对路径按仓库根解析 */
  tabsDir: string;
  /** 标签栏顺序（插件 id） */
  tabOrder: string[];
  /** 默认首页（插件 id）；null = 第一个可用标签页 */
  home: string | null;
  /** tab 的显示别名（插件 id → 顶栏上的名字）；没有这个键 = 用插件自己的 title */
  tabAliases: Record<string, string>;
  /** 顶栏品牌链接（首页 `/home`）的显示名；空串 = 用外壳内置名 */
  homeLabel: string;
  /** 被停用的插件 id（**要落盘**：重启后仍然停用；D21） */
  disabled: string[];
  /**
   * 常驻（切走不卸载）的插件 id。
   *
   * 是**宿主偏好**而不是插件自述：常驻的代价是内存与可能活着的 SSE 连接，该由用户在设置页
   * 按插件拍板（D26）。默认空 = 每个 tab 切走就卸载，与历史行为逐字一致。
   */
  keepAlive: string[];
  globals: HostGlobals;
}

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  host: '0.0.0.0',
  port: 8087,
  logLevel: 'info',
  tabsDir: 'tabs',
  tabOrder: [],
  home: null,
  tabAliases: {},
  homeLabel: '',
  disabled: [],
  keepAlive: [],
  globals: { ...EMPTY_HOST_GLOBALS },
};

/** 列表类字段的长度上限：纯属防呆 */
const MAX_LIST = 200;
/** 单个 id 的长度上限 */
const MAX_ID = 200;
/** 地址长度上限 */
const MAX_GLOBAL_TEXT = 300;
const MAX_TEXT = 200;
/** 显示名（别名 / 品牌名）的长度上限 */
const MAX_ALIAS = 40;

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || id.length > MAX_ID || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function sanitizeHostGlobals(value: unknown): HostGlobals {
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

function sanitizeText(value: unknown, fallback: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text === '' || text.length > max ? fallback : text;
}

/**
 * 显示名是**顶栏上的一行文字**：内部换行/连续空白会把它撑变形，所以折成一个空格；
 * 超长截断而不是丢弃 —— 截断后的值会立刻回显到设置页，丢弃只会让人以为没保存上。
 * 空串 = 没有别名（回落到插件自己的 title / 外壳内置品牌名）。
 */
function sanitizeAlias(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS);
}

/** 别名表：键是插件 id、值是显示名；值洗成空的条目直接丢掉（= 没有别名） */
function sanitizeAliasMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_LIST) break;
    const id = rawKey.trim();
    if (id === '' || id.length > MAX_ID) continue;
    const alias = sanitizeAlias(rawValue);
    if (alias === '') continue;
    out[id] = alias;
    count += 1;
  }
  return out;
}

/** 把任意输入洗成合法设置；**不抛异常**，任何怪值都退化成默认 */
export function sanitizeHostSettings(value: unknown): HostSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_HOST_SETTINGS, globals: { ...EMPTY_HOST_GLOBALS } };
  }
  const source = value as Record<string, unknown>;

  const portRaw = typeof source.port === 'number' ? source.port : Number.NaN;
  const port =
    Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : DEFAULT_HOST_SETTINGS.port;

  const rawHome = source.home;
  const home =
    typeof rawHome === 'string' && rawHome.trim() !== '' && rawHome.trim().length <= MAX_ID
      ? rawHome.trim()
      : null;

  return {
    host: sanitizeText(source.host, DEFAULT_HOST_SETTINGS.host),
    port,
    logLevel: sanitizeText(source.logLevel, DEFAULT_HOST_SETTINGS.logLevel, 20),
    tabsDir: sanitizeText(source.tabsDir, DEFAULT_HOST_SETTINGS.tabsDir, MAX_GLOBAL_TEXT),
    tabOrder: sanitizeIdList(source.tabOrder),
    home,
    tabAliases: sanitizeAliasMap(source.tabAliases),
    homeLabel: sanitizeAlias(source.homeLabel),
    disabled: sanitizeIdList(source.disabled),
    keepAlive: sanitizeIdList(source.keepAlive),
    globals: sanitizeHostGlobals(source.globals),
  };
}

/** 只保留"外壳偏好 + 宿主全局设置"那几个键：部署段不归设置页管 */
export function settingsView(
  settings: HostSettings,
): Omit<HostSettings, 'host' | 'port' | 'logLevel' | 'tabsDir'> {
  const { tabOrder, home, tabAliases, homeLabel, disabled, keepAlive, globals } = settings;
  return { tabOrder, home, tabAliases, homeLabel, disabled, keepAlive, globals };
}

export interface LoadedHostSettings {
  settings: HostSettings;
  /** 文件本来不存在，这次写了默认值进去 */
  created: boolean;
  /** 文件在、但读不出来（保留原文件不动，这次用默认值跑） */
  problem?: string;
}

/**
 * 读设置；**文件不存在就写一份默认的** —— 挂一个空 data 卷也能起来（挂载即初始化）。
 * 文件存在但坏了则报 `problem` 而不覆盖它。
 */
export function loadHostSettings(file: string): LoadedHostSettings {
  if (!fs.existsSync(file)) {
    return { settings: writeHostSettings(file, DEFAULT_HOST_SETTINGS), created: true };
  }
  try {
    // 这里必须自己 parse（不能借 readHostSettings：它故意永不抛，坏文件会被它静默吞掉，
    // 而"文件坏了"恰恰是要在启动日志里说出来的那件事）
    return { settings: sanitizeHostSettings(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown), created: false };
  } catch (err) {
    return {
      settings: { ...DEFAULT_HOST_SETTINGS, globals: { ...EMPTY_HOST_GLOBALS } },
      created: false,
      problem: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 只读：**不创建、不抛**。文件不存在或坏了都回落默认值 —— 写路径是 writeHostSettings，
 * 读路径不该顺手改文件（"坏文件不重写"那条约定）。
 */
export function readHostSettings(file: string): HostSettings {
  try {
    return sanitizeHostSettings(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  } catch {
    return { ...DEFAULT_HOST_SETTINGS, globals: { ...EMPTY_HOST_GLOBALS } };
  }
}

/** 原子写设置；写失败会抛（调用方要给前端一个可读的错误，而不是静默不保存） */
export function writeHostSettings(file: string, value: unknown): HostSettings {
  const settings = sanitizeHostSettings(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return settings;
}
