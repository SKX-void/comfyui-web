/**
 * 提示词工具：权重语法掩码 + 词库键归一化 + 字符串数组收敛。
 */

/** 三种包法各自的收尾符（`(x)` / `[x]` / `{a|b}`） */
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

export interface MaskPlan {
  /** 整条都是标识符（`<lora:...>`）：别翻 */
  skip?: boolean;
  /** 真正要发出去的片段：一个片段算一次 provider 调用 */
  parts: string[];
  /** 把译文按原结构贴回去 */
  rebuild: (translated: string[]) => string;
}

/**
 * 权重语法掩码：MT 接口不认识 `(masterpiece:1.2)` 这种写法，整条丢过去会翻出
 * `（杰作：1.2）` 之类直接不能用的东西。所以先把"要翻的词"剥出来，翻完按原样贴回。
 *
 * 认 `(x)` `(x:1.2)` `[x]` `[x:1.2]` `{a|b}` `x:1.2`；`<lora:...>` 跳过
 * （模型名是标识符，翻了就废）。认不出来就整条当普通文本翻。
 */
export function maskPromptSyntax(input: unknown): MaskPlan {
  const text = String(input ?? '').trim();
  if (text === '') return { parts: [], rebuild: () => '' };
  if (text.startsWith('<') && text.endsWith('>')) return { skip: true, parts: [], rebuild: () => text };

  const first = text.charAt(0);
  const last = text.charAt(text.length - 1);
  const closer = CLOSERS[first];

  if (closer === last) {
    const inner = text.slice(1, -1).trim();
    if (first === '{') {
      const parts = inner.split('|').map((part) => part.trim());
      if (parts.length > 1 && parts.every((part) => part !== '')) {
        return { parts, rebuild: (translated) => `{${translated.join('|')}}` };
      }
    } else {
      const weighted = /^(.*?):([\d.]+)$/.exec(inner);
      const word = (weighted === null ? inner : (weighted[1] ?? '')).trim();
      // 词里还带冒号说明是 `[a:b:0.5]` 这类交替语法，结构我们没解析，别硬翻
      if (word !== '' && !word.includes(':')) {
        const weight = weighted === null ? '' : `:${weighted[2] ?? ''}`;
        return { parts: [word], rebuild: (translated) => `${first}${translated[0] ?? word}${weight}${last}` };
      }
    }
  }

  // 裸的 `tag:1.2`：只在完全没有空格时才认，免得把 "time: 5" 这种句子切坏
  const bare = /^([^\s:]+):([\d.]+)$/.exec(text);
  if (bare !== null) {
    return { parts: [bare[1] ?? ''], rebuild: (translated) => `${translated[0] ?? bare[1] ?? ''}:${bare[2] ?? ''}` };
  }

  return { parts: [text], rebuild: (translated) => translated[0] ?? text };
}

/**
 * 词库键：tag 大小写不敏感（`1Girl` 和 `1girl` 是同一条），空白折叠。
 * 正名键和别名键都用它归一化，查表才能一次命中。
 */
export function tagKey(input: unknown): string {
  return String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 字符串数组收敛：去空、去重、截断、限个数。不是数组就返回 null（调用方好区分"没给"和"给了空的"） */
export function strList(value: unknown, max: number, itemMax: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const one = typeof item === 'string' ? item.trim().slice(0, itemMax) : '';
    if (one !== '' && !out.includes(one)) out.push(one);
    if (out.length >= max) break;
  }
  return out;
}
