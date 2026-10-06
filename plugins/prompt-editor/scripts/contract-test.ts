/**
 * 契约测试 —— 没有浏览器时的替代验证（照 anima-example/scripts/contract-test.mjs 的套路）。
 *
 * 按宿主外壳消费插件的方式走一遍：
 *   1. 注入样式需要一个最小 document 桩；
 *   2. import 产物 client.js：顶层代码必须能求值（`injectStylesheet()` 就在顶层跑）；
 *   3. 读 default.tabs / default.routes：tab 的 id/title/order 与路由形状必须对；
 *   4. SSR 把组件真渲染成 HTML：模板里的**运行期**错误（访问 undefined 的属性等）
 *      会在这里炸出来，而 vue-tsc 与 vite build 都不报；
 *   5. 切分 / 重切 / 输出 / 服务端收敛这些纯函数直接断言（这个插件的主要逻辑就在这儿）。
 *
 * SSR 不走 onMounted，所以不会发请求；它验的是"渲染不炸 + 首屏结构对"。
 * 交互（点击改名、拖动、双击禁用、预设面板）仍然只能由人眼确认。
 *
 * 用法：node plugins/prompt-editor/scripts/contract-test.ts（Node 24+ 直接跑 TS）
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import { newId, reflow, renderOutput, splitSentences, splitTags, type Doc, type Item } from '../client/src/model.ts';
import { sanitizeDoc } from '../server.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : '  → ' + String(detail)));
  if (!ok) failed += 1;
}

// ── 1. 最小 document 桩：产物顶层会注入 <link> ────────────────────────────────
const links: { dataset: Record<string, string>; rel: string; href: string }[] = [];
(globalThis as Record<string, unknown>).document = {
  querySelector: (selector: string) => links.find((l) => selector.includes(l.dataset.pluginCss ?? '')) ?? null,
  createElement: () => ({ dataset: {} as Record<string, string>, rel: '', href: '' }),
  head: { appendChild: (el: (typeof links)[number]) => links.push(el) },
};

// ── 2. 产物里的裸 `import 'vue'` 在浏览器由页面 import map 解析，Node 侧自己挂钩子 ──
{
  const resolved = import.meta.resolve('vue', import.meta.url);
  const source =
    `const MAP = ${JSON.stringify({ vue: resolved })};\n` +
    'export async function resolve(specifier, context, next) {\n' +
    '  if (Object.prototype.hasOwnProperty.call(MAP, specifier)) {\n' +
    '    return { url: MAP[specifier], shortCircuit: true };\n' +
    '  }\n' +
    '  return next(specifier, context);\n' +
    '}\n';
  register('data:text/javascript,' + encodeURIComponent(source));
}

const tabDir =
  process.env.TAB_OUT_DIR ?? fileURLToPath(new URL('../../../tabs/prompt-editor/', import.meta.url));
const artifact = (name: string) => pathToFileURL(path.join(tabDir, name));

const plugin = (await import(artifact('client.js').href)).default as {
  tabs?: { id: string; title: string; order: number }[];
  routes?: { path: string; component: unknown }[];
};

console.log('产物契约');
check('产物默认导出是对象', plugin !== null && typeof plugin === 'object');
check('tabs 是非空数组', Array.isArray(plugin.tabs) && plugin.tabs.length > 0);
const tab = plugin.tabs?.[0];
check('tab.id = prompt-editor', tab?.id === 'prompt-editor', tab?.id);
check('tab.title = 提示词编辑器', tab?.title === '提示词编辑器', tab?.title);
check('tab.order 是数字', typeof tab?.order === 'number', tab?.order);
check('routes 是非空数组', Array.isArray(plugin.routes) && plugin.routes.length > 0);
const route = plugin.routes?.[0];
check('route.path 是空串（tab 根路径）', route?.path === '', JSON.stringify(route?.path));
check('route.component 是组件', route !== null && typeof route?.component === 'object');
check('样式表已注入 <link>', links.length === 1, links.map((l) => l.href).join(','));
check(
  '样式 URL 指向本插件产物',
  links.length === 1 && (links[0]?.href ?? '').endsWith('/prompt-editor/client.css'),
  links[0]?.href,
);

// ── 3. SSR：真渲染一次（首屏 = 三个空区块 + 输出区空态） ──────────────────────
let html = '';
let renderError: unknown = null;
try {
  html = await renderToString(createSSRApp(route?.component as never));
} catch (err) {
  renderError = err;
}
console.log('SSR 首屏');
check('SSR 渲染不抛错', renderError === null, renderError === null ? undefined : String(renderError));
check('渲染出插件根元素', html.includes('cw-prompt-editor'));
check('渲染出模式开关两个选项', html.includes('tag 风格') && html.includes('自然语言'));
check(
  '默认停在 tag 模式（那个按钮带 active）',
  /<button class="active"[^>]*>\s*tag 风格/.test(html),
  (html.match(/<button class="active"[^>]*>[^<]*/) ?? [''])[0],
);
check('渲染出首屏三个区块', ['质量', '主体', '场景'].every((t) => html.includes(t)));
check('区块里有添加输入框', html.includes('添加 tag'));
check('渲染出输出区与复制按钮', html.includes('输出') && html.includes('复制'));
check('输出为空时给出提示', html.includes('左边写点什么'));
check('渲染出新建区块按钮', html.includes('+ 新建区块'));
check('渲染出预设库入口', html.includes('预设库'));

// ── 4. 切分 / 重切 / 输出 ─────────────────────────────────────────────────────
const item = (text: string, enabled = true, translation = ''): Item => ({
  id: `id-${text}`,
  text,
  enabled,
  translation,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('切分规则');
check('tag：括号深度 0 的逗号才切', same(splitTags('a, b, (c, d:1.2), e'), ['a', 'b', '(c, d:1.2)', 'e']));
check('tag：转义逗号不切', same(splitTags('a, e\\, f'), ['a', 'e\\, f']));
check('tag：空段丢弃', same(splitTags('a, , b,'), ['a', 'b']));
check('自然语言：句号断句且句号留在前一句', same(splitSentences('A girl. She runs.'), ['A girl.', 'She runs.']));
check('自然语言：小数不切', same(splitSentences('Scale 1.5 ratio'), ['Scale 1.5 ratio']));
check('自然语言：没有句号就是一句', same(splitSentences('silver hair'), ['silver hair']));

console.log('切换视图（reflow）');
const tags = [item('masterpiece'), item('best quality', false, '最佳质量')];
check('tag → 自然语言：拼回后按句号切', same(reflow(tags, 'tag', 'text').map((i) => i.text), ['masterpiece, best quality']));
check('往返稳（切回 tag 又是两块）', same(reflow(reflow(tags, 'tag', 'text'), 'text', 'tag').map((i) => i.text), ['masterpiece', 'best quality']));
check('切分粒度变了：禁用态不继承', reflow(tags, 'tag', 'text')[0]?.enabled === true);
check('整串仍相等的条目继承译文', reflow([item('A girl.', true, '一个女孩')], 'text', 'tag')[0]?.translation === '一个女孩');

console.log('输出拼接');
const doc: Doc = {
  version: 1,
  mode: 'tag',
  blocks: [
    { id: 'b1', title: '质量', color: '#6ea8fe', items: [item('masterpiece'), item('best quality', false)] },
    { id: 'b2', title: '主体', color: '#4ac38a', items: [item('1girl'), item('solo')] },
    { id: 'b3', title: '空的', color: '#f2b84b', items: [item('   ')] },
  ],
};
check('禁用条目不进输出、空区块不留空行、区块间换行', renderOutput(doc) === 'masterpiece\n1girl, solo', JSON.stringify(renderOutput(doc)));
check('自然语言模式用空格连接', renderOutput({ ...doc, mode: 'text' }) === 'masterpiece\n1girl solo');

// ── 5. 服务端收敛：请求体与手改坏的文件都不该让页面炸 ────────────────────────
console.log('服务端收敛（sanitizeDoc）');
check('非对象 → null', sanitizeDoc('nope') === null);
const filled = sanitizeDoc({ blocks: [{ items: [{ text: 'a' }] }] })?.blocks[0]?.items[0];
check('缺字段给默认值', filled?.text === 'a' && filled?.enabled === true && filled?.translation === '');
check('mode 不认识就回落 tag', sanitizeDoc({ mode: 'wat', blocks: [] })?.mode === 'tag');
check('超长文本被截断', sanitizeDoc({ blocks: [{ items: [{ text: 'x'.repeat(5000) }] }] })?.blocks[0]?.items[0]?.text.length === 4000);
check('非对象条目被丢掉', sanitizeDoc({ blocks: [{ items: [1, { text: 'keep' }] }] })?.blocks[0]?.items.length === 1);

console.log('id 生成（局域网 http = 非安全上下文）');
// `crypto.randomUUID` 只在安全上下文（https / localhost）存在 —— 部署常常是 http://10.x.x.x，
// 所以这里把两种降级路径都跑一遍：有 getRandomValues、连 crypto 都没有。
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const fakeCrypto = (value: unknown): void => {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
};
try {
  fakeCrypto({
    getRandomValues: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i * 7 + 1;
      return bytes;
    },
  });
  const fromGetRandomValues = newId();
  check('没有 randomUUID 也能出 v4 UUID', UUID_V4.test(fromGetRandomValues), fromGetRandomValues);

  fakeCrypto(undefined);
  const ids = new Set([newId(), newId(), newId()]);
  check('连 crypto 都没有也不抛，且 id 互不相同', ids.size === 3 && [...ids].every((id) => UUID_V4.test(id)));

  // 直接复现线上那次报错：非安全上下文里首屏也要能渲染出来
  const insecureHtml = await renderToString(createSSRApp(route?.component as never));
  check(
    '非安全上下文下 SSR 首屏仍能渲染',
    insecureHtml.includes('质量') && insecureHtml.includes('输出'),
  );
} finally {
  if (cryptoDescriptor === undefined) delete (globalThis as Record<string, unknown>).crypto;
  else Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
}

console.log(failed === 0 ? '\n✅ 契约测试通过' : `\n❌ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
