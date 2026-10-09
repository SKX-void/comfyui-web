/**
 * 表单初值：把 `/settings` 的 `effective`（未知形状的 JSON）收敛成参数对象。
 *
 * 收敛规则与服务端 `server/settings.ts` 的 `resolveSettings` 对齐（同一套默认值），
 * 所以两个表单（主页面 / 设置面板）共用这里，不再各写一份。
 */
import type { TaggerParams } from './types';

export const DEFAULT_PARAMS: TaggerParams = {
  threshold: 0.35,
  characterThreshold: 0.85,
  replaceUnderscore: true,
  trailingComma: false,
  excludeTags: '',
};

export function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function ratio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 1)
    : fallback;
}

export function toParams(values: Record<string, unknown>): TaggerParams {
  return {
    threshold: ratio(values.threshold, DEFAULT_PARAMS.threshold),
    characterThreshold: ratio(values.characterThreshold, DEFAULT_PARAMS.characterThreshold),
    replaceUnderscore:
      typeof values.replaceUnderscore === 'boolean'
        ? values.replaceUnderscore
        : DEFAULT_PARAMS.replaceUnderscore,
    trailingComma:
      typeof values.trailingComma === 'boolean'
        ? values.trailingComma
        : DEFAULT_PARAMS.trailingComma,
    excludeTags: typeof values.excludeTags === 'string' ? values.excludeTags : '',
  };
}
