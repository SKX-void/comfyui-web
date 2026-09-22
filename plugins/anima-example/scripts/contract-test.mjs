/**
 * 插件前端产物的契约测试 —— 没有浏览器时的替代验证。
 *
 * 它按宿主外壳消费插件的方式走一遍：
 *   1. 注入样式（<link>）需要一个最小 document 桩
 *   2. import(plugin.clientUrl)：产物顶层代码必须能求值，不许抛
 *   3. 读 default.tabs / default.routes：tab 的 id/title/order、路由形状必须对
 *   4. 用 SSR 把组件真渲染成 HTML：模板里的**运行期**错误（访问 null 的属性等）
 *      会在这里炸出来，而这类错误 vue-tsc 与 vite build 都不报
 *
 * 注意：SSR 不走 onMounted，所以不会发请求；它验的是"渲染不炸 + 首屏结构对"。
 * 交互（点击、SSE 更新、图片显示）仍然只能由人眼确认。
 *
 * 用法：node plugins/anima-example/scripts/contract-test.mjs
 */
import { readFile } from 'node:fs/promises';

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

const links = [];
globalThis.document = {
  querySelector: (sel) => links.find((l) => sel.includes(l.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {}, rel: '', href: '' }),
  head: { appendChild: (el) => links.push(el) },
};

const mod = await import(new URL('../lib/client.js', import.meta.url).href);
const plugin = mod.default;

let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : '  → ' + detail));
  if (!ok) failed += 1;
}

check('产物默认导出是对象', plugin !== null && typeof plugin === 'object');
check('tabs 是非空数组', Array.isArray(plugin.tabs) && plugin.tabs.length > 0);

const tab = plugin.tabs[0];
check('tab.id = anima-example', tab.id === 'anima-example', tab.id);
check('tab.title = 默认Anima', tab.title === '默认Anima', tab.title);
check('tab.order 是数字', typeof tab.order === 'number', String(tab.order));

check('routes 是非空数组', Array.isArray(plugin.routes) && plugin.routes.length > 0);
const route = plugin.routes[0];
check('route.path 是字符串', typeof route.path === 'string', JSON.stringify(route.path));
check('route.component 是组件', route.component !== null && typeof route.component === 'object');

check('样式表已注入 <link>', links.length === 1, links.map((l) => l.href).join(','));
check(
  '样式 URL 指向本插件产物',
  links.length === 1 && links[0].href.endsWith('/plugins/anima-example/lib/client.css'),
  links[0]?.href,
);

// ── SSR：真渲染一次 ────────────────────────────────────────────────────────
let html = '';
let renderError = null;
try {
  html = await renderToString(createSSRApp(route.component));
} catch (err) {
  renderError = err;
}
check('SSR 渲染不抛错', renderError === null, renderError === null ? undefined : String(renderError));
check('渲染出插件根元素', html.includes('cw-anima-example'));
check('渲染出插件标题', html.includes('默认Anima'));
check('渲染出描述提示词（主输入框）', html.includes('描述提示词'));
check('渲染出正向提示词（折叠）', html.includes('正向提示词'));
check('渲染出负向提示词（折叠）', html.includes('负向提示词'));
check('渲染出尺寸输入', html.includes('尺寸'));
check('渲染出空态提示', html.includes('还没有作业'));
check('未加载选项时不崩（下拉为空）', html.includes('采样器'));
// 两个提示词都空时不该显示拼接预览（否则会显示一条空行）
check('空提示词时不显示拼接预览', !html.includes('拼给 ComfyUI'));

// 滑条上限只能在产物里查：SSR 首屏 options 还没加载，LoRA 那一块是 v-if 关掉的。
// 产物里模板渲染函数没被压紧（`type: "range"` 带空格），所以正则要容忍空白。
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const rangeAt = bundle.search(/type:\s*"range"/);
const rangeAttrs = rangeAt === -1 ? '' : bundle.slice(rangeAt, rangeAt + 120);
check('LoRA 强度滑条 max = 1', /max:\s*"1"/.test(rangeAttrs), rangeAttrs.replace(/\s+/g, ' ').slice(0, 70));

// ── 安全护栏 ────────────────────────────────────────────────────────────────
// example 是"照抄一份就能用"的参考实现，所以护栏本身也要有契约：常量、最终校验、
// 以及前端输入框真的绑上了上下限（SSR 首屏 options 未加载 → 用的是兜底值）。
const { SAFETY, assertGraphSafe } = await import(new URL('../server.js', import.meta.url).href);
check('护栏常量：步数上限 32', SAFETY.maxSteps === 32, String(SAFETY.maxSteps));
check(
  '护栏常量：边长 64~1216',
  SAFETY.maxSide === 1216 && SAFETY.minSide === 64,
  `${SAFETY.minSide}~${SAFETY.maxSide}`,
);

// 绑定的节点号取自 workflow.json（KSampler / EmptyLatentImage）
const safeBindings = { samplerId: '56', latentId: '32' };
const safeGraph = {
  56: { inputs: { steps: 32 } },
  32: { inputs: { width: 1216, height: 1216 } },
};
check('合法图通过最终校验', assertGraphSafe(safeGraph, safeBindings).length === 0);
check(
  '步数 33 被拦',
  assertGraphSafe({ ...safeGraph, 56: { inputs: { steps: 33 } } }, safeBindings).length === 1,
);
check(
  '宽度 1217 被拦',
  assertGraphSafe({ ...safeGraph, 32: { inputs: { width: 1217, height: 1216 } } }, safeBindings).length === 1,
);
check(
  '非整数/非数字也被拦（不能把 1024.5 或 null 打到 ComfyUI）',
  assertGraphSafe({ ...safeGraph, 32: { inputs: { width: 1024.5, height: null } } }, safeBindings).length === 2,
);
check('工作流自带值本身合法（832×1216 / 6 步）', assertGraphSafe(safeGraph, safeBindings).length === 0);
check(
  '前端输入框绑上了护栏（SSR 首屏渲染出 max）',
  html.includes('max="1216"') && html.includes('max="32"'),
);

console.log(failed === 0 ? '\n✅ 契约测试通过' : '\n❌ ' + failed + ' 项不通过');
process.exit(failed === 0 ? 0 : 1);
