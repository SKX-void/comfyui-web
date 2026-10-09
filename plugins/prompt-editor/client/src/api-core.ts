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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  const raw = await response.text();
  const data: unknown = raw === '' ? null : JSON.parse(raw);
  if (!response.ok) {
    const message = (data as ErrorBody | null)?.error?.message;
    throw new Error(message ?? `请求失败（HTTP ${response.status}）`);
  }
  return data as T;
}
