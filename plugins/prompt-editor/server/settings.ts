/**
 * 设置与用量：由插件自己持有。
 *
 * 目录型 tab 没有"行配置"这回事（宿主没有写它配置的端点），所以设置住在自己的空间里
 * （`data/plugins/<包名>/settings.json`）。字段的**形状**仍写在 package.json 的
 * plugin.settings 里（界面从宿主清单端点取）。
 */
import { MIN_INTERVAL_MS_DEFAULT } from './constants.js';
import { PROVIDERS } from './providers.js';
import { asRecord, clampInt } from './util.js';

export interface Settings {
  provider: string;
  autoTranslate: boolean;
  maxCallsPerDay: number;
  timeoutMs: number;
  minIntervalMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  // 两次 provider 调用之间的最小间隔。实测体验版约 6 次/窗口就回 errorCode 411
  // 「请求频率过快」（间隔 1.5s 也救不了，6s 连打 8 次全过），所以默认压到 6s。
  minIntervalMs: MIN_INTERVAL_MS_DEFAULT,
};

export function sanitizeSettings(input: unknown): Settings {
  const raw = asRecord(input) ?? {};
  return {
    provider:
      typeof raw.provider === 'string' && Object.hasOwn(PROVIDERS, raw.provider)
        ? raw.provider
        : DEFAULT_SETTINGS.provider,
    autoTranslate: raw.autoTranslate === undefined ? DEFAULT_SETTINGS.autoTranslate : raw.autoTranslate === true,
    maxCallsPerDay: clampInt(raw.maxCallsPerDay, 0, 100000, DEFAULT_SETTINGS.maxCallsPerDay),
    timeoutMs: clampInt(raw.timeoutMs, 1000, 30000, DEFAULT_SETTINGS.timeoutMs),
    minIntervalMs: clampInt(raw.minIntervalMs, 0, 60000, DEFAULT_SETTINGS.minIntervalMs),
  };
}

export interface Usage {
  date: string;
  calls: number;
}

/** 用量按天记：跨天自动清零，免得昨天烧完的配额今天还算在头上 */
export function sanitizeUsage(input: unknown, today: string): Usage {
  const raw = asRecord(input) ?? {};
  if (raw.date !== today) return { date: today, calls: 0 };
  return { date: today, calls: clampInt(raw.calls, 0, 1000000, 0) };
}
