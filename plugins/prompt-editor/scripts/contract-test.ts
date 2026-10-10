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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import {
  canDropItem,
  moveItem,
  newId,
  reflow,
  renderOutput,
  splitSentences,
  splitTags,
  type Doc,
  type Item,
} from '../client/src/model.ts';
import { buildPlan, drawSeed, paramsOf } from '../client/src/crosscall/anima-plus.ts';

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

// 服务端也按产物进：拆成多模块后源码不再是入口（server.js 由 scripts/build-server.mjs 打出来）。
// 动态说明符给不出类型，所以按源码入口的形状收一下 —— 产物与源码同源，这正是契约测试要断言的事。
const server = (await import(artifact('server.js').href)) as typeof import('../server/index.ts');
const {
  PROVIDERS,
  docFromStored,
  looksLikeLfsPointer,
  machineCategory,
  maskPromptSyntax,
  openTagDb,
  parseCooccurTsv,
  parseTagCsv,
  foldUnderscore,
  rawFromStored,
  sanitizeDoc,
  sanitizeSettings,
  sanitizeTags,
  sanitizeUsage,
  storedFromDoc,
  storedFromRaw,
  tagKey,
  translateTexts,
} = server;

const plugin = (await import(artifact('client.js').href)).default as {
  tabs?: { id: string; title: string; order: number }[];
  routes?: { path: string; component: unknown }[];
};

// ── 3. 服务端装配：apply() 挂到宿主上的路由必须一条不少 ──────────────────────
// 假 ctx 照宿主的语义来：`ctx.routes.for(id)` **每调用一次就换一张新表**
// （apps/server/src/handles/routes.ts），所以一个插件只能领一次、再传下去。
// 领两次的话先注册的那批会被整张覆盖 —— 端点 404，而纯函数级断言一点都看不出来
// （把服务端拆成多模块时真踩过：预设 / 草稿那 9 条全丢）。
{
  const tables: string[][] = [];
  const newTable = (): Record<string, (p: string) => void> => {
    const paths: string[] = [];
    tables.push(paths);
    const record = (method: string) => (p: string) => {
      paths.push(`${method} ${p}`);
    };
    return { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE') };
  };
  let effects = 0;
  // 空间给个真目录（宿主的语义就是这样）：装配阶段**不该**在里头留下任何东西 ——
  // 词库连接是第一次真要用时才开的，只挂路由不该凭空造出一个 tags.db
  const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-apply-'));
  server.apply({
    routes: { for: newTable },
    space: { for: () => ({ packageName: 'x', root: spaceDir, resolve: (f: string) => path.join(spaceDir, f) }) },
    effect: () => {
      effects += 1;
    },
  } as unknown as Parameters<typeof server.apply>[0]);

  const expected = [
    'GET /block-presets',
    // 内置区块库这两条**必须在 `/block-presets/:id` 之前**（宿主按注册顺序逐段匹配，`:id` 会把 bundled 吃掉）
    'GET /block-presets/bundled',
    'POST /block-presets/bundled',
    'GET /block-presets/:id',
    'POST /block-presets',
    'PUT /block-presets/:id',
    'DELETE /block-presets/:id',
    'GET /presets',
    'GET /presets/:id',
    'POST /presets',
    'PUT /presets/:id',
    'DELETE /presets/:id',
    'GET /draft',
    'PUT /draft/structure',
    'PUT /draft/blocks/:id/items',
    'PUT /draft',
    'GET /settings',
    'PUT /settings',
    'POST /translate',
    'GET /tags',
    'PUT /tags/entry',
    'DELETE /tags/entry',
    'GET /tags/import',
    'POST /tags/import',
    'PUT /tags/order',
    'POST /tags/categories',
    'DELETE /tags/categories',
    'PUT /tags/categories',
    'PUT /tags/categories/order',
    'DELETE /tags/categories/entries',
  ];
  const registered = tables.at(-1) ?? []; // 宿主最终留下的是最后领的那张表
  check(
    `宿主留下的路由表里 ${expected.length} 条全在`,
    expected.every((r) => registered.includes(r)),
    registered.join(' '),
  );
  // 顺序也是契约：`/block-presets/bundled` 排在 `:id` 后面就等于没注册（会被当成 id 吃掉）
  check(
    '内置区块库路由排在 /block-presets/:id 之前',
    registered.indexOf('GET /block-presets/bundled') < registered.indexOf('GET /block-presets/:id'),
    registered.join(' '),
  );
  check('apply 注册了收尾（ctx.effect）', effects === 1, effects);
  check('装配阶段不碰盘（词库连接第一次真要用时才开）', fs.readdirSync(spaceDir).length === 0, fs.readdirSync(spaceDir).join(' '));
  fs.rmSync(spaceDir, { recursive: true, force: true });
}

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
check('渲染出工作区标题', html.includes('工作区'));
check('渲染出首屏三个区块', ['质量', '主体', '场景'].every((t) => html.includes(t)));
check(
  '每个区块各带一个风格开关（3 个区块 → 6 个按钮，每块两个选项）',
  (html.match(/pe-block-modes/g) ?? []).length === 3 && (html.match(/>\s*tag\s*</g) ?? []).length === 3,
  `pe-block-modes × ${(html.match(/pe-block-modes/g) ?? []).length}`,
);
check(
  '区块的开关默认停在 tag（每块都有一个 active 的 tag 按钮）',
  (html.match(/<button class="active"[^>]*>\s*tag\s*</g) ?? []).length === 3,
  (html.match(/<button class="active"[^>]*>[^<]*/g) ?? []).join(' | '),
);
check('顶部不再有全局风格开关', !html.includes('tag 风格'), (html.match(/pe-modes/g) ?? []).join(','));
check('区块里有添加输入框', html.includes('添加 tag'));
check('渲染出输出区与复制按钮', html.includes('输出') && html.includes('复制'));
check('输出为空时给出提示', html.includes('左边写点什么'));
check('渲染出新建区块按钮', html.includes('+ 新建区块'));
check('渲染出预设库入口', html.includes('预设库'));

// ── 4. 切分 / 重切 / 输出 ─────────────────────────────────────────────────────
const item = (text: string, enabled = true, translation = '', source: Item['source'] = ''): Item => ({
  id: `id-${text}`,
  text,
  enabled,
  translation,
  source,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('切分规则');
check('tag：括号深度 0 的逗号才切', same(splitTags('a, b, (c, d:1.2), e'), ['a', 'b', '(c, d:1.2)', 'e']));
check('tag：转义逗号不切', same(splitTags('a, e\\, f'), ['a', 'e\\, f']));
check('tag：空段丢弃', same(splitTags('a, , b,'), ['a', 'b']));
check('自然语言：句号断句且句号留在前一句', same(splitSentences('A girl. She runs.'), ['A girl.', 'She runs.']));
check('自然语言：小数不切', same(splitSentences('Scale 1.5 ratio'), ['Scale 1.5 ratio']));
check('自然语言：没有句号就是一句', same(splitSentences('silver hair'), ['silver hair']));

console.log('切换视图（reflow：整块当一份内容重切，块之间不合并）');
const tags = [item('masterpiece'), item('best quality', false, '最佳质量')];
const threeTags = [item('masterpiece'), item('best quality'), item('8k')];
check(
  'tag → 自然语言：整块合成一段',
  same(reflow(threeTags, 'tag', 'text').map((i) => i.text), ['masterpiece, best quality, 8k']),
  JSON.stringify(reflow(threeTags, 'tag', 'text').map((i) => i.text)),
);
check(
  '禁用的条目不参与合并，原样留在后面',
  same(reflow(tags, 'text', 'tag').map((i) => `${i.text}${i.enabled ? '' : '(禁用)'}`), ['masterpiece', 'best quality(禁用)']),
);
check(
  '自然语言 → tag：整块按逗号重切',
  same(reflow([item('A girl, silver hair.')], 'text', 'tag').map((i) => i.text), ['A girl', 'silver hair.']),
  JSON.stringify(reflow([item('A girl, silver hair.')], 'text', 'tag').map((i) => i.text)),
);
const merged = reflow([item('a cat sits.'), item('a dog runs.')], 'text', 'tag');
check(
  '自然语言 → tag：没逗号就合成一条（整块是一份内容）',
  same(merged.map((i) => i.text), ['a cat sits. a dog runs.']),
  JSON.stringify(merged.map((i) => i.text)),
);
check('重切出来的条目译文清空（译文对碎片不成立）', reflow([item('A girl, silver hair.', true, '一个女孩')], 'text', 'tag').every((i) => i.translation === ''));
check('只有第一块沿用原 id', reflow([item('A girl, silver hair.')], 'text', 'tag')[0]?.id === 'id-A girl, silver hair.');
check('内容没变时连译文都不动', reflow([item('A girl.', true, '一个女孩')], 'text', 'tag')[0]?.translation === '一个女孩');
check('全禁用 / 空块原样返回', reflow([item('x', false)], 'tag', 'text')[0]?.id === 'id-x' && reflow([], 'tag', 'text').length === 0);
check('同风格切换是空操作', reflow(tags, 'tag', 'tag') === tags);
check(
  '往返稳：tag → 自然语言 → tag 还是那几块',
  same(reflow(reflow(threeTags, 'tag', 'text'), 'text', 'tag').map((i) => i.text), ['masterpiece', 'best quality', '8k']),
);
check(
  '往返稳：自然语言 → tag → 自然语言 还是那两句',
  same(reflow(reflow([item('a cat sits.'), item('a dog runs.')], 'text', 'tag'), 'tag', 'text').map((i) => i.text), ['a cat sits.', 'a dog runs.']),
);

console.log('拖拽：块内排序 + 跨块搬家（只认类型相同的块）');
const dragDoc = (): Doc => ({
  version: 1,
  blocks: [
    { id: 'b1', title: '质量', color: '#6ea8fe', mode: 'tag', items: [item('a'), item('b'), item('c')] },
    { id: 'b2', title: '主体', color: '#4ac38a', mode: 'tag', items: [item('x'), item('y')] },
    { id: 'b3', title: '场景', color: '#f2b84b', mode: 'text', items: [item('A girl.')] },
  ],
});
const texts = (d: Doc, id: string) => d.blocks.find((b) => b.id === id)?.items.map((i) => i.text) ?? [];

check(
  '块内排序：摘掉再插入（沿用原来的落点语义）',
  (() => {
    const d = dragDoc();
    return moveItem(d, { blockId: 'b1', index: 0 }, { blockId: 'b1', index: 2 }) && same(texts(d, 'b1'), ['b', 'c', 'a']);
  })(),
);
check(
  '跨块搬家：源块少一条、目标块按落点插入、搬的还是同一个条目（id 不变）',
  (() => {
    const d = dragDoc();
    const movedId = d.blocks[0]!.items[0]!.id;
    const ok = moveItem(d, { blockId: 'b1', index: 0 }, { blockId: 'b2', index: 1 });
    return ok && same(texts(d, 'b1'), ['b', 'c']) && same(texts(d, 'b2'), ['x', 'a', 'y'])
      && d.blocks[1]!.items[1]!.id === movedId;
  })(),
);
check(
  '落点 = items.length 就是追加到末尾（拖到块体空白）',
  (() => {
    const d = dragDoc();
    return moveItem(d, { blockId: 'b1', index: 0 }, { blockId: 'b2', index: 2 }) && same(texts(d, 'b2'), ['x', 'y', 'a']);
  })(),
);
check(
  '类型不同（tag → 自然语言）不落地，两边都原样',
  (() => {
    const d = dragDoc();
    return !moveItem(d, { blockId: 'b1', index: 0 }, { blockId: 'b3', index: 1 })
      && same(texts(d, 'b1'), ['a', 'b', 'c']) && same(texts(d, 'b3'), ['A girl.']);
  })(),
);
check(
  '拖回原位是空操作（不白写一次草稿）',
  (() => {
    const d = dragDoc();
    return !moveItem(d, { blockId: 'b1', index: 1 }, { blockId: 'b1', index: 1 }) && same(texts(d, 'b1'), ['a', 'b', 'c']);
  })(),
);
check(
  '块 / 条目不存在时一律不落地（拖拽期间别的操作删了它）',
  (() => {
    const d = dragDoc();
    return !moveItem(d, { blockId: 'nope', index: 0 }, { blockId: 'b1', index: 0 })
      && !moveItem(d, { blockId: 'b1', index: 9 }, { blockId: 'b2', index: 0 })
      && !moveItem(d, { blockId: 'b1', index: 0 }, { blockId: 'nope', index: 0 });
  })(),
);
check(
  'canDropItem：同类型接得住（含自己那块），跨类型不接',
  (() => {
    const d = dragDoc();
    return canDropItem(d, { blockId: 'b1', index: 0 }, 'b2')
      && canDropItem(d, { blockId: 'b1', index: 0 }, 'b1')
      && !canDropItem(d, { blockId: 'b1', index: 0 }, 'b3')
      && !canDropItem(d, { blockId: 'b1', index: 0 }, 'nope');
  })(),
);

console.log('输出拼接（风格按区块走）');
const doc: Doc = {
  version: 1,
  blocks: [
    {
      id: 'b1',
      title: '质量',
      color: '#6ea8fe',
      mode: 'tag',
      items: [item('masterpiece'), item('best quality', false)],
    },
    { id: 'b2', title: '主体', color: '#4ac38a', mode: 'tag', items: [item('1girl'), item('solo')] },
    { id: 'b3', title: '场景', color: '#f2b84b', mode: 'text', items: [item('A girl. She runs.')] },
    { id: 'b4', title: '空的', color: '#ff7b72', mode: 'tag', items: [item('   ')] },
  ],
};
check(
  '禁用条目不进输出、空区块不留空行、区块间换行、**tag 块末尾补逗号**',
  renderOutput(doc) === 'masterpiece,\n1girl, solo,\nA girl. She runs.',
  JSON.stringify(renderOutput(doc)),
);
check(
  '同一个文档里 tag 块串成一行、自然语言块每句一行（互不影响）',
  renderOutput({ ...doc, blocks: [doc.blocks[0]!, doc.blocks[2]!] }) === 'masterpiece,\nA girl. She runs.',
  JSON.stringify(renderOutput({ ...doc, blocks: [doc.blocks[0]!, doc.blocks[2]!] })),
);
check(
  '末尾已经有逗号就不补第二个（用户自己补过 / 条目里就带着）',
  renderOutput({ ...doc, blocks: [{ ...doc.blocks[1]!, items: [item('1girl'), item('solo,')] }] }) === '1girl, solo,',
  JSON.stringify(renderOutput({ ...doc, blocks: [{ ...doc.blocks[1]!, items: [item('1girl'), item('solo,')] }] })),
);
check(
  '自然语言块不补逗号（句号就是它的结束符）',
  renderOutput({ ...doc, blocks: [{ ...doc.blocks[2]!, mode: 'text' }] }) === 'A girl. She runs.',
  JSON.stringify(renderOutput({ ...doc, blocks: [{ ...doc.blocks[2]!, mode: 'text' }] })),
);
check(
  '把同一个块从 tag 切到自然语言，连接符跟着变',
  renderOutput({ ...doc, blocks: [{ ...doc.blocks[1]!, mode: 'text' }] }) === '1girl\nsolo',
  JSON.stringify(renderOutput({ ...doc, blocks: [{ ...doc.blocks[1]!, mode: 'text' }] })),
);
check(
  '自然语言块：每句话各自一行',
  renderOutput({
    version: 1,
    blocks: [{ id: 'b', title: '场景', color: '#fff', mode: 'text', items: [item('a cat sits.'), item('a dog runs.')] }],
  }) === 'a cat sits.\na dog runs.',
  JSON.stringify(
    renderOutput({
      version: 1,
      blocks: [{ id: 'b', title: '场景', color: '#fff', mode: 'text', items: [item('a cat sits.'), item('a dog runs.')] }],
    }),
  ),
);

// ── 跨域调用：输出 → anima-plus 的描述提示词（组包是纯函数，提交才是 HTTP）──────
console.log('跨域调用组包（anima-plus 适配器）');
/** anima-plus 的 last-state.json 长什么样（键名与 assets/form.json 的 inputs 对齐） */
const savedState = {
  prompt: '上一次的描述提示词',
  loras: [{ name: 'Anima\\Anima Turbo LoRA-v0.2', weight: 0.9 }, { name: '  ', weight: 1 }],
  unet_name: 'Anima\\0.26.9.12.NAI.RDBT  Anima.b1V23Base_fp16.safetensors',
  seed: 421066625562399,
  randomSeed: true,
  steps: 6,
  cfg: 1,
  width: 832,
  height: 1216,
};
const drawn = buildPlan(savedState, '1girl, solo', () => 777);
check(
  '描述提示词换成输出，其余字段原样（基底就是对方最后一次状态）',
  drawn.values.prompt === '1girl, solo' && drawn.values.width === 832 && drawn.values.steps === 6,
  JSON.stringify(drawn.values.prompt),
);
check(
  '不动传进来的那份基底（改的是拷贝出来的新对象）',
  savedState.prompt === '上一次的描述提示词' && savedState.seed === 421066625562399,
);
check(
  'randomSeed 开着：重抽种子并写回 values（与对方 submit 同一套）',
  drawn.redrewSeed === true && drawn.seed === 777 && drawn.values.seed === 777,
  String(drawn.values.seed),
);
const kept = buildPlan({ ...savedState, randomSeed: false }, 'x');
check('randomSeed 关着：沿用快照里的种子', kept.redrewSeed === false && kept.values.seed === 421066625562399);
const noSeed = buildPlan({ prompt: 'p' }, 'x');
check('对方没有种子字段时不硬塞一个', noSeed.seed === null && noSeed.values.seed === undefined);
const param = (label: string): string => drawn.params.find((one) => one.label === label)?.value ?? '';
check(
  '摘要：模型只取路径末段（Windows 路径也一样）',
  param('模型').endsWith('b1V23Base_fp16.safetensors') && !/[\\/]/.test(param('模型')),
  param('模型'),
);
check('摘要：尺寸 / 步数 / CFG', param('尺寸') === '832×1216' && param('步数') === '6' && param('CFG') === '1');
check('摘要：LoRA 条数剔掉空名字行（对方提交时也剔）', param('LoRA') === '1 条', param('LoRA'));
check('摘要：重抽时写策略而不是预览用的那个数', param('种子') === '每次重抽', param('种子'));
check(
  '摘要：不重抽时写出具体种子',
  paramsOf({ ...savedState, randomSeed: false }, false).find((one) => one.label === '种子')?.value === '421066625562399',
);
check(
  'drawSeed 落在 anima-plus 的同一区间（0 ~ 2^53-1）',
  [0, 1, 2, 3].every(() => drawSeed() >= 0 && drawSeed() <= 2 ** 53 - 1),
);

// ── 5. 服务端收敛：请求体与手改坏的文件都不该让页面炸 ────────────────────────
console.log('服务端收敛（sanitizeDoc）');
check('非对象 → null', sanitizeDoc('nope') === null);
const filled = sanitizeDoc({ blocks: [{ items: [{ text: 'a' }] }] })?.blocks[0];
check('缺字段给默认值', filled?.items[0]?.text === 'a' && filled?.items[0]?.enabled === true && filled?.items[0]?.translation === '');
check('区块缺 mode 时回落 tag', filled?.mode === 'tag');
check('区块 mode 不认识也回落 tag', sanitizeDoc({ blocks: [{ mode: 'wat', items: [] }] })?.blocks[0]?.mode === 'tag');
const legacy = sanitizeDoc({ mode: 'text', blocks: [{ items: [] }, { mode: 'tag', items: [] }] });
const legacyModes = (legacy?.blocks ?? []).map((block: { mode: string }) => block.mode).join(',');
check('老格式（文档级 mode）仍能读进来：每个区块继承它', legacyModes === 'text,tag', legacyModes);
check('收敛结果里不再有文档级 mode', !('mode' in (sanitizeDoc({ mode: 'text', blocks: [] }) ?? {})));
check('超长文本被截断', sanitizeDoc({ blocks: [{ items: [{ text: 'x'.repeat(5000) }] }] })?.blocks[0]?.items[0]?.text.length === 4000);
check('非对象条目被丢掉', sanitizeDoc({ blocks: [{ items: [1, { text: 'keep' }] }] })?.blocks[0]?.items.length === 1);
check(
  '条目来源只剩 dict / api；老草稿里的 user 折成 dict（徽章只说在不在库里）',
  (() => {
    const items = sanitizeDoc({
      blocks: [
        {
          items: [
            { text: 'a', translation: '甲', source: 'user' },
            { text: 'b', translation: '乙', source: 'api' },
            { text: 'c', translation: '丙', source: 'dict' },
            { text: 'd', translation: '丁', source: 'wat' },
            { text: 'e', translation: '戊' },
          ],
        },
      ],
    })?.blocks[0]?.items;
    return same(
      (items ?? []).map((item: { source: string }) => item.source),
      ['dict', 'api', 'dict', '', ''],
    );
  })(),
);

console.log('草稿的两段存储（结构 / 条目）');
// 盘上：{ blocks: [属性…], items: { 区块id: [条目…] } } —— 拆开是为了让一次编辑只写一段
const stored = storedFromRaw({
  version: 1,
  blocks: [
    { id: 'b1', title: '质量', color: '#fff', mode: 'tag' },
    { id: 'b2', title: '场景', color: '#000', mode: 'text' },
  ],
  items: { b1: [{ id: 'i1', text: 'masterpiece' }], b2: [] },
});
check('盘上的两段能装配回 Doc', docFromStored(stored!).blocks.length === 2);
check(
  '条目按区块 id 对上号',
  docFromStored(stored!).blocks[0]?.items[0]?.text === 'masterpiece' &&
    docFromStored(stored!).blocks[1]?.items.length === 0,
);
check('结构那一段不含条目', stored!.structure.every((meta) => !('items' in meta)));
check('缺 items 段的区块读成空数组', docFromStored(storedFromRaw({ blocks: [{ id: 'b9' }] })!).blocks[0]?.items.length === 0);
check('盘上不是对象 → null', storedFromRaw('nope') === null && storedFromRaw(null) === null);
// 老格式（条目直接挂在 block.items 上）也要读得进来 —— 上一次的 draft.json 就是这个形状
const migrated = storedFromRaw({ blocks: [{ id: 'b1', mode: 'text', items: [{ text: '老格式' }] }] });
check('老格式（block.items）自动迁移进 items 段', docFromStored(migrated!).blocks[0]?.items[0]?.text === '老格式');
check('迁移时老的文档级 mode 也认', docFromStored(migrated!).blocks[0]?.mode === 'text');
// Doc → 盘上两段 → Doc 往返一致
const roundTrip = docFromStored(storedFromDoc(sanitizeDoc({ blocks: [{ id: 'b1', title: 'T', items: [{ text: 'x' }] }] })!));
check(
  'Doc 拆成两段再装配回来不丢东西',
  roundTrip.blocks[0]?.title === 'T' && roundTrip.blocks[0]?.items[0]?.text === 'x',
  JSON.stringify(roundTrip),
);
const raw = rawFromStored(stored!);
check(
  '落盘格式：blocks 是纯属性、items 是按区块分组的条目',
  raw.version === 1 &&
    raw.blocks.every((meta) => !('items' in meta)) &&
    Object.keys(raw.items).length === 2,
  JSON.stringify(raw).slice(0, 120),
);

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

// ── 翻译：掩码 / 词库 / 设置 / 编排（provider 用 stub，不碰真网）───────────────

console.log('权重语法掩码（只把"词"交出去翻）');
check(
  '普通 tag 整条翻',
  same(maskPromptSyntax('masterpiece').parts, ['masterpiece']),
);
check(
  '(x:1.2) 只翻 x，权重和括号原样贴回',
  maskPromptSyntax('(masterpiece:1.2)').rebuild(['杰作']) === '(杰作:1.2)',
  maskPromptSyntax('(masterpiece:1.2)').rebuild(['杰作']),
);
check('[x:0.5] 同理', maskPromptSyntax('[1girl:0.5]').rebuild(['一个女孩']) === '[一个女孩:0.5]');
check('(x) 无权重也认得', maskPromptSyntax('(best quality)').rebuild(['最佳品质']) === '(最佳品质)');
check(
  '{a|b} 每一支各自翻，再拼回同样结构',
  same(maskPromptSyntax('{masterpiece|best quality}').parts, ['masterpiece', 'best quality']) &&
    maskPromptSyntax('{masterpiece|best quality}').rebuild(['杰作', '最佳品质']) === '{杰作|最佳品质}',
);
check('裸的 tag:1.2 也认（但只认完全没有空格的）', maskPromptSyntax('1girl:1.2').rebuild(['一个女孩']) === '一个女孩:1.2');
check('"time: 5" 这种句子不许被切', same(maskPromptSyntax('time: 5').parts, ['time: 5']));
check('<lora:...> 跳过（模型名是标识符，翻了就废）', maskPromptSyntax('<lora:add_detail:0.8>').skip === true);
check('[a:b:0.5] 这种交替语法结构没解析，整条当普通文本', same(maskPromptSyntax('[a:b:0.5]').parts, ['[a:b:0.5]']));
check('空文本切不出片段', maskPromptSyntax('   ').parts.length === 0);

console.log('词库（一张表两用：翻译命中 + 面板分组）');
check('键归一化：大小写不敏感、空白折叠', tagKey('  1Girl   SOLO ') === '1girl solo');
// 每个用例开自己的空库：库是文件，不共享状态也就不会互相污染（目录跑完一起删）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-tags-'));
const tagsJson = path.join(tmpDir, 'tags.json');
const dictJson = path.join(tmpDir, 'dict.json');
let dbSeq = 0;
const newTags = () =>
  openTagDb({ db: path.join(tmpDir, `tags-${(dbSeq += 1)}.db`), tagsJson, legacyDictJson: dictJson });

/** 导入用的一行（导入只认这一组字段；`hot` / `updatedAt` 给了就按给的走） */
const tagRow = (en: string, zh: string, categories: string[], source: string, hot = 100) => ({
  key: tagKey(en),
  en,
  zh,
  categories,
  aliases: [] as string[],
  source,
  updatedAt: 0,
  hot,
});

check('坏输入退化成空库', sanitizeTags(null).length === 0 && sanitizeTags('nope').length === 0);

{
  // 手动排序（面板拖出来的顺序）：`sort` 有值的排在最前，其余仍按热度
  const db = newTags();
  // 用 importEntries 而不是 upsert 铺数据：`hot` 是导入数据，upsert（人改的那条路）根本不收它，
  // 而且 upsert 会把 updatedAt 写成当下，那样测的就不是"按热度"而是"按改动时间"了
  db.importEntries(
    (
      [
        ['a', 10],
        ['b', 30],
        ['c', 20],
      ] as [string, number][]
    ).map(([en, hot]) => ({
      key: en,
      en,
      zh: `${en}译`,
      categories: [],
      aliases: [],
      source: 'import',
      updatedAt: 0,
      hot,
    })),
  );
  const keysOf = (): string => db.query({ limit: 10 }).tags.map((one) => one.key).join();
  check('没排过顺序：按热度 b(30) > c(20) > a(10)', keysOf() === 'b,c,a', keysOf());
  const first = db.setOrder(['a', 'c', 'b'], 'a');
  check('第一次拖：这一页还没序号 → 整页铺间隔（rebuilt）', first.rebuilt === true && first.written === 3, JSON.stringify(first));
  check('排过的按手动顺序在最前', keysOf() === 'a,c,b', keysOf());
  const second = db.setOrder(['b', 'a', 'c'], 'b');
  check('之后拖：只写被拖的那一行（中点法，不是重写整页）', second.rebuilt === false && second.written === 1, JSON.stringify(second));
  check('顺序按新的来', keysOf() === 'b,a,c', keysOf());
  check('setOrder 不动 updatedAt（排序不是"改内容"，不然回退顺序会被连带改掉）', db.lookup('a')?.updatedAt === 0);
  check('setOrder 也不改 source（排序 ≠ 认领这条）', db.lookup('a')?.source === 'import');
  // 浮点也会用尽：同一个缝里反复对半切（double 尾数 ~50 位）就切不出严格居中的值了
  let rebuilt = false;
  for (let i = 0; i < 80 && !rebuilt; i += 1) rebuilt = db.setOrder(['a', 'c', 'b'], 'c').rebuilt;
  check('序号切尽 → 退回整页重铺（这条兜底路径必须真的会触发）', rebuilt === true);
  check('重铺之后顺序没变（还是 a,c,b）', keysOf() === 'a,c,b', keysOf());
  db.close();
}

// 分类级管理：分类**自己是一张表**（不只是 tag 上的一个字符串）
{
  const db = newTags();
  const names = (): string => db.query().categories.map((one) => `${one.name}:${one.count}`).join(' ');
  check('空库没有分类', names() === '', names());
  check('新建一个分类', db.createCategory('新分类') === true);
  check(
    '还没人用的空分类也在树里（计数 0）—— 这就是分类做成实体表的意义',
    names() === '新分类:0',
    names(),
  );
  check('重名不当错误（面板再点一次不该报错）', db.createCategory('新分类') === false);
  check('重名之后树里还是一份', names() === '新分类:0', names());

  db.importEntries([
    { key: 'x', en: 'x', zh: 'x译', categories: ['写词时现打的名字'], aliases: [], source: 'import', hot: 0, updatedAt: 1 },
  ]);
  check(
    '给 tag 填一个没建过的分类名 → 顺手注册成真分类（不然编辑框里打出来的名字在树里没位置）',
    names() === '写词时现打的名字:1 新分类:0',
    names(),
  );

  db.importEntries([
    { key: 'y', en: 'y', zh: 'y译', categories: ['新分类'], aliases: [], source: 'import', hot: 0, updatedAt: 2 },
  ]);
  check('分类计数跟着走', names() === '写词时现打的名字:1 新分类:1', names());

  check(
    '改名：两张表一起改，返回跟着走的词条数',
    db.renameCategory('新分类', '改过的名字') === 1 && names() === '写词时现打的名字:1 改过的名字:1',
    names(),
  );
  check('改名后那条词条上也是新名字', db.lookup('y')?.categories.join() === '改过的名字');
  check('撞名不合并（返回 -1 让面板报错）', db.renameCategory('改过的名字', '写词时现打的名字') === -1);
  check('撞名失败之后两边都没动', names() === '写词时现打的名字:1 改过的名字:1', names());

  check('删掉分类：返回受影响的词条数', db.removeCategory('改过的名字') === 1);
  check('分类没了', names() === '写词时现打的名字:1', names());
  check(
    '但词条本身一条都没删（只是变回未分类）',
    db.lookup('y')?.categories.length === 0 && db.count() === 2,
    `${db.lookup('y')?.categories.length} / ${db.count()}`,
  );
  check('删一个不存在的分类也不炸（返回 0）', db.removeCategory('从来没有过的名字') === 0);
  db.close();
}

// 分类树的手动顺序 + 清空内容。
// **计数必须"先去重再 JOIN"**：拿 `tag_categories` 直接 JOIN 自己是"组内每条乘组内每条"，
// 46075 条的组会算出 21 亿行（面板直接挂住）；小样本上的表现是计数翻倍 —— 所以这里特意
// 让一个分类装 4 条：真回归了会看到 16 而不是 4。
{
  const db = newTags();
  const names = (): string => db.query().categories.map((one) => `${one.name}:${one.count}`).join(' ');
  db.importEntries(
    ['a', 'b', 'c', 'd'].map((key, index) => ({
      key, en: key, zh: `${key}译`, categories: ['多条的'], aliases: [], source: 'import', hot: 0, updatedAt: index + 1,
    })),
  );
  db.importEntries([
    { key: 'e', en: 'e', zh: 'e译', categories: ['另一类'], aliases: [], source: 'import', hot: 0, updatedAt: 9 },
  ]);
  check('分类计数是"有多少条词"，不是 JOIN 出来的笛卡尔积', names() === '多条的:4 另一类:1', names());

  const first = db.setCategoryOrder(['另一类', '多条的'], '另一类');
  check('第一次拖分类：整树铺序号（分类只有几个，不用"手动的是前缀"那套）', first.rebuilt === true && first.written === 2, JSON.stringify(first));
  check('顺序就是你拖出来的', names() === '另一类:1 多条的:4', names());
  const second = db.setCategoryOrder(['多条的', '另一类'], '多条的');
  check('第二次拖：取中点只写 1 行', second.rebuilt === false && second.written === 1, JSON.stringify(second));
  check('顺序跟着变', names() === '多条的:4 另一类:1', names());

  db.createCategory('新的');
  check('新建的分类没序号，排在最后', names() === '多条的:4 另一类:1 新的:0', names());
  const third = db.setCategoryOrder(['多条的', '新的', '另一类'], '新的');
  check('拖一条没序号的 → 整树重铺（不然它永远吊在最后）', third.rebuilt === true && third.written === 3, JSON.stringify(third));
  check('它落到拖到的位置上', names() === '多条的:4 新的:0 另一类:1', names());

  // 批量删除：**词条真的从库里删掉**（不是只摘归属），分类留着
  const wiped = db.deleteCategoryEntries('多条的');
  check('批量删除：返回删了几条', wiped.deleted === 4 && wiped.userDeleted === 0, JSON.stringify(wiped));
  check('词条真没了（不是变回未分类）', db.count() === 1, String(db.count()));
  check('这个分类还在，只是计数归零', names() === '多条的:0 新的:0 另一类:1', names());
  check('别的分类一条没牵连', db.query().categories.find((one) => one.name === '另一类')?.count === 1);
  check('删一个本来就空的分类也不炸（返回 0）', db.deleteCategoryEntries('新的').deleted === 0);
  check('删一个不存在的分类也不炸', db.deleteCategoryEntries('从来没有过的').deleted === 0);
  db.close();
}

// 批量删除的边界：手改过的（`source='user'`）**一样删**，但返回值要说清楚有几条；
// 别名行也要跟着走（`tag_aliases` 没有外键，不清就是孤儿行）
{
  const file = path.join(tmpDir, 'delete-entries.db');
  const db = openTagDb({ db: file, tagsJson: path.join(tmpDir, 'no-tags.json'), legacyDictJson: path.join(tmpDir, 'no-dict.json') });
  db.importEntries([
    { key: 'a', en: 'a', zh: 'a译', categories: ['待删'], aliases: ['a别名'], source: 'import', hot: 0, updatedAt: 1 },
    { key: 'b', en: 'b', zh: 'b译', categories: ['待删'], aliases: [], source: 'import', hot: 0, updatedAt: 2 },
    { key: 'c', en: 'c', zh: 'c译', categories: ['留着的'], aliases: [], source: 'import', hot: 0, updatedAt: 3 },
  ]);
  db.upsert({ en: 'd', zh: 'd译（我改的）', categories: ['待删'], source: 'user' });
  check('前置：这个分类下 3 条，其中 1 条是手改的', db.query().categories.find((one) => one.name === '待删')?.count === 3);

  const wiped = db.deleteCategoryEntries('待删');
  check('手改过的一起删，但返回值里报出来（面板要说清楚删掉了什么）', wiped.deleted === 3 && wiped.userDeleted === 1, JSON.stringify(wiped));
  check('词条真没了', db.count() === 1 && db.lookup('a') === null, String(db.count()));
  check('别的分类一条没牵连', db.lookup('c')?.categories.join() === '留着的');
  check('分类本身留着（计数归零）', db.query().categories.find((one) => one.name === '待删')?.count === 0);
  db.close();
  const raw = new DatabaseSync(file);
  check(
    '别名行跟着走（不留孤儿行）',
    Number(raw.prepare('SELECT COUNT(*) AS c FROM tag_aliases').get()?.c ?? -1) === 0,
    String(raw.prepare('SELECT COUNT(*) AS c FROM tag_aliases').get()?.c),
  );
  raw.close();
}

// 老库迁移：分类只存在于 `tag_categories` 里，`categories` 表是空的（本轮之前建的库就是这样）
{
  const file = path.join(tmpDir, 'categories-backfill.db');
  const first = openTagDb({ db: file, tagsJson, legacyDictJson: dictJson });
  first.importEntries([
    { key: 'z', en: 'z', zh: 'z译', categories: ['老分类'], aliases: [], source: 'import', hot: 0, updatedAt: 1 },
  ]);
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec('DELETE FROM categories');
  raw.close();
  const second = openTagDb({ db: file, tagsJson, legacyDictJson: dictJson });
  check(
    '开库时把 tag_categories 里在用的名字补进 categories（老库不用手工迁移）',
    second.query().categories.map((one) => `${one.name}:${one.count}`).join() === '老分类:1',
    JSON.stringify(second.query().categories),
  );
  second.close();
}

// 老库的 `categories` 没有 `parent` 列（两级分类是后加的）：开库时探列 + ALTER 补上，跟 `sort` 同一套
{
  const file = path.join(tmpDir, 'categories-parent.db');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE categories (name TEXT PRIMARY KEY, sort REAL)');
  raw.exec("INSERT INTO categories (name, sort) VALUES ('老分类', 1000)");
  raw.close();
  const db = openTagDb({ db: file, tagsJson, legacyDictJson: dictJson });
  check(
    '老库的 categories 没有 parent 列时开库补上（老分类都是平级）',
    db.query().categories.find((one) => one.name === '老分类')?.parent === null,
    JSON.stringify(db.query().categories),
  );
  db.close();
}

// 两级分类：父子关系挂在分类上（`categories.parent`），不在词条上 —— 导入时由 `parents` 映射带进来
{
  const file = path.join(tmpDir, 'category-parent.db');
  const db = openTagDb({ db: file, tagsJson, legacyDictJson: dictJson });
  const entry = (key: string, categories: string[]): Parameters<typeof db.importEntries>[0][number] => ({
    key,
    en: key,
    zh: `${key}译`,
    categories,
    aliases: [],
    source: 'import',
    hot: 1,
    updatedAt: 0,
  });
  db.importEntries(
    [entry('long hair', ['头部神态', '发型']), entry('hair ornament', [])],
    new Map([['发型', '头部神态']]),
  );
  const cats = db.query().categories;
  check(
    '分类父子关系落库：小类带 parent、大类自己不带（词条上只有两个名字）',
    cats.find((one) => one.name === '发型')?.parent === '头部神态' &&
      cats.find((one) => one.name === '头部神态')?.parent === null,
    JSON.stringify(cats),
  );
  check(
    '自己当自己的父写不进库（`parent === name` 那一支既不是顶级也展开不出来，整支会消失）',
    (() => {
      db.importEntries([entry('close-up', ['镜头', '镜头'])], new Map([['镜头', '镜头']]));
      return db.query().categories.find((one) => one.name === '镜头')?.parent === null;
    })(),
    JSON.stringify(db.query().categories.filter((one) => one.name === '镜头')),
  );
  check(
    '大类改名：小类的 parent 跟着改（不然它们在新名字下没有归属）',
    (() => {
      db.renameCategory('头部神态', '头部');
      return db.query().categories.find((one) => one.name === '发型')?.parent === '头部';
    })(),
    JSON.stringify(db.query().categories),
  );
  check(
    '大类被删：小类升成顶级（parent 指着一个不存在的名字，两级树里就渲染不出它了）',
    (() => {
      db.removeCategory('头部');
      return db.query().categories.find((one) => one.name === '发型')?.parent === null;
    })(),
    JSON.stringify(db.query().categories),
  );
  // 共现邻居只存键，查询 INNER JOIN `tags`：词库里没有的邻居自然不出现
  db.importCooccur([
    ['long hair', 'hair ornament', 1],
    ['long hair', 'ghost tag', 2],
  ]);
  check(
    '共现邻居：按强弱序回词库里真有的那些（死邻居被 JOIN 挡掉）· 词键大小写不敏感',
    db.cooccur('long hair').map((one) => one.en).join() === 'hair ornament' &&
      db.cooccur('LONG HAIR').length === 1 &&
      db.cooccur('nope').length === 0,
    JSON.stringify(db.cooccur('long hair').map((one) => one.en)),
  );
  check(
    '共现邻居是整表替换：重导一份只有别的词的表，旧行不留',
    (() => {
      db.importCooccur([['hair ornament', 'long hair', 1]]);
      return db.cooccur('long hair').length === 0 && db.cooccur('hair ornament').length === 1;
    })(),
    JSON.stringify(db.cooccur('hair ornament').map((one) => one.en)),
  );
  db.close();
}

check(
  '机翻分类映射：数字 → 机翻-中文名（认不出的数字归"其他"，空值给 null = 未分类）',
  machineCategory('0') === '机翻-通用' &&
    machineCategory(1) === '机翻-画师' &&
    machineCategory('3') === '机翻-作品' &&
    machineCategory('4') === '机翻-角色' &&
    machineCategory('5') === '机翻-元信息' &&
    machineCategory('9') === '机翻-其他' &&
    machineCategory('') === null &&
    machineCategory(undefined) === null,
);

// 机翻表的解析规则（server/tagcsv.ts）：CLI 与面板那条「导入内置机翻表」走的是同一份，
// 所以这里断言的是**两边共同**的语义 —— 引号里的逗号、没翻出来的占位、同键去重。
check(
  'CSV 解析：表头认列名 · 引号里的逗号不断列 · 下划线折成空格 · 占位行跳过 · 同键留热度高的',
  (() => {
    const { rows, stats } = parseTagCsv(
      [
        'tag,category,count,alias',
        '1girl,0,8419190,1女',
        '"my_hero_academia,",6,39259,我的英雄学院',
        'otu_(o2h2_oh4),1,679,"otu (O2H2, Oh4)"',
        'untouched,0,8224,untouched',
        'notrans,0,100,',
        ',0,100,没正名',
        '1girl,0,5,重复的（热度低，丢掉）',
      ].join('\n'),
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const girl = byKey.get('1girl');
    return (
      stats.lines === 7 &&
      stats.noTag === 1 &&
      stats.noZh === 1 &&
      stats.placeholder === 1 &&
      stats.duplicates === 1 &&
      rows.length === 3 &&
      // 引号里的逗号：tag 自己带逗号、译文里带逗号，都不能被切成两列
      byKey.get('my hero academia,')?.zh === '我的英雄学院' &&
      // 下划线：`otu_(o2h2_oh4)` → `otu (o2h2 oh4)`（源是 booru 写法，折了才跟机翻表同一个键）
      byKey.get('otu (o2h2 oh4)')?.zh === 'otu (O2H2, Oh4)' &&
      // 同键留热度高的那条（重复行是热度 5 的那份）
      girl?.hot === 8419190 &&
      girl?.categories.join() === '机翻-通用' &&
      girl?.source === 'import' &&
      girl?.updatedAt === 0
    );
  })(),
);
check(
  'CSV 解析：认不出表头就按位置读（tag,category,count,alias）· --min-count 只过滤不报错',
  (() => {
    const { rows, stats } = parseTagCsv('1girl,0,8419190,1女\nrare,4,10,冷门\n', { minCount: 100 });
    return (
      rows.length === 1 && rows[0]?.en === '1girl' && stats.filtered === 1 && stats.header.join() === 'en,category,hot,zh'
    );
  })(),
);
check(
  'CSV 解析：group/sub 两列 → 大类 + 小类两个分类 · 父子关系回 parents · 有分类就不挂机翻桶',
  (() => {
    const { rows, stats, parents } = parseTagCsv(
      [
        'tag,category,count,zh,group,sub',
        'long hair,0,6214525,长发,头部神态,发型',
        '1girl,0,50,1女,头部神态,发型',
        // 小类留空 = 只挂大类（源表里"还没细分类"的那些词，`build-dict.ts` 就是这么写出来的）
        'solo,0,100,单人,画面全局,',
        'hatsune miku,4,10,初音未来,,',
      ].join('\n'),
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return (
      stats.grouped === 3 &&
      byKey.get('long hair')?.categories.join() === '头部神态,发型' &&
      byKey.get('solo')?.categories.join() === '画面全局' &&
      // 没有 group 的行照旧走机翻桶
      byKey.get('hatsune miku')?.categories.join() === '机翻-角色' &&
      parents.get('发型') === '头部神态' &&
      parents.size === 1
    );
  })(),
);
check(
  'CSV 解析：keepPlaceholders 开着时占位行也入库（译文就用正名，专有名词命中即原文）',
  (() => {
    const text = 'tag,category,count,zh,group,sub\nhololive,3,1000,hololive,,';
    const off = parseTagCsv(text);
    const on = parseTagCsv(text, { keepPlaceholders: true });
    return (
      off.rows.length === 0 &&
      off.stats.placeholder === 1 &&
      on.rows.length === 1 &&
      on.rows[0]?.zh === 'hololive' &&
      on.rows[0]?.categories.join() === '机翻-作品'
    );
  })(),
);
check(
  '小类跟大类同名 = 没细分：小类丢掉（留着就是"自己是自己的父"，两级树里那一支整个消失）',
  (() => {
    const { rows, parents } = parseTagCsv('tag,zh,group,sub\nclose-up,特写,镜头,镜头\nwide shot,远景,镜头,镜头角度\n');
    return (
      rows.length === 2 &&
      rows[0]?.categories.join() === '镜头' &&
      rows[1]?.categories.join() === '镜头,镜头角度' &&
      parents.has('镜头') === false &&
      parents.get('镜头角度') === '镜头'
    );
  })(),
);
check(
  '共现邻居 TSV 解析：切分 + 归一（自己配自己、空邻居丢掉，序号从 1 开始）',
  (() => {
    const { rows, stats } = parseCooccurTsv('Long Hair\thair ornament|hair ornament|Long Hair|\n\nsolo\t\n');
    return (
      stats.lines === 2 &&
      rows.length === 1 &&
      rows[0]?.[0] === 'long hair' &&
      rows[0]?.[1] === 'hair ornament' &&
      rows[0]?.[2] === 1
    );
  })(),
);
check(
  'git-lfs 指针认得出来（认不出来的话导入会"成功但入库 0 条"，比报错难查）',
  looksLikeLfsPointer('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 5448620\n') &&
    !looksLikeLfsPointer('tag,category,count,alias\n1girl,0,8419190,1女\n'),
);
// 两份内置词库资产（构建期预处理的产物，见 scripts/build-weilin.ts）：面板与 CLI 都按同一份
// 解析读它们，所以这里验的是"产物本身守规矩"—— 折过下划线、来源标对、两级分类都在
console.log('内置词库资产（assets/*.csv）');
{
  const assets = fileURLToPath(new URL('../assets/', import.meta.url));
  const big = path.join(assets, 'danbooru-zh.csv');
  const head = (() => {
    if (!fs.existsSync(big)) return '';
    const fd = fs.openSync(big, 'r');
    const buf = Buffer.alloc(200);
    const read = fs.readSync(fd, buf, 0, 200, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read).toString('utf8');
  })();
  check(
    '机翻表在，且不是 lfs 指针（没拉 lfs 时是个 130 字节的指针，导入会"成功但 0 条"）',
    fs.existsSync(big) && fs.statSync(big).size > 1_000_000 && !looksLikeLfsPointer(head),
    head.slice(0, 40),
  );

  const weilin = path.join(assets, 'weilin-zh.csv');
  const text = fs.existsSync(weilin) ? fs.readFileSync(weilin, 'utf8') : '';
  const parsed = text === '' ? null : parseTagCsv(text, { keepPlaceholders: true });
  check('人工表（weilin-zh.csv，WeiLin 那份）在', parsed !== null, weilin);
  if (parsed !== null) {
    const groups = new Set(parsed.rows.map((one) => one.categories[0] ?? ''));
    // 小类：只有真细分过的行才有（小类跟大类同名的那 77 条只有大类）
    const subs = new Set(parsed.rows.map((one) => one.categories[1]).filter((one): one is string => one !== undefined && one !== ''));
    const hot = parsed.rows.filter((one) => one.hot > 0).length;
    check(
      '人工表：每条都标 builtin（导入守卫靠它压住机翻那层）',
      parsed.rows.every((one) => one.source === 'builtin') && parsed.stats.sources.builtin === parsed.rows.length,
      JSON.stringify(parsed.stats.sources),
    );
    check(
      '人工表：每条都有大类，九成以上还有小类（两级分类就是这份表的价值）',
      parsed.rows.every((one) => one.categories.length >= 1) &&
        parsed.rows.filter((one) => one.categories.length === 2).length > parsed.rows.length * 0.9,
      `${parsed.rows.length} 条 / 带分类 ${parsed.stats.grouped} / 两级 ${parsed.rows.filter((one) => one.categories.length === 2).length}`,
    );
    check(
      '人工表：下划线已经折掉（源是 booru 写法，折了才跟机翻表落在同一个键上）',
      parsed.rows.every((one) => !one.en.includes('_')),
      parsed.rows.filter((one) => one.en.includes('_')).slice(0, 3).map((one) => one.en).join(' / '),
    );
    check(
      '人工表：大类 11 个、小类上百个，父子关系一一对上',
      groups.size === 11 && subs.size > 100 && parsed.parents.size === subs.size,
      `${groups.size} 大类 / ${subs.size} 小类 / ${parsed.parents.size} 对父子`,
    );
    check('人工表：`未分类` 没被当成分类名（面板里那个是伪分类）', !parsed.parents.has('未分类') && !groups.has('未分类'), [...groups].join(' '));
    check(
      '人工表：多数条目有热度（热度从机翻表借 —— 不然这 4 千条会沉在 32 万条最底下）',
      hot > parsed.rows.length / 2,
      `${hot} / ${parsed.rows.length}`,
    );
  }
}

const fresh = newTags();
check('空库查得到 null', fresh.lookup('nope') === null && fresh.count() === 0);check(
  '记一条再查得到（键大小写不敏感）',
  fresh.upsert({ en: '1Girl', zh: '一个女孩', source: 'import' }) !== null && fresh.lookup('1girl')?.zh === '一个女孩',
);
check(
  '空译文不记（词库里的条目必须有译文）',
  fresh.upsert({ en: 'solo', zh: '   ', source: 'import' }) === null && fresh.lookup('solo') === null,
);
check(
  '手改的条目不被非 user 的写入覆盖',
  fresh.upsert({ en: '1girl', zh: '一个女孩（我改的）', source: 'user' }) !== null &&
    fresh.upsert({ en: '1girl', zh: '机器翻的', source: 'import' }) === null &&
    fresh.lookup('1girl')?.zh === '一个女孩（我改的）',
);
check(
  '只改分类时译文和来源都保留（局部更新不该抹掉别的字段）',
  (() => {
    fresh.upsert({ en: '1girl', categories: ['人物'] });
    const entry = fresh.lookup('1girl');
    return entry?.zh === '一个女孩（我改的）' && entry?.source === 'user' && entry?.categories[0] === '人物';
  })(),
);
check(
  '批量导入不覆盖手改过的行 —— 连它的分类 / 别名都不动（导入是无条件 DELETE 再写，不拦住就抹了）',
  (() => {
    const t = newTags();
    t.upsert({ en: 'hatsune miku', zh: '我改的译文', categories: ['人物'], aliases: ['miku'], source: 'user' });
    const written = t.importEntries([
      {
        key: 'hatsune miku',
        en: 'hatsune miku',
        zh: '机器翻的',
        categories: ['机翻-角色'],
        aliases: ['初音'],
        source: 'import',
        updatedAt: 0,
        hot: 120000,
      },
    ]);
    const entry = t.lookup('hatsune miku');
    return (
      written === 0 &&
      entry?.zh === '我改的译文' &&
      entry.categories.join() === '人物' &&
      entry.aliases.join() === 'miku' &&
      entry.hot === 0
    );
  })(),
);
check(
  '人工那层（builtin）压过机翻：先导人工再重导机翻，人工那条一条字段都不动',
  (() => {
    const t = newTags();
    // 人工表先写（守卫 `user`：只不许盖手改的），再导机翻（守卫 `import`：只许盖机翻）
    t.importEntries([tagRow('long hair', '长发', ['人物', '头发'], 'builtin')], new Map([['头发', '人物']]), 'user');
    const written = t.importEntries([tagRow('long hair', '长头发（机翻）', ['机翻-通用'], 'import')], undefined, 'import');
    const entry = t.lookup('long hair');
    return (
      written === 0 &&
      entry?.zh === '长发' &&
      entry?.source === 'builtin' &&
      entry.categories.join() === '人物,头发' &&
      entry.hot === 100
    );
  })(),
);
check(
  '机翻那层还是能被机翻盖（`import` 守卫不是"谁都不许盖"，换了新版 CSV 得能更新）',
  (() => {
    const t = newTags();
    t.importEntries([tagRow('1girl', '一个女孩', ['机翻-通用'], 'import', 10)], undefined, 'import');
    const written = t.importEntries([tagRow('1girl', '一个女孩', ['机翻-通用'], 'import', 999)], undefined, 'import');
    return written === 1 && t.lookup('1girl')?.hot === 999;
  })(),
);
check(
  '下划线归一：一律折成空格（`xxx_(yyy)` / 尾部下划线也算），顺带收空白',
  foldUnderscore('long_hair') === 'long hair' &&
    foldUnderscore('hanten_(clothes)') === 'hanten (clothes)' &&
    foldUnderscore('robot_') === 'robot' &&
    foldUnderscore('  a__b  ') === 'a b' &&
    foldUnderscore('1girl') === '1girl',
);
check(
  'CSV 的 source 列认出来（没这列时用 defaultSource）',
  (() => {
    const text = 'tag,zh,group,sub,count,source\nlong_hair,长发,人物,头发,100,builtin\nsolo,单人,画面全局,,50,\n';
    const { rows, stats } = parseTagCsv(text, { defaultSource: 'import' });
    return (
      rows.length === 2 &&
      rows[0]?.source === 'builtin' &&
      rows[0]?.en === 'long hair' &&
      rows[0]?.categories.join() === '人物,头发' &&
      rows[1]?.source === 'import' &&
      stats.sources.builtin === 1 &&
      stats.sources.import === 1
    );
  })(),
);
check(
  '老平表（dict.json）读进来：缺分类/别名补空，老 source 归到 import',
  (() => {
    const rows = sanitizeTags({ version: 1, entries: { a: { zh: '甲', source: 'api' }, b: { zh: '' }, c: 'nope' } });
    return (
      rows.length === 1 &&
      rows[0]?.source === 'import' &&
      rows[0]?.categories.length === 0 &&
      rows[0]?.aliases.length === 0
    );
  })(),
);
check(
  '落盘：关掉再打开条目还在（不是内存里的假象）',
  (() => {
    const file = path.join(tmpDir, 'persist.db');
    const first = openTagDb({ db: file, tagsJson, legacyDictJson: dictJson });
    first.upsert({ en: 'masterpiece', zh: '杰作', categories: ['画质'], aliases: ['mp'], source: 'import' });
    first.close();
    const second = openTagDb({ db: file, tagsJson, legacyDictJson: dictJson });
    const hit = second.lookup('MP');
    const ok = hit?.zh === '杰作' && hit?.categories[0] === '画质' && second.count() === 1;
    second.close();
    return ok;
  })(),
);
check(
  '迁移：tags.json 搬进库后改名成 .migrated（原件留着，也不让它复活）',
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-migrate-'));
    const json = path.join(dir, 'tags.json');
    fs.writeFileSync(json, JSON.stringify({ version: 2, entries: { '1girl': { zh: '一个女孩', categories: ['人物'], source: 'user' } } }), 'utf8');
    const db = openTagDb({ db: path.join(dir, 'tags.db'), tagsJson: json, legacyDictJson: path.join(dir, 'dict.json') });
    const ok = db.count() === 1 && db.lookup('1girl')?.zh === '一个女孩';
    db.close();
    return ok && fs.existsSync(`${json}.migrated`) && !fs.existsSync(json);
  })(),
);
check(
  '迁移：盘上只有老 dict.json 时也能搬（同样改名）',
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-migrate-'));
    const dict = path.join(dir, 'dict.json');
    fs.writeFileSync(dict, JSON.stringify({ entries: { masterpiece: { zh: '杰作' } } }), 'utf8');
    const db = openTagDb({ db: path.join(dir, 'tags.db'), tagsJson: path.join(dir, 'tags.json'), legacyDictJson: dict });
    const hit = db.lookup('masterpiece');
    const ok = hit?.zh === '杰作' && hit?.source === 'import';
    db.close();
    return ok && fs.existsSync(`${dict}.migrated`);
  })(),
);

console.log('别名：输入别名命中正名（导入外部库时用得上）');
const aliasTags = newTags();
aliasTags.upsert({ en: 'cinematic lighting', zh: '电影照明', aliases: ['cinematic light', 'movie lighting'], source: 'import' });
aliasTags.upsert({ en: 'depth of field', zh: '景深', source: 'import' });
check('别名命中正名', aliasTags.lookup('Cinematic Light')?.en === 'cinematic lighting');
check('正名照旧命中', aliasTags.lookup('cinematic lighting')?.zh === '电影照明');
check('查不到的返回 null', aliasTags.lookup('nope') === null);
check(
  '别名撞上另一个正名时以正名为准',
  (() => {
    aliasTags.upsert({ en: 'dof', zh: '景深缩写', source: 'import' });
    aliasTags.upsert({ en: 'depth of field', aliases: ['dof'] });
    return aliasTags.lookup('dof')?.en === 'dof';
  })(),
);
check('删掉条目后别名不再命中', (() => {
  const t = newTags();
  t.upsert({ en: 'best quality', zh: '最好的质量', aliases: ['best'], source: 'import' });
  const before = t.lookup('best') !== null;
  const deleted = t.remove('best quality');
  return before && deleted && t.lookup('best') === null && t.count() === 0;
})());

console.log('面板查询：搜索 / 分类 / 计数 / 删一条');
const panel = newTags();
panel.upsert({ en: 'masterpiece', zh: '杰作', categories: ['画质'], source: 'user' });
panel.upsert({ en: 'best quality', zh: '最好的质量', categories: ['画质'], source: 'import' });
panel.upsert({ en: '1girl', zh: '一个女孩', categories: ['人物'], source: 'import' });
panel.upsert({ en: 'solo', zh: '单人', source: 'builtin' });
check(
  '计数：总数 + 未分类 + 每个分类几条（**不按来源分** —— 进库就是库）',
  (() => {
    const r = panel.query();
    return (
      r.counts.total === 4 &&
      r.counts.uncategorized === 1 &&
      Object.keys(r.counts).sort().join() === 'total,uncategorized' &&
      same(r.categories.map((c) => `${c.name}:${c.count}`), ['画质:2', '人物:1'])
    );
  })(),
);
check('按分类筛', (() => {
  const r = panel.query({ category: '画质' });
  return r.total === 2 && same(r.tags.map((t) => t.en).sort(), ['best quality', 'masterpiece']);
})());
check('未分类筛（__none__）', panel.query({ category: '__none__' }).tags.map((t) => t.en).join() === 'solo');
check('搜英文 / 搜中文（**1 个字也行**，这正是 FTS5 trigram 给不了的）/ 搜别名', (() => {
  const byEn = panel.query({ q: 'best' }).tags.map((t) => t.en);
  const byZh = panel.query({ q: '女孩' }).tags.map((t) => t.en);
  const byOneChar = panel.query({ q: '女' }).tags.map((t) => t.en);
  const byAlias = aliasTags.query({ q: 'movie light' }).tags.map((t) => t.en);
  return (
    same(byEn, ['best quality']) &&
    same(byZh, ['1girl']) &&
    same(byOneChar, ['1girl']) &&
    same(byAlias, ['cinematic lighting'])
  );
})());
check(
  'limit 生效，总数封顶在 limit+1（面板只显示一页，精确值要再全表扫一遍）',
  (() => {
    const page = panel.query({ limit: 2 });
    return page.tags.length === 2 && page.total === 3 && panel.query({ limit: 10 }).total === 4;
  })(),
);
check(
  '排序：导入的一批内部按 hot DESC，你碰过的（updated_at 有值）永远排在它们前面',
  (() => {
    const t = newTags();
    const imported = (i: number, hot: number) => ({
      key: `k${i}`,
      en: `k${i}`,
      zh: `译${i}`,
      categories: [],
      aliases: [],
      source: 'import',
      updatedAt: 0,
      hot,
    });
    t.importEntries([imported(1, 10), imported(2, 900), imported(3, 500)]);
    const byHot = t.query().tags.map((x) => x.en);
    t.upsert({ en: 'zzz', zh: '我自己加的' });
    return same(byHot, ['k2', 'k3', 'k1']) && t.query().tags[0]?.en === 'zzz';
  })(),
);
check('LIKE 的元字符当字面量（搜一个 % 不该把整库捞出来）', (() => {
  const t = newTags();
  t.upsert({ en: '100% cotton', zh: '纯棉', source: 'import' });
  t.upsert({ en: 'masterpiece', zh: '杰作', source: 'import' });
  return same(t.query({ q: '%' }).tags.map((x) => x.en), ['100% cotton']) && t.query({ q: '_' }).tags.length === 0;
})());
check(
  '词库里没有"按来源清空"这回事：要清就一条条删（删完别名跟着走）',
  (() => {
    const removed = panel.remove('best quality');
    return removed && panel.lookup('best quality') === null && panel.count() === 3;
  })(),
);

console.log('导入脚本（scripts/import-tags.ts：CSV → tags.db）');
check(
  '端到端：列按表头认（alias 当译文）、category 映射成 机翻-xxx、count 进 hot、--min-count 过滤、手改过的整条跳过',
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-import-'));
    const csv = path.join(dir, 'tags.csv');
    fs.writeFileSync(
      csv,
      [
        'tag,category,count,alias',
        '1girl,0,8419190,"1女"',
        'hatsune_miku,4,120000,初音未来',
        '"my_hero_academia,",6,39259,我的英雄学院',
        'untouched,0,8224,untouched',
        'obscure thing,0,10,冷门',
        'no translate,0,999,',
      ].join('\n'),
      'utf8',
    );
    const db = path.join(dir, 'tags.db');
    const seed = openTagDb({ db, tagsJson: path.join(dir, 'tags.json'), legacyDictJson: path.join(dir, 'dict.json') });
    seed.upsert({ en: '1girl', zh: '我改过的译文', categories: ['人物'], source: 'user' });
    seed.close();
    const out = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./import-tags.ts', import.meta.url)), csv, '--db', db, '--min-count', '100'],
      { encoding: 'utf8' },
    );
    const after = openTagDb({ db, tagsJson: path.join(dir, 'tags.json'), legacyDictJson: path.join(dir, 'dict.json') });
    const mine = after.lookup('1girl');
    // 下划线在**导入**这一层就折成空格了（`hatsune_miku` → `hatsune miku`）：库里只有空格形这一份
    const miku = after.lookup('hatsune miku');
    // 真表里有引号包着的 tag（tag 自己带逗号）：按逗号裸切会切出一个不存在的 tag
    const academia = after.lookup('my hero academia,');
    const ok =
      after.count() === 3 &&
      mine?.zh === '我改过的译文' &&
      mine.categories.join() === '人物' &&
      mine.source === 'user' &&
      miku?.zh === '初音未来' &&
      miku.categories.join() === '机翻-角色' &&
      miku.hot === 120000 &&
      miku.source === 'import' &&
      miku.updatedAt === 0 &&
      academia?.zh === '我的英雄学院' &&
      academia.categories.join() === '机翻-其他' &&
      // 折的是导入那一层，查的时候不折（`tagKey` 没动）—— 下划线形查不到，这是已知取舍
      after.lookup('hatsune_miku') === null &&
      after.lookup('obscure thing') === null &&
      after.lookup('untouched') === null &&
      after.lookup('no translate') === null;
    after.close();
    return ok && out.includes('机翻-角色') && out.includes('译文同正名 1');
  })(),
);
check(
  'LFS 指针当输入 → 报「先 git lfs pull」并退出 1（而不是安静地入库 0 条）',
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-lfs-'));
    const csv = path.join(dir, 'pointer.csv');
    fs.writeFileSync(csv, 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 5448620\n', 'utf8');
    try {
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./import-tags.ts', import.meta.url)), csv, '--db', path.join(dir, 'tags.db')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return false;
    } catch (err) {
      const failed = err as { status?: number; stderr?: string };
      return failed.status === 1 && (failed.stderr ?? '').includes('git lfs pull');
    }
  })(),
);

console.log('设置与用量');
check(
  '默认值：有道体验版 / 自动译开 / 每日 2000 / 超时 8s / 节流 6s',
  (() => {
    const s = sanitizeSettings(null);
    return (
      s.provider === 'youdao-demo' &&
      s.autoTranslate === true &&
      s.maxCallsPerDay === 2000 &&
      s.timeoutMs === 8000 &&
      s.minIntervalMs === 6000
    );
  })(),
);
check('未知 provider 退回默认', sanitizeSettings({ provider: 'nope' }).provider === 'youdao-demo');
check('越界收敛到范围内', (() => {
  const s = sanitizeSettings({ maxCallsPerDay: -5, timeoutMs: 999999, autoTranslate: 'yes', minIntervalMs: -1 });
  return s.maxCallsPerDay === 0 && s.timeoutMs === 30000 && s.autoTranslate === false && s.minIntervalMs === 0;
})());
check('用量跨天清零', sanitizeUsage({ date: '2000-01-01', calls: 999 }, '2026-01-01').calls === 0);
check('当天用量保留', sanitizeUsage({ date: '2026-01-01', calls: 12 }, '2026-01-01').calls === 12);

/** 有道体验版的 stub：记下每次发出的 q，按 map 回译文 */
function youdaoStub(map: Record<string, string>, { ok = true, errorCode = '0' } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { body: URLSearchParams }) => {
    const q = String(init.body.get('q'));
    calls.push(`${url.includes('aidemo.youdao.com') ? 'youdao' : url}|${q}`);
    if (!ok) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ errorCode, translation: [map[q] ?? `译(${q})`] }) };
  };
  return { fetchImpl, calls };
}

/** 契约测试里一律不真等节流：默认注入 no-op sleep（节流本身另有专门的用例去量） */
const noSleep = async (): Promise<void> => {};
const translate = (texts: string[], options: Record<string, unknown> = {}) =>
  translateTexts(texts, { sleep: noSleep, ...options });

console.log('翻译编排：词库优先 → provider 兜底 → 现翻结果不进词库');
{
  const dict = newTags();
  dict.upsert({ en: 'masterpiece', zh: '杰作', source: 'user' });
  const stub = youdaoStub({});
  const first = await translate(['masterpiece', 'best quality'], { tagLookup: dict, fetchImpl: stub.fetchImpl });
  check('词库命中的不发请求', same(stub.calls, ['youdao|best quality']), JSON.stringify(stub.calls));
  check(
    '结果按入参顺序对齐，来源标清楚（命中=dict / 现翻=api）',
    same(first.results.map((r) => `${r.text}=${r.translation}/${r.source}`), ['masterpiece=杰作/dict', 'best quality=译(best quality)/api']),
    JSON.stringify(first.results),
  );
  check(
    '现翻结果**不写词库**（词库只装人认可的）',
    dict.lookup('best quality') === null && dict.count() === 1,
    String(dict.count()),
  );

  const cache = new Map<string, string>();
  const cached = await translate(['best quality'], { tagLookup: dict, apiCache: cache, fetchImpl: stub.fetchImpl });
  check('带会话缓存时第二次零请求，来源仍是"机翻"', stub.calls.length === 2 && cached.results[0]?.source === 'api', JSON.stringify(cached.results));
  const hitAgain = await translate(['best quality'], { tagLookup: dict, apiCache: cache, fetchImpl: stub.fetchImpl });
  check(
    '缓存命中：不再打接口',
    stub.calls.length === 2 && hitAgain.results[0]?.source === 'api' && hitAgain.results[0]?.translation === '译(best quality)',
    JSON.stringify(hitAgain.results),
  );

  const dictHit = await translate(['masterpiece'], { tagLookup: dict, fetchImpl: stub.fetchImpl });
  check('词库命中仍然零请求，且来源透传成 dict（工作区画「库」）', stub.calls.length === 2 && dictHit.results[0]?.source === 'dict');

  dict.upsert({ en: 'imported thing', zh: '导入的译文', source: 'import' });
  const importHit = await translate(['imported thing'], { tagLookup: dict, fetchImpl: stub.fetchImpl });
  check(
    '命中导入的机翻表 → 来源标 import（工作区画「导」）且照样零请求 —— 跟"你改过的"分开，十几万条灌进来后才分得清',
    stub.calls.length === 2 && importHit.results[0]?.source === 'import' && importHit.results[0]?.translation === '导入的译文',
    JSON.stringify(importHit.results),
  );

  const masked = youdaoStub({ masterpiece: '杰作' });
  const weighted = await translate(['(masterpiece:1.2)', '<lora:add_detail:0.8>'], {
    tagLookup: newTags(),
    fetchImpl: masked.fetchImpl,
  });
  check('权重语法：只把词发出去，译文贴回结构', same(masked.calls, ['youdao|masterpiece']) && weighted.results[0]?.translation === '(杰作:1.2)', JSON.stringify(weighted.results));
  check('<lora:...> 不发请求、标 skip', weighted.results[1]?.source === 'skip' && masked.calls.length === 1);
}

console.log('限流：节流 + 411 退避重试');
{
  const waits: number[] = [];
  const spySleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  const paced = youdaoStub({});
  await translate(['a', 'b', 'c'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ minIntervalMs: 6000 }),
    fetchImpl: paced.fetchImpl,
    sleep: spySleep,
  });
  check(
    '3 条串行，每条之间按 minIntervalMs 节流',
    paced.calls.length === 3 && waits.length === 3 && waits.every((ms) => ms > 0 && ms <= 6000),
    JSON.stringify(waits),
  );
  // 第 1 条也在等，因为**上一批刚打完** —— 节流记的是"上一次真的打出去"，跨批次、跨请求都算
  waits.length = 0;
  const nextBatch = youdaoStub({});
  await translate(['d'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ minIntervalMs: 6000 }),
    fetchImpl: nextBatch.fetchImpl,
    sleep: spySleep,
  });
  check('节流是全局的：换一批、换一次请求也照样等', waits.length === 1 && (waits[0] ?? 0) > 0, JSON.stringify(waits));

  const noPace = youdaoStub({});
  await translate(['a', 'b'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ minIntervalMs: 0 }),
    fetchImpl: noPace.fetchImpl,
    sleep: spySleep,
  });
  check('节流设 0 就一次都不等', noPace.calls.length === 2, JSON.stringify(noPace.calls));

  // 第 1 次 411、第 2 次成功 → 应该退避重试后拿到译文
  let attempt = 0;
  const flaky = async (_url: string, init: { body: URLSearchParams }) => {
    attempt += 1;
    if (attempt === 1) return { ok: true, status: 200, json: async () => ({ errorCode: '411', msg: '请求频率过快' }) };
    const q = String(init.body.get('q'));
    return { ok: true, status: 200, json: async () => ({ errorCode: '0', translation: [`译(${q})`] }) };
  };
  const retried = await translate(['solo'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ minIntervalMs: 0 }),
    fetchImpl: flaky,
    sleep: spySleep,
  });
  check(
    '撞上 411 会退避重试，第二次拿到译文',
    attempt === 2 && retried.results[0]?.source === 'api' && retried.error === undefined,
    JSON.stringify(retried),
  );

  const alwaysLimited = youdaoStub({}, { errorCode: '411' });
  const blocked = await translate(['solo'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ minIntervalMs: 0 }),
    fetchImpl: alwaysLimited.fetchImpl,
    sleep: spySleep,
  });
  check(
    '重试用尽：标 error、错误码 RATE_LIMIT、词库不动',
    alwaysLimited.calls.length === 3 && blocked.results[0]?.source === 'error' && blocked.error?.code === 'RATE_LIMIT',
    JSON.stringify(blocked.error),
  );
  check('限流的错误消息说清是什么', String(blocked.error?.message ?? '').includes('限流') === true, String(blocked.error?.message));
}

console.log('翻译编排：失败与配额都不炸');
{
  const failing = youdaoStub({}, { ok: false });
  const broken = await translate(['best quality'], { tagLookup: newTags(), fetchImpl: failing.fetchImpl });
  check(
    'provider 报错：结果标 error、错误码带上、词库不动',
    broken.results[0]?.source === 'error' && broken.error?.code === 'PROVIDER',
    JSON.stringify(broken),
  );
  const emptyCode = youdaoStub({}, { errorCode: '50' });
  const refused = await translate(['solo'], { tagLookup: newTags(), fetchImpl: emptyCode.fetchImpl });
  check('有道返回非 0 错误码也当失败', refused.results[0]?.source === 'error', JSON.stringify(refused.error));

  const quotaStub = youdaoStub({});
  const usage = { date: '2026-01-01', calls: 2000 };
  const overQuota = await translate(['1girl'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ maxCallsPerDay: 2000 }),
    usage,
    fetchImpl: quotaStub.fetchImpl,
  });
  check(
    '配额用完：一个请求都不发，返回 QUOTA',
    quotaStub.calls.length === 0 && overQuota.error?.code === 'QUOTA' && usage.calls === 2000,
    JSON.stringify(overQuota.error),
  );
  const counted = { date: '2026-01-01', calls: 1999 };
  const okStub = youdaoStub({});
  await translate(['1girl'], { tagLookup: newTags(), settings: sanitizeSettings({ maxCallsPerDay: 2000 }), usage: counted, fetchImpl: okStub.fetchImpl });
  check('成功的调用计入当天用量', okStub.calls.length === 1 && counted.calls === 2000);
  const halfStub = youdaoStub({});
  const half = await translate(['1girl', 'solo'], {
    tagLookup: newTags(),
    settings: sanitizeSettings({ maxCallsPerDay: 1 }),
    usage: { date: '2026-01-01', calls: 0 },
    fetchImpl: halfStub.fetchImpl,
  });
  check(
    '配额只够一条时：宁可少翻，也不翻一半（没轮上的标 error，不泄漏内部状态）',
    halfStub.calls.length === 1 && half.results[0]?.source === 'api' && half.results[1]?.source === 'error' && half.error?.code === 'QUOTA',
    JSON.stringify(half.results),
  );
}

console.log('provider 注册表');
check('有道体验版不需要任何凭据字段', same(PROVIDERS['youdao-demo']?.fields ?? null, []) && typeof PROVIDERS['youdao-demo']?.label === 'string');

console.log('区块库：预设单块的存储与路由');
{
  const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-blockpresets-'));
  const handlers: Record<string, (request: unknown, reply: unknown) => unknown> = {};
  const record =
    (method: string) =>
    (routePath: string, handler: (request: unknown, reply: unknown) => unknown): void => {
      handlers[`${method} ${routePath}`] = handler;
    };
  const reply = (): { status: number; body: unknown; code: (n: number) => unknown; send: (b: unknown) => unknown } => ({
    status: 200,
    body: null,
    code(this: { status: number }, n: number) {
      this.status = n;
      return this;
    },
    send(this: { body: unknown }, body: unknown) {
      this.body = body;
      return this;
    },
  });
  // 区块块与分类共用一个 space（同一份 block-presets.json），只是各注册自己那张路由表
  const helpers = {
    routes: { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE') },
    space: { packageName: 'x', root: spaceDir, resolve: (f: string) => path.join(spaceDir, f) },
    badRequest: (r: { code: (n: number) => { send: (b: unknown) => unknown } }, message: string) =>
      r.code(400).send({ error: { code: 'BAD_REQUEST', message } }),
    log: () => {},
  };
  server.registerBlockPresetRoutes(helpers as unknown as Parameters<typeof server.registerBlockPresetRoutes>[0]);
  server.registerBlockCategoryRoutes(helpers as unknown as Parameters<typeof server.registerBlockCategoryRoutes>[0]);

  // 有的 handler 直接 `return {...}`（GET），有的 `reply.code().send()`（POST/PUT）—— 两种都要收
  const call = async (key: string, request: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = reply();
    const returned = await handlers[key]?.({ params: {}, body: null, ...request }, r);
    return { ...r, body: r.body ?? returned ?? null } as unknown as Record<string, unknown>;
  };
  const stored = (): {
    version?: number;
    categories: { id: string; name: string; sort: number }[];
    presets: { id: string; name: string; items: string[]; categoryId?: string }[];
  } =>
    JSON.parse(fs.readFileSync(path.join(spaceDir, 'block-presets.json'), 'utf8')) as never;

  const created = await call('POST /block-presets', {
    body: { name: '场景块', title: '场景', color: '#4ac38a', mode: 'text', items: ['a sentence.', '  ', 'another one.'] },
  });
  const createdId = ((created.body as { preset?: { id?: string } }).preset ?? {}).id ?? '';
  check('新建：201 + 落盘', created.status === 201 && stored().presets.length === 1, JSON.stringify(created.body).slice(0, 90));
  check('条目里空白项被丢掉（不留空条目）', stored().presets[0]?.items.length === 2, JSON.stringify(stored().presets[0]?.items));
  check('属性原样存下（标题/颜色/风格）', JSON.stringify({ ...stored().presets[0], id: '', updatedAt: 0, name: '' }).includes('"mode":"text"'), JSON.stringify(stored().presets[0]));

  const listed = await call('GET /block-presets');
  const first = ((listed.body as { presets?: Record<string, unknown>[] }).presets ?? [])[0] ?? {};
  check('列表给摘要 + 前几条预览', first.itemCount === 2 && (first.preview as string[]).length === 2 && first.name === '场景块', JSON.stringify(first));
  check('列表不带全部条目（几百条的块不该整份传）', first.items === undefined);

  const one = await call('GET /block-presets/:id', { params: { id: createdId } });
  check('取单条：拿到全部条目', (one.body as { preset?: { items?: string[] } }).preset?.items?.length === 2);
  check('取不存在的 id：404', (await call('GET /block-presets/:id', { params: { id: 'nope' } })).status === 404);

  const renamed = await call('PUT /block-presets/:id', { params: { id: createdId }, body: { name: '场景块 2' } });
  check('改名：名字变了、条目一条没动', (renamed.body as { preset?: { name?: string; items?: string[] } }).preset?.name === '场景块 2' && stored().presets[0]?.items.length === 2);
  check('改名给空串：400', (await call('PUT /block-presets/:id', { params: { id: createdId }, body: { name: '  ' } })).status === 400);
  check('改不存在的 id：404', (await call('PUT /block-presets/:id', { params: { id: 'nope' }, body: { name: 'x' } })).status === 404);

  check('名字空的新建：400', (await call('POST /block-presets', { body: { name: '', items: ['a'] } })).status === 400);
  check('请求体不是对象：400', (await call('POST /block-presets', { body: 'nope' })).status === 400);
  check('风格写错不炸（兜底成 tag）', ((await call('POST /block-presets', { body: { name: '兜底', mode: '乱写', items: ['x'] } })).body as { preset?: { mode?: string } }).preset?.mode === 'tag');
  check('没给颜色就用默认色', ((await call('POST /block-presets', { body: { name: '无色', items: [] } })).body as { preset?: { color?: string } }).preset?.color === '#6ea8fe');

  const removed = await call('DELETE /block-presets/:id', { params: { id: createdId } });
  check('删除：removed=true 且真的从盘上没了', removed.body !== null && stored().presets.every((one) => one.name !== '场景块 2'), JSON.stringify(stored().presets.map((one) => one.name)));
  check('删不存在的 id：removed=false（不炸）', ((await call('DELETE /block-presets/:id', { params: { id: 'nope' } })).body as { removed?: boolean }).removed === false);

  // 上限：塞满再存一条
  const many = Array.from({ length: server.LIMITS.blockPresets }, (_v, i) => ({
    id: `p${i}`,
    name: `n${i}`,
    updatedAt: 1,
    title: '',
    color: '#6ea8fe',
    mode: 'tag',
    items: ['x'],
  }));
  fs.writeFileSync(path.join(spaceDir, 'block-presets.json'), JSON.stringify({ version: 1, presets: many }));
  check('到达上限后再存：400 且不动盘上那份', (await call('POST /block-presets', { body: { name: '多出来的', items: [] } })).status === 400 && stored().presets.length === server.LIMITS.blockPresets);

  // 手改坏的文件：坏行跳过，好行照用
  fs.writeFileSync(
    path.join(spaceDir, 'block-presets.json'),
    JSON.stringify({ version: 1, presets: [{ name: '好的', items: ['a'] }, { name: '' }, 'nope', { items: ['没名字'] }] }),
  );
  const survived = await call('GET /block-presets');
  check('盘上坏行跳过、好行照用（手改坏文件不该让整个库打不开）', ((survived.body as { presets?: unknown[] }).presets ?? []).length === 1);

  // ── 分类：独立 id 寻址、允许重名（跟词库那套"按名字寻址"的不是一回事）──────────
  const presetId = 'p-1';
  fs.writeFileSync(
    path.join(spaceDir, 'block-presets.json'),
    JSON.stringify({ version: 1, presets: [{ id: presetId, name: '场景块', items: ['a'], mode: 'tag' }] }),
  );
  const cats = async (): Promise<{ categories: { id: string; name: string; count: number }[]; uncategorized: number }> =>
    (await call('GET /block-categories')).body as never;
  const sortOf = (id: string): number => stored().categories.find((one) => one.id === id)?.sort ?? -1;

  const freshCats = await cats();
  check('v1 老文件读得进：没有分类，那唯一一块算"未分类"', freshCats.categories.length === 0 && freshCats.uncategorized === 1, JSON.stringify(freshCats));
  check('老块没有 categoryId，摘要里补成空串（面板据此显示未分类）', ((await call('GET /block-presets')).body as { presets?: { categoryId?: string }[] }).presets?.[0]?.categoryId === '');

  const catNew = await call('POST /block-categories', { body: { name: ' 人物 ' } });
  const catId = ((catNew.body as { category?: { id?: string; name?: string } }).category ?? {}).id ?? '';
  check(
    '新建分类：201 + 名字 trim 过 + 独立 id',
    catNew.status === 201 && (catNew.body as { category?: { name?: string } }).category?.name === '人物' && catId !== '',
    JSON.stringify(catNew.body),
  );
  check('新建分类一个块都不动，落盘升到 v2 且带 categories 段', stored().presets.length === 1 && stored().version === 2, JSON.stringify({ version: stored().version, categories: stored().categories.length }));
  check('分类名空：400', (await call('POST /block-categories', { body: { name: '   ' } })).status === 400);
  check('分类请求体不是对象：400', (await call('POST /block-categories', { body: 'nope' })).status === 400);

  check(
    '归到不存在的分类：当成未分类（分类刚被删，也不该让"存一块"失败）',
    ((await call('PUT /block-presets/:id', { params: { id: presetId }, body: { categoryId: 'nope' } })).body as { preset?: { categoryId?: string } })
      .preset?.categoryId === '',
  );
  const assigned = await call('PUT /block-presets/:id', { params: { id: presetId }, body: { categoryId: catId } });
  check(
    '归类：categoryId 变了（名字 / 条目一条没动）',
    (assigned.body as { preset?: { categoryId?: string; name?: string; items?: string[] } }).preset?.categoryId === catId &&
      stored().presets[0]?.categoryId === catId &&
      stored().presets[0]?.items.length === 1,
    JSON.stringify((assigned.body as { preset?: unknown }).preset),
  );
  const counted = await cats();
  check('左栏计数是现算的：人物 1 / 未分类 0', counted.categories[0]?.count === 1 && counted.uncategorized === 0, JSON.stringify(counted));

  const catTwoId = ((await call('POST /block-categories', { body: { name: '光照' } })).body as { category?: { id?: string } }).category?.id ?? '';
  const ordered = await call('PUT /block-categories/order', { body: { ids: [catTwoId, catId] } });
  check(
    '拖完发整列新顺序：回的左栏就是新顺序',
    ((ordered.body as { categories?: { id: string }[] }).categories ?? []).map((one) => one.id).join('|') === `${catTwoId}|${catId}`,
    JSON.stringify((ordered.body as { categories?: unknown }).categories),
  );
  check(
    '顺序落到盘上（sort 递增，重新读一遍还是这个顺序）',
    (await cats()).categories.map((one) => one.id).join('|') === `${catTwoId}|${catId}` && sortOf(catTwoId) < sortOf(catId),
    `${sortOf(catTwoId)} vs ${sortOf(catId)}`,
  );
  check('ids 不是数组：400', (await call('PUT /block-categories/order', { body: { ids: 'nope' } })).status === 400);

  // 列表拖排序：`presets` 本身就是有序数组，所以重排 = 换排列（不额外存序号 —— 序号是给
  // "分类"那种要被别处排序引用的东西用的）
  const secondId = ((await call('POST /block-presets', { body: { name: '第二块', items: ['b'] } })).body as { preset?: { id?: string } }).preset?.id ?? '';
  check('新建的块排在最后', stored().presets.map((one) => one.id).join('|') === `${presetId}|${secondId}`, stored().presets.map((one) => one.id).join('|'));
  const presetsOrdered = await call('PUT /block-presets/order', { body: { ids: [secondId, presetId] } });
  check(
    '拖完发整列新顺序：回的列表就是新顺序，并且落了盘',
    ((presetsOrdered.body as { presets?: { id: string }[] }).presets ?? []).map((one) => one.id).join('|') === `${secondId}|${presetId}` &&
      stored().presets.map((one) => one.id).join('|') === `${secondId}|${presetId}`,
    JSON.stringify((presetsOrdered.body as { presets?: unknown }).presets),
  );
  check(
    'ids 里没提到的垫在后面（不丢条目）',
    ((await call('PUT /block-presets/order', { body: { ids: [secondId] } })).body as { presets?: { id: string }[] }).presets?.map((one) => one.id).join('|') === `${secondId}|${presetId}`,
    stored().presets.map((one) => one.id).join('|'),
  );
  check(
    'order 不会被当成 id（命中的是排序路由，不是 PUT /:id）',
    (await call('PUT /block-presets/order', { body: { ids: [presetId, secondId] } })).status === 200 && stored().presets[0]?.id === presetId,
    stored().presets.map((one) => one.id).join('|'),
  );
  check('ids 不是数组：400', (await call('PUT /block-presets/order', { body: { ids: 'nope' } })).status === 400);
  check('ids 里有非字符串：400', (await call('PUT /block-presets/order', { body: { ids: [1] } })).status === 400);
  check('ids 是空数组：400', (await call('PUT /block-presets/order', { body: { ids: [] } })).status === 400);
  check('ids 里全是不认识的 id：200（没有可排的就什么都不动）', (await call('PUT /block-presets/order', { body: { ids: ['nope'] } })).status === 200);
  // 顺序验完把第二块删掉：后面"删分类不删块"那些用例按一块算
  await call('DELETE /block-presets/:id', { params: { id: secondId } });

  check(
    '改分类名：按 id 改，跟另一个分类重名也照改（不合并、不报错）',
    ((await call('PUT /block-categories', { body: { id: catTwoId, name: '人物' } })).body as { category?: { name?: string } }).category?.name === '人物' &&
      (await cats()).categories.filter((one) => one.name === '人物').length === 2,
    JSON.stringify((await cats()).categories),
  );
  check('分类改空名：400', (await call('PUT /block-categories', { body: { id: catId, name: ' ' } })).status === 400);
  check('分类缺 id：400', (await call('PUT /block-categories', { body: { name: 'x' } })).status === 400);
  check('改不存在的分类：404', (await call('PUT /block-categories', { body: { id: 'nope', name: 'x' } })).status === 404);

  const catDeleted = await call('DELETE /block-categories', { body: { id: catId } });
  check(
    '删分类：removed=true，并报出影响了几块（面板先摆范围再确认）',
    (catDeleted.body as { removed?: boolean; cleared?: number }).removed === true && (catDeleted.body as { cleared?: number }).cleared === 1,
    JSON.stringify(catDeleted.body),
  );
  check('删分类一条块都不删，只是回到未分类', stored().presets.length === 1 && stored().presets[0]?.categoryId === '' && (await cats()).uncategorized === 1);
  check('删不存在的分类：removed=false（不炸）', ((await call('DELETE /block-categories', { body: { id: 'nope' } })).body as { removed?: boolean }).removed === false);

  fs.writeFileSync(
    path.join(spaceDir, 'block-presets.json'),
    JSON.stringify({
      version: 2,
      categories: Array.from({ length: server.LIMITS.blockCategories }, (_v, i) => ({ id: `c${i}`, name: `c${i}`, sort: (i + 1) * 10 })),
      presets: [],
    }),
  );
  check(
    '分类到达上限后再建：400 且不动盘上那份',
    (await call('POST /block-categories', { body: { name: '多出来的' } })).status === 400 && stored().categories.length === server.LIMITS.blockCategories,
  );

  fs.rmSync(spaceDir, { recursive: true, force: true });
}

// 内置区块库：`assets/block-library.json` 是 WeiLin 存档预处理来的（scripts/build-blocks.ts），
// 路由按产物读它。产物里没有（还没 build:plugins）时按钮就不该画 —— 两种环境都要说得通。
console.log('区块库：内置那份（产物自带）');
{
  const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-blockbundled-'));
  const handlers: Record<string, (request: unknown, reply: unknown) => unknown> = {};
  const record =
    (method: string) =>
    (routePath: string, handler: (request: unknown, reply: unknown) => unknown): void => {
      handlers[`${method} ${routePath}`] = handler;
    };
  const reply = (): { status: number; body: unknown; code: (n: number) => unknown; send: (b: unknown) => unknown } => ({
    status: 200,
    body: null,
    code(this: { status: number }, n: number) {
      this.status = n;
      return this;
    },
    send(this: { body: unknown }, body: unknown) {
      this.body = body;
      return this;
    },
  });
  const helpers = {
    routes: { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE') },
    space: { packageName: 'x', root: spaceDir, resolve: (f: string) => path.join(spaceDir, f) },
    badRequest: (r: { code: (n: number) => { send: (b: unknown) => unknown } }, message: string) =>
      r.code(400).send({ error: { code: 'BAD_REQUEST', message } }),
    log: () => {},
  };
  server.registerBlockPresetRoutes(helpers as unknown as Parameters<typeof server.registerBlockPresetRoutes>[0]);
  const call = async (key: string, request: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = reply();
    const returned = await handlers[key]?.({ params: {}, body: null, ...request }, r);
    return { ...r, body: r.body ?? returned ?? null } as unknown as Record<string, unknown>;
  };
  const stored = (): { categories: { name: string }[]; presets: { name: string; items: string[]; categoryId: string; mode: string }[] } =>
    JSON.parse(fs.readFileSync(path.join(spaceDir, 'block-presets.json'), 'utf8')) as never;

  const info = ((await call('GET /block-presets/bundled')).body as { bundled?: { available?: boolean; count?: number } }).bundled ?? {};
  check('GET /block-presets/bundled 回 { available, bytes, count }', typeof info.available === 'boolean' && typeof info.count === 'number', JSON.stringify(info));
  if (info.available === true) {
    const done = (await call('POST /block-presets/bundled')).body as { imported?: number; categoriesCreated?: number };
    check('导入内置区块库：块数跟报的一致，分类按 catOrder 现建', done.imported === info.count && done.categoriesCreated === 12, JSON.stringify(done));
    check(
      '导入后落盘：160 块、12 个分类、顺序就是 catOrder（要服装在最前，负提示词在最后）',
      stored().presets.length === info.count &&
        stored().categories.length === 12 &&
        stored().categories[0]?.name === '要服装' &&
        stored().categories.at(-1)?.name === '负提示词',
      JSON.stringify(stored().categories.map((one) => one.name)),
    );
    const sample = stored().presets.find((one) => one.name.includes('负提示词')) ?? stored().presets[0];
    check('条目是切好的（一条 prompt 变 N 个条目，不是整段一行）', (sample?.items.length ?? 0) > 1 && sample?.mode === 'tag', JSON.stringify(sample?.items.slice(0, 4)));
    check(
      '权重括号里的逗号没被切开（`(a, b:2)` 是一个条目）',
      stored().presets.some((one) => one.items.some((item) => item.startsWith('(') && item.includes(', '))),
      JSON.stringify(stored().presets[0]?.items.slice(0, 3)),
    );
    check('分类都建出来了：没有块落在未分类', stored().presets.every((one) => one.categoryId !== ''));
    const again = (await call('POST /block-presets/bundled')).body as { imported?: number; error?: { message?: string } };
    const againStatus = (await call('POST /block-presets/bundled')).status;
    // 160 + 160 = 320 > 上限 300：第二次该被挡下并说清原因（不是"导到一半"）
    check(
      '再导一遍撞上限：400 + 说清超了多少，库一条不动',
      againStatus === 400 && String(again.error?.message ?? '').includes(String(server.LIMITS.blockPresets)) && stored().presets.length === info.count,
      `${againStatus} / ${again.error?.message ?? ''}`,
    );
  } else {
    check(
      '产物里没有内置区块库：POST 回 400 并说清怎么办（不是 500 / 静默成功）',
      (await call('POST /block-presets/bundled')).status === 400 &&
        String(((await call('POST /block-presets/bundled')).body as { error?: { message?: string } }).error?.message ?? '').includes('build:plugins'),
    );
    check('产物里没有内置区块库：一个文件都不写', fs.readdirSync(spaceDir).length === 0, fs.readdirSync(spaceDir).join(' '));
  }
  fs.rmSync(spaceDir, { recursive: true, force: true });
}

// 词库用例建的临时库：跑完一起清（跑挂了也清，不然 /tmp 里会攒下一堆 tags-N.db）
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failed === 0 ? '\n✅ 契约测试通过' : `\n❌ ${failed} 项不通过`);process.exit(failed === 0 ? 0 : 1);
