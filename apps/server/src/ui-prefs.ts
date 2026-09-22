import fs from 'node:fs';
import path from 'node:path';

import { EMPTY_HOST_GLOBALS, sanitizeHostGlobals, type HostGlobals } from './host-globals.js';

/**
 * 外壳偏好 + 宿主全局设置：**顶部标签栏的顺序 / 默认首页 / 统一 ComfyUI 地址**。
 *
 * 为什么放 `<dataDir>/ui-prefs.json` 而不是 `host.config.json`：
 * 后者是部署期配置（docker 里是只读挂载 `./host.config.json:ro`），而这两项是用户在
 * 设置页随时会改的运行期状态；data 目录本来就是「本装置自己的可写状态」。
 *
 * 健壮性约定（这是本模块存在的全部理由）：
 * - **读侧永不抛**：文件不存在 / 不是 JSON / 类型不对 / 被编辑器改坏 → 一律退化成默认值
 *   （空顺序 + 无默认首页），界面自然回退成「按清单顺序 + 第一个可用标签页」。
 * - **写侧原子**：先写 `.tmp` 再 rename，避免半截文件把偏好弄坏。
 * - **只做形状清洗**：这里不认识插件 id（那是前端对着实时清单做的事），
 *   所以已卸载插件的 id 允许留在文件里，由前端忽略并在下次保存时自然清掉。
 */
export interface UiPrefs {
  /** 标签页顺序（插件 id）；清单里没有的 id 由前端忽略 */
  tabOrder: string[];
  /** 默认首页（插件 id）；null = 用第一个可用标签页 */
  home: string | null;
  /**
   * 宿主全局设置：跨插件共用的值（统一 ComfyUI 地址）。
   *
   * 它住在偏好文件里不是因为它属于界面，而是因为它**必须能在运行期改**：
   * 部署期的 `host.config.json` 在 docker 里是只读挂载，设置页写不进去。
   */
  globals: HostGlobals;
  /**
   * 哪些插件在「跟随统一设置」（插件 id）。
   *
   * 语义：这一行的 fallback 字段在设置页**留空** = 跟随；宿主把统一值写进它的行配置，
   * 同时在这里记一笔 —— **名单才是「跟随」的真源**（文件里存的是解析后的地址）。
   * 这样运行期改统一地址只要重写这些行的配置，走的是插件设置本来就在用的那条路：
   * 落盘 + 就地重载，行为可预期（补丁层那条路实测会卡住宿主，见 architecture §5.7）。
   */
  following: string[];
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  tabOrder: [],
  home: null,
  globals: { ...EMPTY_HOST_GLOBALS },
  following: [],
};

/** 顺序表最长长度：纯属防呆，正常装置不会有这么多插件 */
const MAX_ORDER = 200;
/** 单个 id 的长度上限 */
const MAX_ID = 200;

/** 把任意输入洗成合法偏好；**不抛异常**，任何怪值都退化成默认 */
export function sanitizeUiPrefs(value: unknown): UiPrefs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_UI_PREFS };
  }
  const source = value as Record<string, unknown>;

  const seen = new Set<string>();
  const tabOrder: string[] = [];
  if (Array.isArray(source.tabOrder)) {
    for (const item of source.tabOrder) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (id === '' || id.length > MAX_ID || seen.has(id)) continue;
      seen.add(id);
      tabOrder.push(id);
      if (tabOrder.length >= MAX_ORDER) break;
    }
  }

  const rawHome = source.home;
  const home =
    typeof rawHome === 'string' && rawHome.trim() !== '' && rawHome.trim().length <= MAX_ID
      ? rawHome.trim()
      : null;

  const followingSeen = new Set<string>();
  const following: string[] = [];
  if (Array.isArray(source.following)) {
    for (const item of source.following) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (id === '' || id.length > MAX_ID || followingSeen.has(id)) continue;
      followingSeen.add(id);
      following.push(id);
      if (following.length >= MAX_ORDER) break;
    }
  }

  return { tabOrder, home, globals: sanitizeHostGlobals(source.globals), following };
}

/** 读偏好：任何失败（含文件被删、JSON 坏掉、编码不对）都返回默认值 */
export function readUiPrefs(file: string): UiPrefs {
  try {
    return sanitizeUiPrefs(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

/** 原子写偏好；写失败会抛（调用方要给前端一个可读的错误，而不是静默不保存） */
export function writeUiPrefs(file: string, value: unknown): UiPrefs {
  const prefs = sanitizeUiPrefs(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return prefs;
}
