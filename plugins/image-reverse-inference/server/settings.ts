/**
 * 设置：由插件自己持有（决策 D15）。
 *
 * 目录型 tab 没有"行配置"这回事（宿主没有写它配置的端点），所以设置住在自己的空间里
 * （`data/plugins/<包名>/settings.json`），由本插件的 `/settings` 端点读写。
 * 字段的**形状**仍写在 package.json 的 plugin.settings 里（界面从宿主清单端点取）。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { PluginSpace } from './types.js';
import type { ResolvedSettings, SettingsValues, StoredSettings } from './model.js';

export const SETTINGS_FILE_NAME = 'settings.json';

/** 认识的设置项：写文件时只收这些键，UI 送来的杂物不住进空间 */
const SETTING_KEYS: readonly string[] = [
  'comfyuiBaseUrl',
  'threshold',
  'characterThreshold',
  'replaceUnderscore',
  'trailingComma',
  'excludeTags',
];

/**
 * 「这次用的参数」能写回的那几个键 —— 刻意**不含**：
 *   - `comfyuiBaseUrl`：它是部署事实（地址），不是每次反推都要跟着变的参数；
 *   - `model`：模型固定在工作流里（见 `WorkflowBindings.taggerModel`），不是设置。
 * 老版本落过 `model` 的设置文件不用手动清：这里读改写时被白名单过滤掉，下次写盘就没了。
 */
const PARAM_KEYS: readonly string[] = [
  'threshold',
  'characterThreshold',
  'replaceUnderscore',
  'trailingComma',
  'excludeTags',
];

/** 没配过时的内置默认值（与 package.json 的 plugin.settings 对齐） */
export const DEFAULTS: SettingsValues = {
  comfyuiBaseUrl: 'http://localhost:8188',
  threshold: 0.35,
  characterThreshold: 0.85,
  replaceUnderscore: true,
  trailingComma: false,
  excludeTags: '',
};

export function readStoredSettings(space: PluginSpace): StoredSettings {
  const file = space.resolve(SETTINGS_FILE_NAME);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { file, values: {}, error: '设置文件不是一个 JSON 对象' };
    }
    return { file, values: raw as Record<string, unknown> };
  } catch (err) {
    // 没配过和读坏了必须分开说：前者是正常状态，后者要让用户看见
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file, values: {} };
    }
    return { file, values: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

export function writeStoredSettings(space: PluginSpace, values: unknown): string {
  const source =
    values !== null && typeof values === 'object' ? (values as Record<string, unknown>) : {};
  const clean: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (source[key] !== undefined) clean[key] = source[key];
  }
  const file = space.resolve(SETTINGS_FILE_NAME);
  fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return file;
}

/** 只留参数键（丢掉 `comfyuiBaseUrl` 与杂物） */
export function pickParams(incoming: unknown): Record<string, unknown> {
  const source =
    incoming !== null && typeof incoming === 'object' ? (incoming as Record<string, unknown>) : {};
  const clean: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    if (source[key] !== undefined) clean[key] = source[key];
  }
  return clean;
}

/**
 * 把「这次用的参数」**并进**设置文件。
 *
 * 与 `writeStoredSettings` 的区别是读改写、不是整体替换：没提到的键（典型是
 * `comfyuiBaseUrl`）原样留着 —— 反推一次不该把地址洗掉。
 */
export function mergeStoredSettings(space: PluginSpace, incoming: unknown): string {
  return writeStoredSettings(space, { ...readStoredSettings(space).values, ...pickParams(incoming) });
}

/**
 * 宿主设置页的「统一 ComfyUI 地址」当**只读默认值**（D19：宿主不会把它写进插件）。
 *
 * 位置是数据布局的约定：空间根 = `<dataDir>/plugins/<包名目录>/`，所以 host.json 在它上面两层。
 * 读不到就算了 —— 这是兜底，不是配置来源。
 */
function hostDefaultBaseUrl(space: PluginSpace): string | null {
  try {
    const file = path.resolve(space.root, '..', '..', 'host.json');
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const globals = (raw as { globals?: { comfyuiBaseUrl?: unknown } } | null)?.globals;
    const url = globals?.comfyuiBaseUrl;
    return typeof url === 'string' && url.trim() !== '' ? url : null;
  } catch {
    return null;
  }
}

/** 只补协议：用户填 `10.0.0.5:8188` 时补成 `http://10.0.0.5:8188` */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return DEFAULTS.comfyuiBaseUrl;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function resolveSettings(
  space: PluginSpace,
  legacy: unknown,
  log: (msg: string) => void,
): ResolvedSettings {
  // 一次性迁移：清单行的 config 只在**首次**装载时被采信
  if (
    legacy !== null &&
    typeof legacy === 'object' &&
    Object.keys(legacy).length > 0 &&
    !fs.existsSync(space.resolve(SETTINGS_FILE_NAME))
  ) {
    writeStoredSettings(space, legacy);
    log('已把清单里的配置落成 settings.json（一次性迁移）');
  }

  const stored = readStoredSettings(space);
  if (stored.error !== undefined) log(`设置文件读不出来，改用内置默认值：${stored.error}`);
  const config = stored.values;

  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const ratio = (v: unknown, fallback: number): number =>
    Math.min(Math.max(num(v, fallback), 0), 1);

  const hostDefault = hostDefaultBaseUrl(space);
  const values: SettingsValues = {
    comfyuiBaseUrl: normalizeBaseUrl(
      str(config.comfyuiBaseUrl, hostDefault ?? DEFAULTS.comfyuiBaseUrl),
    ),
    threshold: ratio(config.threshold, DEFAULTS.threshold),
    characterThreshold: ratio(config.characterThreshold, DEFAULTS.characterThreshold),
    replaceUnderscore: bool(config.replaceUnderscore, DEFAULTS.replaceUnderscore),
    trailingComma: bool(config.trailingComma, DEFAULTS.trailingComma),
    excludeTags: typeof config.excludeTags === 'string' ? config.excludeTags : DEFAULTS.excludeTags,
  };

  return {
    values,
    stored,
    write: (incoming: unknown) => writeStoredSettings(space, incoming),
    merge: (incoming: unknown) => mergeStoredSettings(space, incoming),
  };
}
