/**
 * 设置与用量：由插件自己持有。
 *
 * 目录型 tab 没有"行配置"这回事（宿主没有写它配置的端点），所以设置住在自己的空间里
 * （`data/plugins/<包名>/settings.json`）。字段的**形状**仍写在 package.json 的
 * plugin.settings 里（界面从宿主清单端点取）。
 *
 * `llm` 段与翻译段并排：LLM 的凭据（apiKey）同样只住在后端文件里，`GET /settings`
 * 会原样回给前端（key 只写不读？不 —— 见下方注释：回显打码，前端只拿它判断"配没配"）。
 */
import { DEFAULT_COLOR, MIN_INTERVAL_MS_DEFAULT } from './constants.js';
import { PROVIDERS } from './providers.js';
import { asRecord, clampInt } from './util.js';

export interface LlmSettings {
  /** 总开关：false 时 /llm/* 一律 403 LLM_DISABLED */
  enabled: boolean;
  /** 现在只有 openai-compatible 一家；字段留给以后扩展 */
  provider: string;
  /** OpenAI 兼容的 baseUrl（不含 /chat/completions，末尾斜杠会被剥掉） */
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  /** 每日 LLM 提交次数（一次 /llm/generate = 1 次，内部多轮 tool call 不另计） */
  maxCallsPerDay: number;
  /** LLM 新建区块时用的颜色 */
  newBlockColor: string;
  /** 一次生成里最多让模型调几轮工具 */
  maxToolRounds: number;
}

export interface Settings {
  provider: string;
  autoTranslate: boolean;
  maxCallsPerDay: number;
  timeoutMs: number;
  minIntervalMs: number;
  llm: LlmSettings;
}

export const LLM_PROVIDER = 'openai-compatible';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  // 两次 provider 调用之间的最小间隔。实测体验版约 6 次/窗口就回 errorCode 411
  // 「请求频率过快」（间隔 1.5s 也救不了，6s 连打 8 次全过），所以默认压到 6s。
  minIntervalMs: MIN_INTERVAL_MS_DEFAULT,
  llm: {
    enabled: false,
    provider: LLM_PROVIDER,
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 60000,
    maxCallsPerDay: 200,
    newBlockColor: DEFAULT_COLOR,
    maxToolRounds: 12,
  },
};

function sanitizeLlmSettings(input: unknown): LlmSettings {
  const raw = asRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.llm;
  return {
    enabled: raw.enabled === undefined ? fallback.enabled : raw.enabled === true,
    provider: typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : fallback.provider,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.slice(0, 400) : fallback.baseUrl,
    model: typeof raw.model === 'string' ? raw.model.slice(0, 120) : fallback.model,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.slice(0, 400) : fallback.apiKey,
    timeoutMs: clampInt(raw.timeoutMs, 1000, 300000, fallback.timeoutMs),
    maxCallsPerDay: clampInt(raw.maxCallsPerDay, 0, 100000, fallback.maxCallsPerDay),
    newBlockColor: typeof raw.newBlockColor === 'string' ? raw.newBlockColor.slice(0, 32) : fallback.newBlockColor,
    maxToolRounds: clampInt(raw.maxToolRounds, 1, 100, fallback.maxToolRounds),
  };
}

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
    llm: sanitizeLlmSettings(raw.llm),
  };
}

export interface Usage {
  date: string;
  calls: number;
  /** LLM 提交次数：与翻译的 calls 分账，跨天一起清零 */
  llmCalls: number;
}

/** 用量按天记：跨天自动清零，免得昨天烧完的配额今天还算在头上 */
export function sanitizeUsage(input: unknown, today: string): Usage {
  const raw = asRecord(input) ?? {};
  if (raw.date !== today) return { date: today, calls: 0, llmCalls: 0 };
  return {
    date: today,
    calls: clampInt(raw.calls, 0, 1000000, 0),
    llmCalls: clampInt(raw.llmCalls, 0, 1000000, 0),
  };
}
