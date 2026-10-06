/** WeiLin REST 传输层：URL 前缀、超时、非 2xx 统一抛错。 */

export class WeilinHttp {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  url(pathname: string): string {
    return `${this.baseUrl}/weilin/prompt_ui/api/${pathname}`;
  }

  async post<T>(pathname: string, body: unknown = {}): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WeiLin ${pathname} 返回 ${res.status}`);
    return (await res.json()) as T;
  }

  async get<T>(pathname: string): Promise<T> {
    const res = await fetch(this.url(pathname), {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WeiLin ${pathname} 返回 ${res.status}`);
    return (await res.json()) as T;
  }
}
