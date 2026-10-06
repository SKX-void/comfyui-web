/** 与业务无关的小工具：谁都能用，谁也不依赖。 */
import path from 'node:path';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 描述提示词与正向提示词的手工拼接（前端预览要用同一套规则，见 client/src 里的 joinedPrompt）。
 * 首尾的空格与逗号会被清掉 —— 工作流自带的正向文本末尾就带一个逗号，直接连会出现 ", ,"；
 * 两侧都空则结果是空串。
 */
export function joinPrompt(description: unknown, positive: unknown): string {
  const parts = [description, positive]
    .map((text) => String(text ?? '').trim().replace(/^[,\s]+/, '').replace(/[,\s]+$/, ''))
    .filter((text) => text !== '');
  return parts.join(', ');
}

/** 53 位随机种子：超过 MAX_SAFE_INTEGER 会在 JSON 往返中失真 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 53);
}

export function extFor(contentType: string, filename: string): string {
  const byType: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  const fromType = byType[String(contentType).split(';')[0]?.trim().toLowerCase() ?? ''];
  if (fromType) return fromType;
  const ext = path.extname(String(filename)).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.png';
}
