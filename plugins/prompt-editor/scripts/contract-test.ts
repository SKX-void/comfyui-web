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
import {
  PROVIDERS,
  docFromStored,
  maskPromptSyntax,
  queryTags,
  rawFromStored,
  removeTag,
  sanitizeDoc,
  sanitizeSettings,
  sanitizeTags,
  sanitizeUsage,
  storedFromDoc,
  storedFromRaw,
  tagKey,
  tagsLookup,
  translateTexts,
  upsertTag,
} from '../server.js';

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
    raw.blocks.every((meta: Record<string, unknown>) => !('items' in meta)) &&
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
const freshTags = sanitizeTags(null);
check(
  '坏输入退化成空库',
  Object.keys(freshTags.entries).length === 0 && sanitizeTags('nope').entries !== undefined && sanitizeTags(null).aliasIndex !== undefined,
);
check(
  '记一条再查得到',
  upsertTag(freshTags, { en: '1Girl', zh: '一个女孩', source: 'import' }) !== null &&
    tagsLookup(freshTags, '1girl')?.zh === '一个女孩',
);
check(
  '空译文不记（词库里的条目必须有译文）',
  upsertTag(freshTags, { en: 'solo', zh: '   ', source: 'import' }) === null && tagsLookup(freshTags, 'solo') === null,
);
check(
  '手改的条目不被非 user 的写入覆盖',
  upsertTag(freshTags, { en: '1girl', zh: '一个女孩（我改的）', source: 'user' }) !== null &&
    upsertTag(freshTags, { en: '1girl', zh: '机器翻的', source: 'import' }) === null &&
    tagsLookup(freshTags, '1girl')?.zh === '一个女孩（我改的）',
);
check(
  '只改分类时译文和来源都保留（局部更新不该抹掉别的字段）',
  (() => {
    upsertTag(freshTags, { en: '1girl', categories: ['人物'] });
    const entry = tagsLookup(freshTags, '1girl');
    return entry?.zh === '一个女孩（我改的）' && entry?.source === 'user' && entry?.categories[0] === '人物';
  })(),
);
check(
  '老平表（dict.json）读进来：缺分类/别名补空，老 source 归到 import',
  (() => {
    const d = sanitizeTags({ version: 1, entries: { a: { zh: '甲', source: 'api' }, b: { zh: '' }, c: 'nope' } });
    const kept = Object.values(d.entries) as { source?: string; categories?: string[]; aliases?: string[] }[];
    return (
      Object.keys(d.entries).length === 1 &&
      kept[0]?.source === 'import' &&
      kept[0]?.categories?.length === 0 &&
      kept[0]?.aliases?.length === 0
    );
  })(),
);

console.log('别名：输入别名命中正名（导入外部库时用得上）');
const aliasTags = sanitizeTags(null);
upsertTag(aliasTags, { en: 'cinematic lighting', zh: '电影照明', aliases: ['cinematic light', 'movie lighting'], source: 'import' });
upsertTag(aliasTags, { en: 'depth of field', zh: '景深', source: 'import' });
check('别名命中正名', tagsLookup(aliasTags, 'Cinematic Light')?.en === 'cinematic lighting');
check('正名照旧命中', tagsLookup(aliasTags, 'cinematic lighting')?.zh === '电影照明');
check('查不到的返回 null', tagsLookup(aliasTags, 'nope') === null);
check(
  '别名撞上另一个正名时以正名为准',
  (() => {
    upsertTag(aliasTags, { en: 'dof', zh: '景深缩写', source: 'import' });
    upsertTag(aliasTags, { en: 'depth of field', aliases: ['dof'] });
    return tagsLookup(aliasTags, 'dof')?.en === 'dof';
  })(),
);
check('删掉条目后别名不再命中', (() => {
  const t = sanitizeTags(null);
  upsertTag(t, { en: 'best quality', zh: '最好的质量', aliases: ['best'], source: 'import' });
  const before = tagsLookup(t, 'best') !== null;
  const deleted = removeTag(t, 'best quality');
  return before && deleted && tagsLookup(t, 'best') === null && Object.keys(t.entries).length === 0;
})());

console.log('面板查询：搜索 / 分类 / 计数 / 删一条');
const panelTags = sanitizeTags(null);
upsertTag(panelTags, { en: 'masterpiece', zh: '杰作', categories: ['画质'], source: 'user' });
upsertTag(panelTags, { en: 'best quality', zh: '最好的质量', categories: ['画质'], source: 'import' });
upsertTag(panelTags, { en: '1girl', zh: '一个女孩', categories: ['人物'], source: 'import' });
upsertTag(panelTags, { en: 'solo', zh: '单人', source: 'builtin' });
check(
  '计数：总数 + 未分类 + 每个分类几条（**不按来源分** —— 进库就是库）',
  (() => {
    const r = queryTags(panelTags);
    return (
      r.counts.total === 4 &&
      r.counts.uncategorized === 1 &&
      Object.keys(r.counts).sort().join() === 'total,uncategorized' &&
      same(r.categories.map((c) => `${c.name}:${c.count}`), ['画质:2', '人物:1'])
    );
  })(),
);
check('按分类筛', (() => {
  const r = queryTags(panelTags, { category: '画质' });
  return r.total === 2 && same(r.tags.map((t) => t.en).sort(), ['best quality', 'masterpiece']);
})());
check('未分类筛（__none__）', queryTags(panelTags, { category: '__none__' }).tags.map((t) => t.en).join() === 'solo');
check('搜英文 / 搜中文 / 搜别名都行', (() => {
  const byEn = queryTags(panelTags, { q: 'best' }).tags.map((t) => t.en);
  const byZh = queryTags(panelTags, { q: '女孩' }).tags.map((t) => t.en);
  const byAlias = queryTags(aliasTags, { q: 'movie light' }).tags.map((t) => t.en);
  return same(byEn, ['best quality']) && same(byZh, ['1girl']) && same(byAlias, ['cinematic lighting']);
})());
check('limit 生效', queryTags(panelTags, { limit: 2 }).tags.length === 2 && queryTags(panelTags, { limit: 2 }).total === 4);
check(
  '词库里没有"按来源清空"这回事：要清就一条条删（删完别名索引跟着重建）',
  (() => {
    const removed = removeTag(panelTags, 'best quality');
    return removed && tagsLookup(panelTags, 'best quality') === null && Object.keys(panelTags.entries).length === 3;
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

/** server.js 是 JS，返回类型推得比较松；测试里显式收一下形状 */
type Outcome = { text: string; translation: string; source: string };

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
  const tags = sanitizeTags(null);
  upsertTag(tags, { en: 'masterpiece', zh: '杰作', source: 'user' });
  const stub = youdaoStub({});
  const first = await translate(['masterpiece', 'best quality'], { tags, fetchImpl: stub.fetchImpl });
  check('词库命中的不发请求', same(stub.calls, ['youdao|best quality']), JSON.stringify(stub.calls));
  check(
    '结果按入参顺序对齐，来源标清楚（命中=dict / 现翻=api）',
    same((first.results as Outcome[]).map((r: Outcome) => `${r.text}=${r.translation}/${r.source}`), ['masterpiece=杰作/dict', 'best quality=译(best quality)/api']),
    JSON.stringify(first.results),
  );
  check(
    '现翻结果**不写词库**（词库只装人认可的）',
    tagsLookup(tags, 'best quality') === null && Object.hasOwn(tags.entries, 'best quality') === false,
    JSON.stringify(tags.entries),
  );

  const cache = new Map<string, string>();
  const cached = await translate(['best quality'], { tags, apiCache: cache, fetchImpl: stub.fetchImpl });
  check('带会话缓存时第二次零请求，来源仍是"机翻"', stub.calls.length === 2 && cached.results[0]?.source === 'api', JSON.stringify(cached.results));
  const hitAgain = await translate(['best quality'], { tags, apiCache: cache, fetchImpl: stub.fetchImpl });
  check(
    '缓存命中：不再打接口',
    stub.calls.length === 2 && hitAgain.results[0]?.source === 'api' && hitAgain.results[0]?.translation === '译(best quality)',
    JSON.stringify(hitAgain.results),
  );

  const dictHit = await translate(['masterpiece'], { tags, fetchImpl: stub.fetchImpl });
  check('词库命中仍然零请求，且来源透传成 dict（工作区画「库」）', stub.calls.length === 2 && dictHit.results[0]?.source === 'dict');

  const masked = youdaoStub({ masterpiece: '杰作' });
  const weighted = await translate(['(masterpiece:1.2)', '<lora:add_detail:0.8>'], {
    tags: sanitizeTags(null),
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
    tags: sanitizeTags(null),
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
    tags: sanitizeTags(null),
    settings: sanitizeSettings({ minIntervalMs: 6000 }),
    fetchImpl: nextBatch.fetchImpl,
    sleep: spySleep,
  });
  check('节流是全局的：换一批、换一次请求也照样等', waits.length === 1 && (waits[0] ?? 0) > 0, JSON.stringify(waits));

  const noPace = youdaoStub({});
  await translate(['a', 'b'], {
    tags: sanitizeTags(null),
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
    tags: sanitizeTags(null),
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
    tags: sanitizeTags(null),
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
  const broken = await translate(['best quality'], { tags: sanitizeTags(null), fetchImpl: failing.fetchImpl });
  check(
    'provider 报错：结果标 error、错误码带上、词库不动',
    broken.results[0]?.source === 'error' && broken.error?.code === 'PROVIDER',
    JSON.stringify(broken),
  );
  const emptyCode = youdaoStub({}, { errorCode: '50' });
  const refused = await translate(['solo'], { tags: sanitizeTags(null), fetchImpl: emptyCode.fetchImpl });
  check('有道返回非 0 错误码也当失败', refused.results[0]?.source === 'error', JSON.stringify(refused.error));

  const quotaStub = youdaoStub({});
  const usage = { date: '2026-01-01', calls: 2000 };
  const overQuota = await translate(['1girl'], {
    tags: sanitizeTags(null),
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
  await translate(['1girl'], { tags: sanitizeTags(null), settings: sanitizeSettings({ maxCallsPerDay: 2000 }), usage: counted, fetchImpl: okStub.fetchImpl });
  check('成功的调用计入当天用量', okStub.calls.length === 1 && counted.calls === 2000);
  const halfStub = youdaoStub({});
  const half = await translate(['1girl', 'solo'], {
    tags: sanitizeTags(null),
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

console.log(failed === 0 ? '\n✅ 契约测试通过' : `\n❌ ${failed} 项不通过`);process.exit(failed === 0 ? 0 : 1);
