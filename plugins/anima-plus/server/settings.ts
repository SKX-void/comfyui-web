import fs from 'node:fs';

import type { PluginSettings } from './config.js';

/**
 * 本插件的设置**由插件自己持有**（决策 D15）。
 *
 * 目录型 tab 没有"行配置"这回事：宿主没有写它配置的端点（D15/D19）。
 * 所以设置就住在自己的空间里（`ctx.space` →
 * `data/plugins/<包名>/settings.json`），由本插件的 `/api/settings` 读写、
 * 由本插件自己的页面渲染（字段的**形状**仍在 package.json 的 `plugin.settings`）。
 *
 * 三条约定：
 *
 * 1. 文件就是普通 JSON：排障时直接看，不需要接口；
 * 2. 读坏了不算致命：回落到"没有设置"（= 内置默认值），把原因交给调用方显示；
 * 3. 这里就是**唯一**的真源：宿主不持有、也不下发 tab 的配置值（D15），
 *    所以不存在"两个真源打架"的问题。
 */

const FILE_NAME = 'settings.json';

/** 本插件认识的设置项：写文件时只收这些键，免得 UI 送来的杂物住进空间 */
export const SETTING_KEYS = [
  'comfyuiBaseUrl',
  'maxQueueDepth',
  'maxJobsRetained',
  'depsWarmupOnStart',
  'depsCacheTtlMinutes',
] as const;

/** 只要空间句柄的这两件事，省得为了一个路径去 import 宿主类型 */
export interface SettingsSpace {
  readonly root: string;
  resolve(rel: string): string;
}

export interface StoredSettings {
  /** 文件里的原始值（**不**做范围收敛：那是 buildConfig 的活） */
  values: PluginSettings;
  file: string;
  /** 文件存在但读不动 / 不是对象时的原因；不存在时为空 */
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function settingsFile(space: SettingsSpace): string {
  return space.resolve(FILE_NAME);
}

/** 读设置；文件不存在 = 还没配过（用内置默认值） */
export function readSettings(space: SettingsSpace): StoredSettings {
  const file = settingsFile(space);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(raw)) return { values: {}, file, error: '设置文件不是一个 JSON 对象' };
    return { values: raw as PluginSettings, file };
  } catch (err) {
    // 没配过和读坏了必须分开说：前者是正常状态，后者要让用户看见
    if ((err as { code?: string }).code === 'ENOENT') return { values: {}, file };
    return { values: {}, file, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 写设置：只落认识的键；空间目录由宿主建好（`space.root` 必存在） */
export function writeSettings(space: SettingsSpace, values: PluginSettings): string {
  const clean: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const value = (values as Record<string, unknown>)[key];
    if (value !== undefined) clean[key] = value;
  }
  const file = settingsFile(space);
  fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return file;
}

/** 从 UI 送来的对象里挑出认识的键（其余原样丢弃，别让杂物进空间） */
export function pickSettings(input: Record<string, unknown>): PluginSettings {
  const picked: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (input[key] !== undefined) picked[key] = input[key];
  }
  return picked as PluginSettings;
}

/**
 * 一次性迁移：清单行里的 config 只在**首次**装载时被采信（那时它还是唯一的配置来源）。
 * 采信过就落盘，返回 true 让调用方记一条日志 —— 迁移是看得见的一件事。
 */
export function seedSettings(space: SettingsSpace, legacy: PluginSettings | undefined): boolean {
  if (!isPlainObject(legacy) || Object.keys(legacy).length === 0) return false;
  if (fs.existsSync(settingsFile(space))) return false;
  writeSettings(space, legacy);
  return true;
}
