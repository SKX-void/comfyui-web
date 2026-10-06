#!/usr/bin/env node
/**
 * 外壳隔离测试 —— 没有浏览器时，怎么验「一个插件页面崩了不许带走整个外壳」。
 *
 * 这条链路上真正的坑在 Vue 调度器内部：dev 构建（宿主 dev 态 import map 加载的就是它）对
 * **没人接住**的组件错误是直接 `throw err`，而抛出点在 `flushJobs` 里 —— 于是这次 flush 的
 * promise 变成未处理拒绝（浏览器里就是 `Uncaught (in promise)`），补丁停在半路；之后每次切 tab
 * 都会再抛 `Cannot read properties of null (reading 'component')`。浏览器里只能看到
 * 「白屏 + 切 tab 没反应」，所以这里用那份 Vue 构建 + 自建 renderer 把机制复现出来，
 * 并对真的 `src/plugin-boundary.ts` 做断言。
 *
 * 用法：node apps/web/scripts/isolation-test.mjs
 */
import { register } from 'node:module';

// 把裸 `vue` 指到宿主 dev 态真正加载的那份构建：re-throw 行为只有 dev 版才有
{
  const devVue = import.meta.resolve('vue/dist/vue.esm-browser.js');
  const source =
    `const MAP = ${JSON.stringify({ vue: devVue })};\n` +
    'export async function resolve(specifier, context, next) {\n' +
    '  if (Object.prototype.hasOwnProperty.call(MAP, specifier)) {\n' +
    '    return { url: MAP[specifier], shortCircuit: true };\n' +
    '  }\n' +
    '  return next(specifier, context);\n' +
    '}\n';
  register('data:text/javascript,' + encodeURIComponent(source));
}

const { createRenderer, defineComponent, h, shallowRef } = await import('vue');
const { PluginBoundary } = await import('../src/plugin-boundary.ts');

let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : '  → ' + String(detail)));
  if (!ok) failed += 1;
}

// ── 最小 DOM：够 createRenderer 跑起来，并能把树打印成一行 ────────────────────
const makeNode = (tag) => ({ tag, props: {}, children: [], parent: null });
const nodeOps = {
  createElement: (tag) => makeNode(tag),
  createText: (text) => ({ tag: '#text', text, parent: null }),
  createComment: (text) => ({ tag: '#comment', text, parent: null }),
  setText: (node, text) => {
    node.text = text;
  },
  setElementText: (el, text) => {
    el.children = [{ tag: '#text', text, parent: el }];
  },
  insert: (child, parent, anchor) => {
    child.parent = parent;
    const at = anchor === null || anchor === undefined ? -1 : parent.children.indexOf(anchor);
    parent.children.splice(at === -1 ? parent.children.length : at, 0, child);
  },
  remove: (child) => {
    const parent = child.parent;
    if (parent === null || parent === undefined) return;
    const at = parent.children.indexOf(child);
    if (at !== -1) parent.children.splice(at, 1);
  },
  parentNode: (node) => node.parent ?? null,
  nextSibling: (node) => {
    const parent = node.parent;
    if (parent === null || parent === undefined) return null;
    const at = parent.children.indexOf(node);
    return at === -1 ? null : (parent.children[at + 1] ?? null);
  },
  querySelector: () => null,
  setScopeId: () => {},
  cloneNode: () => makeNode('div'),
  insertStaticContent: () => [makeNode('div'), makeNode('div')],
  patchProp: (el, key, _prev, next) => {
    el.props[key] = next;
  },
};

function text(node) {
  if (node === null || node === undefined) return '';
  if (node.tag === '#text') return node.text ?? '';
  if (node.tag === '#comment') return '';
  return (node.children ?? []).map(text).join(' ');
}

// ── 被测结构：外壳 = tab 栏 + 「RouterView」（按 current 换组件） ─────────────
const Page = (label) =>
  defineComponent({ name: `Page${label}`, setup: () => () => h('p', {}, `page:${label}`) });
const Boom = defineComponent({
  name: 'BoomPluginView',
  setup() {
    throw new TypeError('crypto.randomUUID is not a function');
  },
});
const RouterViewLike = defineComponent({
  name: 'RouterViewLike',
  props: { current: { type: Object, required: true } },
  setup: (props) => () => h(props.current),
});
const Shell = defineComponent({
  name: 'Shell',
  props: { current: { type: Object, required: true } },
  setup: (props) => () =>
    h('div', { class: 'shell' }, [h('nav', {}, 'tab 栏'), h(RouterViewLike, { current: props.current })]),
});

/**
 * 走一遍「正常 tab → 会崩的 tab → 另一个正常 tab」，返回三个时刻的文本和未处理拒绝。
 * 刻意不 `await nextTick()`：浏览器里没人接住 flush 的 promise，这里也要保持"没人接住"。
 */
async function run({ boundary }) {
  const rejections = [];
  const onRejection = (err) => rejections.push(err instanceof Error ? err.message : String(err));
  process.on('unhandledRejection', onRejection);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const current = shallowRef(Page('A'));
  const app = createRenderer(nodeOps).createApp({
    setup: () => () =>
      boundary
        ? h(PluginBoundary, { resetKey: String(current.value.name) }, { default: () => h(Shell, { current: current.value }) })
        : h(Shell, { current: current.value }),
  });

  const root = makeNode('#root');
  app.mount(root);
  const initial = text(root);

  current.value = Boom;
  await settle();
  const crashed = text(root);

  current.value = Page('B');
  await settle();
  const after = text(root);

  process.off('unhandledRejection', onRejection);
  return { initial, crashed, after, rejections };
}

console.log('没有错误边界时（这就是线上那次的现象）');
{
  const r = await run({ boundary: false });
  check('切到会崩的 tab：插件区域空白', !r.crashed.includes('page:'), r.crashed);
  check('再切到正常 tab：仍然空白 —— 不刷新就一直白着', !r.after.includes('page:B'), r.after);
  check('flush 的 promise 变成未处理拒绝', r.rejections.length > 0, JSON.stringify(r.rejections));
}

console.log('套上 src/plugin-boundary.ts');
{
  const r = await run({ boundary: true });
  check('初始正常渲染', r.initial.includes('page:A'), r.initial);
  check('外壳（tab 栏）还活着', r.crashed.includes('tab 栏'), r.crashed);
  check('崩掉的区域给出可读原因', r.crashed.includes('这个插件的页面崩了') && r.crashed.includes('crypto.randomUUID is not a function'), r.crashed);
  check('切到别的 tab 能恢复', r.after.includes('page:B'), r.after);
  check('失败状态跟着路由一起清掉', !r.after.includes('这个插件的页面崩了'), r.after);
  check('全程没有未处理的 promise 拒绝', r.rejections.length === 0, JSON.stringify(r.rejections));
}

console.log(failed === 0 ? '\n✅ 隔离测试通过' : `\n❌ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
