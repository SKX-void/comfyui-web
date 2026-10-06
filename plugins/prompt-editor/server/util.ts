/**
 * 与业务无关的小工具：谁都能用，谁也不依赖。
 */

/**
 * 外部输入（盘上的 JSON、请求体）的"是不是一层普通对象"检查。
 * TS 的 `typeof x === 'object'` 窄化不出索引签名，所以用它一步拿到 `Record<string, unknown>`；
 * 数组与 null 都不算 —— 与原来那些 `Array.isArray(x)` 的拒绝分支同一个判定。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `asRecord` 的判定版：给数组 filter 用（`filter(asRecord)` 丢不出类型） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

/**
 * 老数据里的枚举值映射（`api` → `import` 之类）。
 * 键来自外部输入，可能是任何类型 —— 只有字符串键查得到，其余给 undefined（调用方自己定兜底）。
 */
export function remap(map: Record<string, string>, value: unknown): string | undefined {
  return typeof value === 'string' ? map[value] : undefined;
}

/** 整数收敛：`Number` 化 + 取整 + 夹到 [min, max]，NaN / 非数一律 fallback */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 未知错误的文案：`String(error?.message ?? error)` 的 TS 版（外部/未知错误只能现查） */
export function errorMessage(error: unknown): string {
  const message = asRecord(error)?.message;
  return message === undefined || message === null ? String(error) : String(message);
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
