/**
 * 翻译 provider 适配器：一家一个对象，上层只认"给我一批英文，还我一批中文"。
 * 签名 / 批量语义 / 限长 / 限速这些脏活全关在这里。
 *
 * 体验版一次只收一个 q（限 1000 字符），而且限流很紧：实测约 6 次/窗口就 411，
 * 触发后几十秒到几分钟才恢复。所以这里是**一次一个、两次之间至少隔 minIntervalMs、
 * 撞上 411 就退避重试**；`sleep`/`now` 可注入，测试里传 0 间隔就不会真等。
 */
import { MIN_INTERVAL_MS_DEFAULT } from './constants.js';
import { asRecord, sleepMs } from './util.js';

const YOUDAO_URL = 'https://aidemo.youdao.com/trans';
/** 撞上限流后退避多久（毫秒），第 n 次重试等 BACKOFF * 2^(n-1) */
const RATE_LIMIT_BACKOFF_MS = 20000;
const RATE_LIMIT_RETRIES = 2;

/** 用到的 fetch 面（默认是全局 fetch；测试里注入 stub 也照这个形状） */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: URLSearchParams; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ProviderOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  minIntervalMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Provider {
  label: string;
  /** 需要用户填的凭据字段（体验版一个都不要）；`GET /settings` 原样回给前端 */
  fields: string[];
  translate(texts: string[], options?: ProviderOptions): Promise<string[]>;
}

/**
 * 限流错误挂 `rateLimited` 标记：有道限流不走 HTTP 状态码（HTTP 一直是 200），
 * 上层只能靠这个标记决定退避重试，所以给 Error 加个子类（`new Error` 上挂属性过不了类型检查）。
 */
class ProviderCallError extends Error {
  rateLimited = false;
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof ProviderCallError && error.rateLimited;
}

/**
 * 打一次有道体验版。限流不走 HTTP 状态码（HTTP 一直是 200），
 * 而是在 body 里回 `{ errorCode: 411, msg: '请求频率过快' }` —— 所以必须读 body。
 * 限流错误挂 `rateLimited: true`，交给上层决定退避重试。
 */
async function youdaoOnce(
  text: string,
  { fetchImpl, timeoutMs }: { fetchImpl: FetchLike; timeoutMs: number },
): Promise<string> {
  const response = await fetchImpl(YOUDAO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: text.slice(0, 1000), from: 'en', to: 'zh-CHS' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.ok !== true) {
    const error = new ProviderCallError(`有道返回 HTTP ${response.status}`);
    error.rateLimited = response.status === 429 || response.status === 503;
    throw error;
  }
  const json = asRecord(await response.json()) ?? {};
  const code = String(json.errorCode ?? '');
  if (code === '411') {
    const error = new ProviderCallError('有道限流：请求频率过快');
    error.rateLimited = true;
    throw error;
  }
  if (code !== '0') throw new Error(`有道返回错误码 ${code}`);
  const translation = Array.isArray(json.translation) ? json.translation.join('') : String(json.translation ?? '');
  if (translation.trim() === '') throw new Error('有道返回了空译文');
  return translation;
}

/**
 * 全局节流：记"上一次真的打出去"的时刻。**跨请求、跨批次都算**——
 * 前端逐条发也一样，节流放在这里才是唯一说了算的地方。
 * 重挂插件会重置（模块级状态），这是可接受的：它只是限速，不是账本。
 */
let youdaoLastCallAt = 0;

export const PROVIDERS: Record<string, Provider> = {
  'youdao-demo': {
    label: '有道体验版（免费、无需 key）',
    fields: [],
    async translate(texts, options = {}) {
      const {
        fetchImpl = fetch,
        timeoutMs = 8000,
        minIntervalMs = MIN_INTERVAL_MS_DEFAULT,
        retries = RATE_LIMIT_RETRIES,
        sleep = sleepMs,
        now = Date.now,
      } = options;
      const out: string[] = [];
      for (const text of texts) {
        for (let attempt = 0; ; attempt += 1) {
          const wait = youdaoLastCallAt + minIntervalMs - now();
          if (wait > 0) await sleep(wait);
          youdaoLastCallAt = now();
          try {
            out.push(await youdaoOnce(text, { fetchImpl, timeoutMs }));
            break;
          } catch (error) {
            if (!isRateLimited(error) || attempt >= retries) throw error;
            await sleep(RATE_LIMIT_BACKOFF_MS * 2 ** attempt);
          }
        }
      }
      return out;
    },
  },
};
