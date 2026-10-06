/**
 * 设置：由插件自己持有（决策 D15）。
 *
 * 目录型 tab 没有"行配置"这回事（宿主没有写它配置的端点，D15/D19），
 * 所以设置住在自己的空间里（`data/plugins/<包名>/settings.json`），由本插件的 /api/settings
 * 读写。字段的**形状**仍写在 package.json 的 plugin.settings 里（界面从宿主清单端点取）。
 */
import fs from 'node:fs';

import { SAFETY } from './safety.js';
import type { PluginSpace } from './types.js';
import type {
  ResolvedSettings,
  SettingsValues,
  StoredSettings,
  WorkflowDefaults,
} from './model.js';

export const SETTINGS_FILE_NAME = 'settings.json';

/** 认识的设置项：写文件时只收这些键，UI 送来的杂物不住进空间 */
const SETTING_KEYS: readonly string[] = [
  'comfyuiBaseUrl',
  'negativePrompt',
  'defaultSteps',
  'defaultCfg',
  'defaultWidth',
  'defaultHeight',
  'historyLimit',
];

/** 读设置；文件不存在 = 还没配过（各字段回落到工作流/内置默认值） */
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

/** 一次性迁移：清单行的 config 只在**首次**装载时被采信（那时它还是唯一的配置来源） */
function seedStoredSettings(space: PluginSpace, legacy: unknown): boolean {
  if (legacy === null || typeof legacy !== 'object' || Object.keys(legacy).length === 0) return false;
  if (fs.existsSync(space.resolve(SETTINGS_FILE_NAME))) return false;
  writeStoredSettings(space, legacy);
  return true;
}

/**
 * 本次装载真正生效的设置：文件里的值 → 内置/工作流默认值（`defaults` = 工作流自带值）→ 护栏收敛。
 *
 * 返回三样东西：`values`（生效值）、`stored`（盘上的原始值与读取错误，/settings 端点原样回报）、
 * `write`（写盘）。**收敛只在这一处发生**，PUT 端点原样落盘。
 */
export function resolveSettings(
  space: PluginSpace,
  legacy: unknown,
  defaults: WorkflowDefaults,
  log: (msg: string) => void,
): ResolvedSettings {
  if (seedStoredSettings(space, legacy)) {
    log(`已把清单里的配置落成 ${space.resolve(SETTINGS_FILE_NAME)}（一次性迁移）`);
  }
  const stored = readStoredSettings(space);
  if (stored.error !== undefined) log(`设置文件读不出来，改用内置默认值：${stored.error}`);
  const config = stored.values;

  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v : fallback;
  const values: SettingsValues = {
    comfyuiBaseUrl: str(config?.comfyuiBaseUrl, 'http://localhost:8188'),
    negativePrompt:
      typeof config?.negativePrompt === 'string' ? config.negativePrompt : defaults.negative,
    defaultSteps: num(config?.defaultSteps, defaults.steps),
    defaultCfg: num(config?.defaultCfg, defaults.cfg),
    defaultWidth: num(config?.defaultWidth, defaults.width),
    defaultHeight: num(config?.defaultHeight, defaults.height),
    historyLimit: num(config?.historyLimit, 50),
  };

  // 设置里配的默认值也必须落在护栏内 —— 否则"不传参数"就绕过了上限。
  // 做法与 anima-plus 一致：不炸，但收敛并说出来（越界值会出现在日志里）。
  const clampDefault = (value: number, min: number, max: number, label: string): number => {
    const clamped = Math.min(Math.max(Math.round(value), min), max);
    if (clamped !== value)
      log(`设置 ${label}=${value} 越界，已收敛到 ${clamped}（护栏 ${min}~${max}）`);
    return clamped;
  };
  values.defaultSteps = clampDefault(
    values.defaultSteps,
    SAFETY.minSteps,
    SAFETY.maxSteps,
    'defaultSteps',
  );
  values.defaultWidth = clampDefault(values.defaultWidth, SAFETY.minSide, SAFETY.maxSide, 'defaultWidth');
  values.defaultHeight = clampDefault(
    values.defaultHeight,
    SAFETY.minSide,
    SAFETY.maxSide,
    'defaultHeight',
  );

  return { values, stored, write: (incoming: unknown) => writeStoredSettings(space, incoming) };
}
