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

/**
 * 读一个**静态文本资源**（`public/` 下的 md 这类）。
 *
 * `cache: 'no-store'` 是这条的关键：首页说明是"改产物里的文件就生效"的东西，
 * 让浏览器拿协商缓存会把改动藏起来（表现为"我明明改了 md，页面没变"）。
 */
export async function getText(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  // 文件不存在时，宿主（生产态）与 vite（开发态）都会回落到 index.html 兜底页 ——
  // 那是个 200，只有 content-type 能戳穿它。不拦的话页面会静默变成空白说明。
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`${url} 不存在（拿到的是 SPA 兜底页）`);
  }
  return await res.text();
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(payload.error ?? `${url} → HTTP ${res.status}`);
  return payload;
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
