/**
 * LLM 对接协议：OpenAI-compatible 非流式 chat + tool calling（D27）。
 *
 * 只做这一种协议、只做非流式：够用、好测、不用在服务端维护 SSE。baseUrl / apiKey / model
 * 由 settings.json 的 llm 段配置，key 只存在插件空间里，永不下发浏览器。
 *
 * 和翻译的 providers.ts 平行：那边按 `Provider { label, fields, translate }` 注册，
 * 这边只有一个协议实现 —— 想换协议时再加一个同签名的函数。
 */
import { errorMessage } from './util.js';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
}

export interface LlmChatResult {
  content: string;
  toolCalls: LlmToolCall[];
}

/** 最小抓取面：node 的 fetch 满足它，测试里塞个桩也容易 */
export interface LlmFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export class LlmError extends Error {
  readonly code: 'TIMEOUT' | 'AUTH' | 'RATE_LIMIT' | 'PROVIDER';
  readonly status: number;

  constructor(code: LlmError['code'], message: string, status: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

/** 一次 OpenAI-compatible chat 调用；错误一律 LlmError，调用方按 code 决定要不要重试 */
export async function openAiCompatibleChat(
  req: LlmChatRequest,
  fetchImpl: LlmFetch = fetch as unknown as LlmFetch,
): Promise<LlmChatResult> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(req.apiKey === '' ? {} : { authorization: `Bearer ${req.apiKey}` }),
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(req.tools === undefined || req.tools.length === 0 ? {} : { tools: req.tools, tool_choice: 'auto' }),
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      const message = readErrorMessage(raw) || `模型接口返回 HTTP ${response.status}`;
      if (response.status === 429) throw new LlmError('RATE_LIMIT', message, response.status);
      if (response.status === 401 || response.status === 403) throw new LlmError('AUTH', message, response.status);
      throw new LlmError('PROVIDER', message, response.status);
    }

    let data: unknown = null;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LlmError('PROVIDER', '模型接口返回的不是 JSON', response.status);
    }
    const record = asLooseRecord(data);
    const choice = Array.isArray(record.choices) ? asLooseRecord(record.choices[0]) : null;
    const message = choice === null ? null : asLooseRecord(choice.message);
    const content = message !== null && typeof message.content === 'string' ? message.content : '';
    const toolCalls: LlmToolCall[] = [];
    if (Array.isArray(message?.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = asLooseRecord(rawCall);
        const fn = asLooseRecord(call.function);
        if (typeof call.id === 'string' && typeof fn.name === 'string' && typeof fn.arguments === 'string') {
          toolCalls.push({ id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
        }
      }
    }
    return { content, toolCalls };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new LlmError('TIMEOUT', `模型响应超时（> ${req.timeoutMs}ms）`, 0);
    }
    throw new LlmError('PROVIDER', errorMessage(error), 0);
  } finally {
    clearTimeout(timer);
  }
}

function readErrorMessage(raw: string): string | null {
  try {
    const record = asLooseRecord(JSON.parse(raw));
    const nested = asLooseRecord(record.error);
    const message = nested.message ?? record.message;
    return typeof message === 'string' && message !== '' ? message : null;
  } catch {
    return null;
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asLooseRecord(value: unknown): Record<string, unknown> {
  return isRecordLike(value) ? value : {};
}
