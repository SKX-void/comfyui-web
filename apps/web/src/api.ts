/**
 * 宿主自己的 HTTP 封装。
 *
 * 注意：**这不是给插件用的 SDK** —— 按项目决策（docs/architecture.md §1.2 N3），
 * 插件自己写 fetch/EventSource，宿主不提供前端 SDK。
 */
export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function putJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${url} → HTTP ${res.status}`);
  return payload as T;
}
