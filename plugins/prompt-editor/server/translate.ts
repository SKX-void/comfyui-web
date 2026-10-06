/**
 * 批量翻译：**词库优先**（命中就不发请求），未命中的才交给 provider。
 *
 * **现翻的结果不进词库**：词库只装"人认可过的"（手改 / 显式保存）。现翻结果放
 * `apiCache`（进程内，重挂就没），它只用来避免同一个词在一个会话里被反复翻 ——
 * 体验版限流很紧（约 6 次/窗口），能少发一次是一次。
 *
 * 依赖注入（fetchImpl / now / usage / apiCache）是为了能在契约测试里跑 stub，不碰真网。
 * 返回的 `results` 严格按入参顺序对齐：results[i] 对应 texts[i]，前端自己记 id ↔ 下标。
 */
import { maskPromptSyntax, tagKey, type MaskPlan } from './prompt.js';
import { PROVIDERS, isRateLimited, type FetchLike } from './providers.js';
import { DEFAULT_SETTINGS, type Settings, type Usage } from './settings.js';
import { tagsLookup, type Tags } from './tags.js';
import { errorMessage } from './util.js';

export interface TranslateOptions {
  tags?: Tags;
  settings?: Settings;
  usage?: Usage | null;
  apiCache?: Map<string, string> | null;
  fetchImpl?: FetchLike;
  /** sleep / now 透传给 provider：测试注入 no-op 就不真等节流 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

/** 一条结果是怎么来的：dict 库命中 · api 现翻 · empty 空串 · pending 还没定 · skip 语法跳过 · error 没翻成 */
export type TranslateSource = 'dict' | 'api' | 'empty' | 'pending' | 'skip' | 'error';

export interface TranslateResult {
  text: string;
  translation: string;
  source: TranslateSource;
}

export interface TranslateOutcome {
  results: TranslateResult[];
  error?: { code: string; message: string };
}

export async function translateTexts(texts: string[], options: TranslateOptions = {}): Promise<TranslateOutcome> {
  const {
    tags = { version: 2, entries: {}, aliasIndex: {} },
    settings = DEFAULT_SETTINGS,
    usage = null,
    apiCache = null,
    fetchImpl = fetch,
    sleep = undefined,
    now = undefined,
  } = options;

  const provider = PROVIDERS[settings.provider];
  const results: TranslateResult[] = texts.map((text) => {
    const hit = tagsLookup(tags, text);
    // 词库命中：人认可的标 user（「我」），导入/内置的标 dict（「库」）—— 前端据此画标记
    // 词条自己的 source（user/import/builtin）跟工作区的徽章无关：命中就是"在库里"
    if (hit !== null) return { text, translation: hit.zh, source: 'dict' };
    const key = tagKey(text);
    if (key === '') return { text, translation: '', source: 'empty' };
    const cached = apiCache?.get(key);
    // 会话内记得的现翻结果：还是"机翻"（视觉标记不变），只是这次不再打接口
    if (typeof cached === 'string' && cached !== '') return { text, translation: cached, source: 'api' };
    return { text, translation: '', source: 'pending' };
  });

  // 掩码剥开：`(x:1.2)` 只把 x 交出去，一个片段算一次 provider 调用
  const groups: { index: number; plan: MaskPlan; fragments: string[] }[] = [];
  results.forEach((result, index) => {
    if (result.source !== 'pending') return;
    const plan = maskPromptSyntax(result.text);
    if (plan.skip === true || plan.parts.length === 0) {
      results[index] = { text: result.text, translation: '', source: 'skip' };
      return;
    }
    groups.push({ index, plan, fragments: plan.parts });
  });

  if (groups.length === 0 || provider === undefined) return { results };

  // 配额按**整条文本**算：宁可少翻几条，也不能翻一半（`{a|b}` 只翻一支会拼出半个结构）
  const budget = usage === null ? Infinity : Math.max(0, settings.maxCallsPerDay - usage.calls);
  const chosen: typeof groups = [];
  let cost = 0;
  for (const group of groups) {
    if (cost + group.fragments.length > budget) break;
    cost += group.fragments.length;
    chosen.push(group);
  }

  let truncated = false;
  if (chosen.length === 0 && budget <= 0) truncated = true;

  if (chosen.length > 0) {
    const fragments = chosen.flatMap((group) => group.fragments);
    let translations: string[];
    try {
      translations = await provider.translate(fragments, {
        fetchImpl,
        timeoutMs: settings.timeoutMs,
        minIntervalMs: settings.minIntervalMs,
        sleep,
        now,
      });
    } catch (error) {
      for (const group of chosen) {
        results[group.index] = { text: texts[group.index] ?? '', translation: '', source: 'error' };
      }
      return {
        results,
        error: {
          code: isRateLimited(error) ? 'RATE_LIMIT' : 'PROVIDER',
          message: errorMessage(error),
        },
      };
    }
    if (usage !== null) usage.calls += fragments.length;
    let cursor = 0;
    for (const group of chosen) {
      const parts = translations.slice(cursor, cursor + group.fragments.length);
      cursor += group.fragments.length;
      const translation = group.plan.rebuild(parts).trim();
      results[group.index] = { text: texts[group.index] ?? '', translation, source: 'api' };
      if (translation !== '') apiCache?.set(tagKey(texts[group.index]), translation);
    }
    truncated = truncated || cost < groups.reduce((n, group) => n + group.fragments.length, 0);
    // 配额没轮上的别把内部状态漏给前端：统一标 error（前端据此知道"这次没翻成、别马上重试"）
    results.forEach((result, index) => {
      if (result.source === 'pending') results[index] = { text: texts[index] ?? '', translation: '', source: 'error' };
    });
    return {
      results,
      ...(truncated
        ? { error: { code: 'QUOTA', message: `今日翻译次数已用完（上限 ${settings.maxCallsPerDay}）` } }
        : {}),
    };
  }

  for (const group of groups) {
    results[group.index] = { text: texts[group.index] ?? '', translation: '', source: 'error' };
  }
  return {
    results,
    error: { code: 'QUOTA', message: `今日翻译次数已用完（上限 ${settings.maxCallsPerDay}）` },
  };
}
