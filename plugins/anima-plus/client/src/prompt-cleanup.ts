/**
 * 提示词整理（**手动按钮**用，不再自动跑）：行内去重 + 只合并连续逗号。
 *
 * 三条硬规矩 —— Anima 的 Qwen3 分词器把换行与句号当实打实的内容（plugins/anima-plus/docs/weilin.md §5.7）：
 *
 * 1. 换行只当**行边界**，一个字不动（空行也保留）；
 * 2. 句号、大小写、段内空格不动；也不会"帮你"补句号；
 * 3. 行尾逗号**保留**（可能是为下一行续写留的）。
 *
 * 另一条保守设计：**已经干净的行原样返回**。`a,b` 不会被顺手改成 `a, b`
 * —— 插一个空格同样会改变 token，只有真的删掉了东西的行才按 `", "` 重拼。
 *
 * 放在独立模块（而不是 SFC 内）是为了能被 `scripts/smoke.ts` 直接单测。
 */

export interface CleanupResult {
  text: string;
  /** 删掉的重复段数 */
  dupes: number;
  /** 合并掉的连续逗号数 */
  commas: number;
}

/** 按「括号深度 0 的逗号」切分：`(a, b:1.2)` 是一个段，不会被拆开 */
export function splitTopLevel(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '\\') {
      // `\,` 这类转义：连下一个字符一起吃进当前段
      buf += ch + (line[i + 1] ?? '');
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
  return parts;
}

export function cleanupLine(line: string): CleanupResult {
  const parts = splitTopLevel(line);
  const meaningful = parts.map((s) => s.trim()).filter(Boolean);
  // 整行没有内容（空行 / 纯空白 / 只有逗号）：原样留着，什么都不算
  if (meaningful.length === 0) return { text: line, dupes: 0, commas: 0 };

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const s of meaningful) {
    if (seen.has(s)) continue; // 行内去重：整串相等才算重复（`(a:1.2)` ≠ `a`）
    seen.add(s);
    kept.push(s);
  }
  const dupes = meaningful.length - kept.length;
  // 行尾逗号保留 → 它造成的那个"空段"不算被合并掉
  const trailing = /,\s*$/.test(line);
  let commas = parts.length - meaningful.length;
  if (trailing && (parts[parts.length - 1] ?? '').trim() === '') commas -= 1;

  // 没删掉任何东西 → 原样返回（不重排、不补空格、不动行尾逗号）
  if (dupes === 0 && commas === 0) return { text: line, dupes: 0, commas: 0 };
  const joined = kept.join(', ');
  return { text: trailing ? `${joined},` : joined, dupes, commas };
}

/** 整段整理：按行处理，行数与换行原样保留 */
export function cleanupPrompt(text: string): CleanupResult {
  let dupes = 0;
  let commas = 0;
  const out = text
    .split('\n')
    .map((line) => {
      const r = cleanupLine(line);
      dupes += r.dupes;
      commas += r.commas;
      return r.text;
    })
    .join('\n');
  return { text: out, dupes, commas };
}
