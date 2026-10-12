/**
 * 区块内容的切分规则 —— 与前端 `client/src/model.ts` 的 splitTags / splitSentences /
 * splitByMode **逐字同款**：LLM 写一个区块时只给一整份 `content`，服务端按区块的 mode
 * 在这里切成条目，保证"服务端切出来的条目"和"人粘贴进去时前端切出来的"是同一套语义。
 *
 * 改规则时必须两侧一起改（契约测试两侧都断言）。
 */
import type { Mode } from './constants.js';

/**
 * tag 切分：只在**括号深度 0** 的逗号处切，`(a, b:1.2)` 是一个块。
 * 转义 `\,` 连下一个字符一起吃进当前段（与 anima-plus 的提示词整理同款规则）。
 */
export function splitTags(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      buf += ch + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 自然语言切分：在**英文句号**处断句，句号留在前一句里。
 * 只认「句号 + 空白 / 结尾」，所以 `1.5`、`v1.2` 这类不会被切开。
 */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    buf += ch;
    const next = text[i + 1];
    if (ch === '.' && (next === undefined || /\s/.test(next))) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf !== '') parts.push(buf);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

export function splitByMode(text: string, mode: Mode): string[] {
  return mode === 'tag' ? splitTags(text) : splitSentences(text);
}
