/**
 * 插件自己的配置（从已删除的旧单体服务裁剪而来；同名的 `apps/server/src/config.ts` 现在是**宿主**的配置）。
 *
 * 旧那份是 355 行的**进程级配置**：端口、静态目录、env 覆盖、仓库根定位……
 * 插件不需要这些 —— 宿主管进程，核只给一个文件空间。
 * 这里只保留被搬进来的模块真正读到的字段（逐个核对过：
 * `comfyBaseUrl` / `comfyMode` / `configFiles` / `maxQueueDepth` / `maxJobsRetained` /
 * `depsWarmupOnStart` / `depsCacheTtlMs`），其余路径由 `apply()` 从空间推出来。
 *
 * 设置项的取值原则：**填错绝不让插件起不来**。非法值、越界值一律回落到默认值（越界则收敛进
 * 范围），并把结论记进 `configFiles`，`/config` 端点会把它露出来，排障时一眼能看到。
 */

import { MAX_JOBS_RETAINED, MAX_QUEUE_DEPTH } from './safety/quota.js';

/** 与 `<空间>/settings.json` 对应（都是 `unknown`：来自文件与界面，信不过） */
export interface PluginSettings {
  comfyuiBaseUrl?: unknown;
  /** 在途任务上限：同一台 ComfyUI 上同时跑几个任务 */
  maxQueueDepth?: unknown;
  /** 任务表保留条数：内存里留多少条历史 */
  maxJobsRetained?: unknown;
  /** 启动时预热依赖检查（省掉首屏那次拉取；object_info 很贵，缓存策略见 server/deps.ts） */
  depsWarmupOnStart?: unknown;
  /** 依赖检查缓存时长（分钟，0 = 不缓存、每次重查） */
  depsCacheTtlMinutes?: unknown;
}

/** 设置项的范围：越界收敛而不是报错 —— 配置填错不该让插件起不来 */
const QUEUE_DEPTH_RANGE = { min: 1, max: 16 };
const JOBS_RETAINED_RANGE = { min: 10, max: 5000 };
const DEPS_TTL_MAX_MINUTES = 24 * 60;

export interface ServerConfig {
  /** ComfyUI 地址；WeiLin 的 `/weilin/*` 路由也注册在它上面 */
  comfyBaseUrl: string;
  /** 旧服务的 mock 开关是给它的单测用的，插件里恒为 real */
  comfyMode: 'real' | 'mock';
  /** 在途任务上限（设置页可改，默认 `MAX_QUEUE_DEPTH`） */
  maxQueueDepth: number;
  /** 任务表保留条数（设置页可改，默认 `MAX_JOBS_RETAINED`） */
  maxJobsRetained: number;
  /** 启动时预热依赖检查（设置页可改，默认 true） */
  depsWarmupOnStart: boolean;
  /** 依赖检查缓存时长（设置页可改，默认 5 分钟；0 = 每次都查上游） */
  depsCacheTtlMs: number;
  /** 排障用：这次生效的值是从哪儿来的 */
  configFiles: string[];
  /** 模板目录（插件自带资产） */
  templatesDir: string;
  /** 插件私有 SQLite（在插件空间里） */
  dbFile: string;
  /** 缩略图缓存根（在插件空间里） */
  cacheDir: string;
  /** 插件空间根 */
  dataDir: string;
}

const DEFAULT_COMFY_BASE_URL = 'http://localhost:8188';

/**
 * 用户很可能只写 `localhost:8188`：补上协议、去掉尾斜杠。
 * （旧实现也这么做；这个函数现在只住在插件里）
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return DEFAULT_COMFY_BASE_URL;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * 数值设置：非法/超范围一律回落或收敛，并把结论记进 notes（`/config` 会露出来）。
 * 表单里 number 输入框可能把值送成字符串，所以数字字符串也认。
 */
function numberSetting(
  raw: unknown,
  fallback: number,
  range: { min: number; max: number },
  key: string,
  notes: string[],
): number {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  if (typeof raw !== 'number' && typeof raw !== 'string') return fallback;
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.min(range.max, Math.max(range.min, Math.round(parsed)));
  notes.push(value === parsed ? `settings.json: ${key}` : `settings.json: ${key}（越界已收敛到 ${value}）`);
  return value;
}

/** 布尔设置：只认真正的布尔与 true/false（含 1/0、yes/no、on/off），其余回默认值 */
function booleanSetting(raw: unknown, fallback: boolean, key: string, notes: string[]): boolean {
  if (typeof raw === 'boolean') {
    notes.push(`settings.json: ${key}`);
    return raw;
  }
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (text === '') return fallback;
    if (['true', '1', 'yes', 'on'].includes(text)) {
      notes.push(`settings.json: ${key}`);
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(text)) {
      notes.push(`settings.json: ${key}`);
      return false;
    }
  }
  return fallback;
}

export function buildConfig(
  settings: PluginSettings | undefined,
  paths: { templatesDir: string; dbFile: string; cacheDir: string; dataDir: string },
): ServerConfig {
  const configured =
    typeof settings?.comfyuiBaseUrl === 'string' ? settings.comfyuiBaseUrl.trim() : '';
  const notes: string[] = [];

  const maxQueueDepth = numberSetting(
    settings?.maxQueueDepth,
    MAX_QUEUE_DEPTH,
    QUEUE_DEPTH_RANGE,
    'maxQueueDepth',
    notes,
  );
  const maxJobsRetained = numberSetting(
    settings?.maxJobsRetained,
    MAX_JOBS_RETAINED,
    JOBS_RETAINED_RANGE,
    'maxJobsRetained',
    notes,
  );
  const depsWarmupOnStart = booleanSetting(settings?.depsWarmupOnStart, true, 'depsWarmupOnStart', notes);
  const depsCacheTtlMinutes = numberSetting(
    settings?.depsCacheTtlMinutes,
    5,
    { min: 0, max: DEPS_TTL_MAX_MINUTES },
    'depsCacheTtlMinutes',
    notes,
  );

  return {
    comfyBaseUrl: normalizeBaseUrl(configured === '' ? DEFAULT_COMFY_BASE_URL : configured),
    comfyMode: 'real',
    maxQueueDepth,
    maxJobsRetained,
    depsWarmupOnStart,
    // 0 = 不缓存：每次检查都拉一遍上游，只在装包调参时用（object_info 很贵，缓存策略见 server/deps.ts）
    depsCacheTtlMs: depsCacheTtlMinutes * 60_000,
    configFiles: [
      configured === '' ? '内置默认值' : 'settings.json: comfyuiBaseUrl',
      ...notes,
    ],
    ...paths,
  };
}
