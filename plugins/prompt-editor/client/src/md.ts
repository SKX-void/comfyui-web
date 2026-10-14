/**
 * 极简 Markdown 渲染器 —— 给 AI 回复用，**零依赖**。
 *
 * 为什么不用 marked / markdown-it：回复是模型现写的自由文本，为它引一个几十 KB 的解析器
 * 不划算（插件产物体积是刻意控制的）；anima-plus 有一份同样口径的实现（`client/src/md.ts`），
 * 但**跨插件 import 会把两个插件焊在一起**（插件目录必须各自自包含），所以这里是有意留的副本 ——
 * 改语法口径时两边一起改。**唯一已分叉的地方**：引用那一行（那边照 `^>` 匹配，转义之后永远不中）。
 *
 * 安全口径：**先把 HTML 转义，再套自己生成的标签**，所以回复里写 `<script>` 也只会显示成文本；
 * 链接只允许 `http(s)://`（相对链接在浏览器里没有意义，按普通文本显示）；HTML 注释直接隐藏。
 *
 * 它同时被契约测试直接调用（见 client/index.ts 的具名导出），所以这里是纯函数。
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESCAPES[ch] ?? ch);
}

/** 行内语法：`code` / **粗** / *斜* / [文字](http 链接)。输入必须是**已转义**的文本 */
function inline(text: string): string {
  // 行内代码先摘出来，免得里面的 * 或 [] 被后面的规则吃掉
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) =>
    /^https?:\/\//i.test(href)
      ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
      : `${label}（${href}）`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`);
}

/** 把 md 源码渲染成 HTML（除自身生成的标签外不含任何原始 HTML） */
export function renderMarkdown(source: string): string {
  const text = escapeHtml(source.replace(/<!--[\s\S]*?-->/g, ''));
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let table: string[][] | null = null;
  let fence = false;

  const closeList = (): void => {
    if (list !== null) {
      html.push(`</${list}>`);
      list = null;
    }
  };
  const closeTable = (): void => {
    if (table !== null && table.length > 0) {
      const head = table[0] ?? [];
      const rows = table.slice(1);
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows
            .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table>',
      );
    }
    table = null;
  };
  const flush = (): void => {
    closeList();
    closeTable();
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      flush();
      html.push(fence ? '</code></pre>' : '<pre><code>');
      fence = !fence;
      continue;
    }
    if (fence) {
      html.push(`${line}\n`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }

    // 表格：| a | b |（`| --- |` 分隔行丢掉）
    const rowMatch = /^\s*\|(.+)\|\s*$/.exec(line);
    if (rowMatch?.[1] !== undefined) {
      const cells = rowMatch[1].split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      closeList();
      table ??= [];
      table.push(cells);
      continue;
    }
    closeTable();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      closeList();
      const level = (heading[1] ?? '#').length;
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    // 引用：转义发生在分类**之前**，所以 `>` 到这里是 `&gt;`（照 `^>` 匹配永远不中，实测踩过）
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote !== null) {
      closeList();
      html.push(`<blockquote>${inline(quote[1] ?? '')}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet !== null || ordered !== null) {
      const want = bullet !== null ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        html.push(`<${want}>`);
        list = want;
      }
      html.push(`<li>${inline((bullet ?? ordered)?.[1] ?? '')}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }

  if (fence) html.push('</code></pre>');
  flush();
  return html.join('\n');
}
