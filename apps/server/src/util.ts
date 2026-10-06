/** `unknown` 错误 → 可读字符串（日志与 HTTP 响应共用同一口径） */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
