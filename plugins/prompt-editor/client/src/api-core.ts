/**
 * 接口层的地基：前缀 + 取 JSON 的那一次 fetch。
 *
 * 单独一层是因为**取 JSON 的错误信封只有一份**（后端的 `{ error: { code, message } }`），
 * 拆出去之后 `api.ts` / `api-block.ts` 都只是"路径 + 形状"，不用各自再写一遍错误处理。
 */
export const API_BASE = '/api/p/prompt-editor';

interface ErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * 带 code 的接口错误。
 *
 * 调用方要分支的是**code**（`LLM_DISABLED` 这类稳定标识），message 是给人看的、会改；
 * 早先只抛 message，于是"总闸没开"被当成读失败报了出来。
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  const raw = await response.text();
  const data: unknown = raw === '' ? null : JSON.parse(raw);
  if (!response.ok) {
    const error = (data as ErrorBody | null)?.error;
    throw new ApiError(
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      error?.code ?? '',
      response.status,
    );
  }
  return data as T;
}
