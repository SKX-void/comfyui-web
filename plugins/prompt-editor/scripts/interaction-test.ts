/**
 * 交互测试 —— 补上契约测试（SSR）够不到的那一半：真 DOM 里挂载、真事件、真点击。
 *
 * 为什么必须有这一层：SSR 不跑事件处理器，所以"敲字进不去""点开关没反应"这类问题
 * 它一个都抓不到（线上连着踩过两次：`crypto.randomUUID` 和输入法回车吞字）。
 *
 * 用 happy-dom 造 DOM，把产出的 `client.js` 挂上去（和外壳一样的消费方式）。
 * 这里专门锁两件事：
 *   1. 普通敲字 + 回车 / 点「＋」→ 条目进块、输出区跟着变；
 *   2. **输入法组字**：v-model 在组字期间不更新（Vue 的 vModelText 里 `if (e.target.composing) return`），
 *      而中文输入法敲回车就是提交组字那一下，keydown 早于 compositionend ——
 *      处理器若只读 v-model 的 ref，用户敲的字会被整段吞掉。
 *
 * 用法：node plugins/prompt-editor/scripts/interaction-test.ts
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Window } from 'happy-dom';

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : '  → ' + String(detail)));
  if (!ok) failed += 1;
}

// ── 1. 造 DOM 并把全局装好：必须早于 import vue / 产物 ───────────────────────
const window = new Window({ url: 'http://localhost/w/prompt-editor' });

const names = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'SVGElement',
  'MathMLElement',
  'Document',
  'ShadowRoot',
  'Text',
  'Comment',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;
for (const name of names) {
  // Node 里 navigator 之类是只读 getter，只能 defineProperty 覆盖
  Object.defineProperty(globalThis, name, {
    value: (window as unknown as Record<string, unknown>)[name],
    configurable: true,
    writable: true,
  });
}
/**
 * 记录所有请求：草稿"两种写事件"的分派只能从**发出去的请求**上看出来，
 * 光看 DOM 是看不出"只发了那一个组的条目"的。
 */
interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];

/**
 * 假的翻译后端：只认一份"词库"，其余现翻 —— 这样"词库命中/现翻/失败"三种来路
 * 在交互层都能断言，而且**不打真网**（真实 provider 的行为在契约层已经测过）。
 */
type FakeTag = { en: string; zh: string; categories: string[]; aliases: string[]; source: string; updatedAt: number };
/**
 * 假词库。**刻意不放工作区里出现过的词**（8k / solo / 1girl…）：那几条的断言依赖
 * "没命中词库 → 现翻"，混进来会把"逐条发几条请求"这类断言弄脏。
 */
const tagSeed = (): Record<string, FakeTag> => ({
  masterpiece: { en: 'masterpiece', zh: '杰作', categories: ['画质'], aliases: [], source: 'import', updatedAt: 1 },
  'cinematic lighting': { en: 'cinematic lighting', zh: '电影照明', categories: ['光照'], aliases: ['cinematic light'], source: 'user', updatedAt: 2 },
  'depth of field': { en: 'depth of field', zh: '景深', categories: ['光照'], aliases: [], source: 'import', updatedAt: 3 },
  'ultra detailed': { en: 'ultra detailed', zh: '超详细的', categories: [], aliases: [], source: 'builtin', updatedAt: 4 },
});
const fakeTags: Record<string, FakeTag> = tagSeed();
/**
 * 把假词库恢复成种子状态。前面的小节会**真的**往里写（手改译文、点「机」都走 PUT /tags/entry，
 * 那是真实行为），所以需要"某条命中时来源是什么"的断言之前要重置一次 —— 否则
 * masterpiece 会被前面的手改写成 user，后面"词库命中的标「库」"就说不清了。
 */
function resetFakeTags(): void {
  for (const key of Object.keys(fakeTags)) delete fakeTags[key];
  Object.assign(fakeTags, tagSeed());
}
let tagStamp = 100;

/** 假的 GET /tags：形状与 server.js 的 queryTags 一致 */
function fakeTagList(q: string, category: string): unknown {
  const needle = q.trim().toLowerCase();
  const all = Object.values(fakeTags);
  const counts = { total: all.length, uncategorized: 0 };
  const byCategory = new Map<string, number>();
  for (const entry of all) {
    if (entry.categories.length === 0) counts.uncategorized += 1;
    for (const name of entry.categories) byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
  }
  const tags = all.filter((entry) => {
    if (category === '__none__') {
      if (entry.categories.length !== 0) return false;
    } else if (category !== '' && !entry.categories.includes(category)) {
      return false;
    }
    if (needle === '') return true;
    return (
      entry.en.toLowerCase().includes(needle) ||
      entry.zh.includes(needle) ||
      entry.aliases.some((alias) => alias.toLowerCase().includes(needle))
    );
  });
  tags.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    tags: tags.map((entry) => ({ key: entry.en, ...entry })),
    total: tags.length,
    counts,
    categories: [...byCategory.entries()].map(([name, count]) => ({ name, count })),
  };
}
let translateFails = false;
const translateBatches: string[][] = [];

Object.defineProperty(globalThis, 'fetch', {
  value: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const path = String(url);
    const body = init?.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ method, url: path, body });
    const reply = (payload: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

    if (method === 'GET' && path.endsWith('/settings')) {
      return reply({
        settings: { provider: 'youdao-demo', autoTranslate: false, maxCallsPerDay: 2000, timeoutMs: 8000 },
        usage: { date: '2026-01-01', calls: 7 },
        tagCount: Object.keys(fakeTags).length,
        providers: [{ id: 'youdao-demo', label: '有道体验版（免费、无需 key）', fields: [] }],
      });
    }
    if (method === 'PUT' && path.endsWith('/settings')) {
      return reply({ settings: body?.settings ?? {} });
    }
    if (method === 'POST' && path.endsWith('/translate')) {
      const texts = (body?.texts ?? []) as string[];
      translateBatches.push(texts);
      if (translateFails) {
        return reply({
          results: texts.map((text) => ({ text, translation: '', source: 'error' })),
          error: { code: 'PROVIDER', message: '假装翻译服务挂了' },
        });
      }
      return reply({
        results: texts.map((text) => {
          const hit = fakeTags[text];
          if (hit === undefined) return { text, translation: `译(${text})`, source: 'api' };
          return { text, translation: hit.zh, source: 'dict' };
        }),
      });
    }
    if (method === 'GET' && path.includes('/tags')) {
      const url = new URL(path, 'http://localhost');
      return reply(fakeTagList(url.searchParams.get('q') ?? '', url.searchParams.get('category') ?? ''));
    }
    if (method === 'PUT' && path.endsWith('/tags/entry')) {
      const en = String(body?.en ?? '');
      const current = fakeTags[en];
      fakeTags[en] = {
        en,
        zh: typeof body?.zh === 'string' && body.zh !== '' ? body.zh : (current?.zh ?? ''),
        categories: Array.isArray(body?.categories) ? (body.categories as string[]) : (current?.categories ?? []),
        aliases: Array.isArray(body?.aliases) ? (body.aliases as string[]) : (current?.aliases ?? []),
        source: typeof body?.source === 'string' ? body.source : (current?.source ?? 'user'),
        updatedAt: (tagStamp += 1),
      };
      return reply({ ok: true, entry: fakeTags[en] });
    }
    if (method === 'DELETE' && path.endsWith('/tags/entry')) {
      const en = String(body?.en ?? '');
      const had = fakeTags[en] !== undefined;
      delete fakeTags[en];
      return reply({ ok: true, deleted: had });
    }
    return reply({ doc: null });
  },
  configurable: true,
  writable: true,
});

// ── 2. 挂载产物（和契约测试同一套：裸 `import 'vue'` 自己挂钩子） ────────────
const { register } = await import('node:module');
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

const tabDir = process.env.TAB_OUT_DIR ?? fileURLToPath(new URL('../../../tabs/prompt-editor/', import.meta.url));
const plugin = (await import(pathToFileURL(path.join(tabDir, 'client.js')).href)).default as {
  routes?: { component: unknown }[];
};

const { createApp, nextTick } = await import('vue');
const host = document.createElement('div');
document.body.appendChild(host);
createApp(plugin.routes?.[0]?.component as never).mount(host);
await nextTick();

const pick = <T extends Element>(selector: string): T | null => host.querySelector(selector) as T | null;
const pickAll = <T extends Element>(selector: string): T[] => [...host.querySelectorAll(selector)] as T[];
const output = (): string => pick('pre.pe-output-text')?.textContent?.trim() ?? '';
/** 条目文本列表。**注意：某条正在编辑时它的 .pe-chip-text 会被输入框顶掉**，
 * 这时读到的第 n 个不是第 n 条 —— 要按序号取文本，就在点击进编辑态之前取。 */
const chips = (blockIndex: number): string[] =>
  // 只取上格（原文）：下格译文也是 .pe-chip-text，别混进来
  [...(pickAll('.pe-block')[blockIndex]?.querySelectorAll('.pe-chip > .pe-chip-text') ?? [])].map(
    (el) => el.textContent?.trim() ?? '',
  );
const blockOf = (index: number): HTMLElement => pickAll('.pe-block')[index] as HTMLElement;
/** 第 blockIndex 块、第 chipIndex 条的**译文格**里现在显示什么（编辑中是输入框，这里不取） */
const cellText = (blockIndex: number, chipIndex: number): string =>
  (blockOf(blockIndex).querySelectorAll('.pe-chip-translation .pe-chip-text')[chipIndex]?.textContent ?? '').trim();
const sameTexts = (a: string[], b: string[]): boolean => a.length === b.length && a.every((text, i) => text === b[i]);
/** 第 blockIndex 块、第 chipIndex 条译文格右上角的来源标记：我 / 库 / 机 / ''（无） */
const markText = (blockIndex: number, chipIndex: number): string =>
  (
    blockOf(blockIndex).querySelectorAll('.pe-chip-translation')[chipIndex]?.querySelector('.pe-chip-src')?.textContent ?? ''
  ).trim();
const noticeText = (): string => (pick('.pe-notice')?.textContent ?? '').trim();
/** 等异步链路（fetch stub → text() → JSON.parse → 状态更新 → 渲染）走完 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

/** 从第 `from` 条请求之后，实际发出去的写请求 */
const writesSince = (from: number): Call[] => calls.slice(from).filter((call) => call.method === 'PUT');
const ITEMS_URL = /^\/api\/p\/prompt-editor\/draft\/blocks\/[^/]+\/items$/;
const STRUCTURE_URL = '/api/p/prompt-editor/draft/structure';

/** happy-dom 的事件类与 DOM lib 的 `Event` 不是同一套声明（运行期是一回事），这里只为过 TS */
const dispatch = (target: Element, event: unknown): void => {
  target.dispatchEvent(event as Event);
};

/** 普通敲字：浏览器会同时改 value 并发 input 事件（v-model 就是听它） */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  input.value = text;
  dispatch(input, new window.Event('input', { bubbles: true }));
  await nextTick();
}

/** 失焦（点走 / 切到别的框时浏览器发的就是它） */
async function blur(input: HTMLInputElement): Promise<void> {
  dispatch(input, new window.Event('blur'));
  await nextTick();
}

/** 敲回车（组字期间浏览器发的就是这种 keydown：isComposing = true） */
async function pressEnter(input: HTMLInputElement, composing = false): Promise<void> {
  dispatch(
    input,
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: composing }),
  );
  await nextTick();
}

// ── 3. 断言 ─────────────────────────────────────────────────────────────────
console.log('挂载');
check('挂载出插件根元素', pick('.pe-app') !== null);
check('首屏三个区块各带风格开关', pickAll('.pe-block-modes').length === 3);
// onMounted 里先 await 草稿、再取设置：等两轮都发出去再断言
await settle();
check(
  '装载阶段不写回（只有 /draft 和 /settings 两次 GET）',
  calls.every((call) => call.method === 'GET') &&
    calls.length === 2 &&
    calls.some((call) => call.url.endsWith('/draft') === true) &&
    calls.some((call) => call.url.endsWith('/settings') === true),
  JSON.stringify(calls),
);

console.log('普通敲字（ASCII）');
const add0 = blockOf(0).querySelector('.pe-add') as HTMLInputElement;
await type(add0, 'masterpiece');
await pressEnter(add0);
check('回车后条目进块', chips(0).join('|') === 'masterpiece', chips(0).join('|'));
check('输出区跟着出来（tag 块末尾自动补了英文逗号）', output() === 'masterpiece,', JSON.stringify(output()));
check('输入框已清空', add0.value === '', JSON.stringify(add0.value));

await type(add0, 'best quality, 8k');
await pressEnter(add0);
check('一次粘一串按逗号切成多条', chips(0).join('|') === 'masterpiece|best quality|8k', chips(0).join('|'));
check('输出用逗号连接', output() === 'masterpiece, best quality, 8k,', JSON.stringify(output()));

console.log('失焦即提交（不用记着按回车）');
const add1 = blockOf(1).querySelector('.pe-add') as HTMLInputElement;
await type(add1, '1girl');
await blur(add1);
check('失焦后条目进块', chips(1).join('|') === '1girl', chips(1).join('|'));
check('失焦提交后输入框清空', add1.value === '', JSON.stringify(add1.value));

// 光标移到别处（在同一个框里接着写）也算失焦，不该丢字
await type(add1, 'solo');
await blur(add1);
check('再写一条、失焦照样进去', chips(1).join('|') === '1girl|solo', chips(1).join('|'));

console.log('输入法组字：敲回车提交组字，但 v-model 还没同步');
// 关键复现：只改 DOM 的 value（组字期间 v-model 被 composing 挡住，ref 里还是空串），再敲回车。
// 处理器若只读 ref，这里就会把用户敲的字整段吞掉。
const add2 = blockOf(2).querySelector('.pe-add') as HTMLInputElement;
add2.value = '一只猫, 银发';
await pressEnter(add2, true);
check('组字状态下敲回车不吞字', chips(2).join('|') === '一只猫|银发', chips(2).join('|'));
check('输出里也有它', output().includes('一只猫, 银发'), JSON.stringify(output()));
check('组字提交后输入框也清空了', add2.value === '', JSON.stringify(add2.value));

console.log('组字状态下失焦（点走）也不能丢字');
const add2b = blockOf(2).querySelector('.pe-add') as HTMLInputElement;
add2b.value = '长发, 呆毛';
await blur(add2b);
check('组字 + 失焦不吞字', chips(2).join('|') === '一只猫|银发|长发|呆毛', chips(2).join('|'));

console.log('区块自己的风格开关：整块当一份内容重切');
// 第 3 块现在是 tag 风格（4 条）；切成自然语言 —— 块内**已有的**条目要被真的重切一遍
const before = chips(0).length;
(blockOf(2).querySelectorAll('.pe-block-modes button')[1] as HTMLButtonElement).click();
await nextTick();
check('切到自然语言：整块合成一条', chips(2).join('|') === '一只猫, 银发, 长发, 呆毛', chips(2).join('|'));
check('别的块不受影响', chips(0).length === before && chips(0).length === 3, chips(0).join('|'));
// 工作区排版：自然语言块竖排（每句一行），tag 块照旧横着排成 tag 流
check('自然语言块在工作区也竖排（每句一行）', blockOf(2).querySelector('.pe-block-body-text') !== null);
check('tag 块保持横排的 tag 流', blockOf(0).querySelector('.pe-block-body-text') === null);
check(
  '输出跟着变（这一段成了一条）',
  output() === 'masterpiece, best quality, 8k,\n1girl, solo,\n一只猫, 银发, 长发, 呆毛',
  JSON.stringify(output()),
);

// 自然语言下再写两句：按句号切成两条，**每句一行**
const add2c = blockOf(2).querySelector('.pe-add') as HTMLInputElement;
await type(add2c, 'a cat sits. a dog runs.');
await blur(add2c);
check('自然语言下按句号切', chips(2).join('|') === '一只猫, 银发, 长发, 呆毛|a cat sits.|a dog runs.', chips(2).join('|'));
check(
  '自然语言块每句一行',
  output().endsWith('一只猫, 银发, 长发, 呆毛\na cat sits.\na dog runs.'),
  JSON.stringify(output()),
);

// 切回 tag：整块按逗号重切 —— 前面那几条 tag 原样回来，末尾那句没逗号所以并成一条
(blockOf(2).querySelectorAll('.pe-block-modes button')[0] as HTMLButtonElement).click();
await nextTick();
check(
  '切回 tag：整块按逗号重切（往返把 tag 还回来）',
  chips(2).join('|') === '一只猫|银发|长发|呆毛 a cat sits. a dog runs.',
  chips(2).join('|'),
);
check('切回 tag 后工作区排版也跟着回到横排', blockOf(2).querySelector('.pe-block-body-text') === null);
check(
  '切回 tag 后这一段又串成一行',
  output() === 'masterpiece, best quality, 8k,\n1girl, solo,\n一只猫, 银发, 长发, 呆毛 a cat sits. a dog runs.,',
  JSON.stringify(output()),
);
const oneLine = output();

// 再切回自然语言：这次按句号重切成两条 —— 切法和排版都变了，词句本身没变
(blockOf(2).querySelectorAll('.pe-block-modes button')[1] as HTMLButtonElement).click();
await nextTick();
check(
  '再切回自然语言：按句号重切成两条',
  chips(2).join('|') === '一只猫, 银发, 长发, 呆毛 a cat sits.|a dog runs.',
  chips(2).join('|'),
);
check(
  '自然语言：这一段的每句各占一行',
  output() === 'masterpiece, best quality, 8k,\n1girl, solo,\n一只猫, 银发, 长发, 呆毛 a cat sits.\na dog runs.',
  JSON.stringify(output()),
);
check(
  '换风格只换排版（空格 ↔ 换行）和切法，词句本身不变',
  // 末尾那个自动补的逗号也算排版：比较前两边都抹掉
  output().replace(/\s+/g, ' ').replace(/,\s*$/, '') === oneLine.replace(/\s+/g, ' ').replace(/,\s*$/, ''),
  JSON.stringify([oneLine, output()]),
);

console.log('译文格：和原文上下两个小格，可编辑、不掺进输出');
check(
  '每个条目都带一个译文格（上下两格）',
  blockOf(0).querySelectorAll('.pe-chip').length === blockOf(0).querySelectorAll('.pe-chip-translation').length &&
    blockOf(0).querySelectorAll('.pe-chip-translation').length === 3,
);
const trans0 = blockOf(0).querySelector('.pe-chip-translation') as HTMLElement;
check('空译文格显示占位', trans0.textContent?.includes('译文') === true, trans0.textContent);
trans0.click();
await nextTick();
const transInput = blockOf(0).querySelector('.pe-chip-translation .pe-chip-input') as HTMLInputElement | null;
check('单击译文格出现输入框', transInput !== null);
if (transInput !== null) {
  await type(transInput, '杰作');
  await blur(transInput);
  check('失焦后译文留在格子里', (blockOf(0).querySelector('.pe-chip-translation') as HTMLElement).textContent?.includes('杰作') === true);
}
check('译文不进输出', !output().includes('杰作'), JSON.stringify(output()));

// 组字 + 失焦：译文格也走"读 DOM 实时值"那条路
const trans2 = blockOf(2).querySelectorAll('.pe-chip-translation')[0] as HTMLElement;
trans2.click();
await nextTick();
const trans2Input = blockOf(2).querySelector('.pe-chip-translation .pe-chip-input') as HTMLInputElement | null;
if (trans2Input !== null) {
  trans2Input.value = '一只猫';
  await blur(trans2Input);
  check('译文格组字失焦也不吞字', (blockOf(2).querySelector('.pe-chip-translation') as HTMLElement).textContent?.includes('一只猫') === true);
}

console.log('点条目改名');
const chip0 = blockOf(0).querySelector('.pe-chip') as HTMLElement;
chip0.click();
await nextTick();
const rename = blockOf(0).querySelector('.pe-chip .pe-chip-input') as HTMLInputElement | null;
check('单击条目出现改名输入框', rename !== null);
if (rename !== null) {
  await type(rename, 'masterpiece v2');
  await blur(rename);
  check('失焦提交改名', chips(0)[0] === 'masterpiece v2', chips(0)[0]);
}

console.log('双击禁用：条目留在块里但不进输出');
dispatch(blockOf(0).querySelectorAll('.pe-chip')[1] as HTMLElement, new window.MouseEvent('dblclick', { bubbles: true }));
await nextTick();
check('禁用态挂在条目上', blockOf(0).querySelectorAll('.pe-chip-off').length === 1);
check('被禁用的条目不出现在输出里', !output().includes('best quality'), JSON.stringify(output()));

console.log('草稿：编辑热路径上只有两种写事件');
{
  // 事件 2：某个组编辑完了 —— 只发那个组的条目，别的组一个字都不带
  const add1 = blockOf(1).querySelector('.pe-add') as HTMLInputElement;
  const mark = calls.length;
  await type(add1, '只属于第一块的新条目');
  await blur(add1);
  const sent = writesSince(mark);
  check('编辑一个 tag 只发一次写', sent.length === 1, JSON.stringify(sent.map((c) => c.url)));
  check('发的是"这个组的条目"那个端点', ITEMS_URL.test(sent[0]?.url ?? ''), sent[0]?.url);
  const body = JSON.stringify(sent[0]?.body ?? null);
  check('请求体里只有这个组的条目', body.includes('只属于第一块的新条目') && !body.includes('masterpiece'), body.slice(0, 120));
  check('请求体里没有结构（没有 blocks 字段）', sent[0]?.body?.blocks === undefined);

  // 事件 1：组属性变了 —— 只发结构，一个条目都不带
  const title = blockOf(0).querySelector('.pe-block-title') as HTMLInputElement;
  const mark2 = calls.length;
  title.value = '质量 v2';
  dispatch(title, new window.Event('input', { bubbles: true }));
  dispatch(title, new window.Event('change', { bubbles: true }));
  await nextTick();
  const sent2 = writesSince(mark2);
  check('改标题只发一次写', sent2.length === 1, JSON.stringify(sent2.map((c) => c.url)));
  check('发的是"组结构"那个端点', sent2[0]?.url === STRUCTURE_URL, sent2[0]?.url);
  const blocks = (sent2[0]?.body?.blocks ?? []) as Record<string, unknown>[];
  check('结构里带着新标题', blocks[0]?.title === '质量 v2', JSON.stringify(blocks[0]));
  check('结构只跟区块数有关（3 条，且每条都不含 items）', blocks.length === 3 && blocks.every((b) => b.items === undefined));

  // 换风格：属性（mode）和条目（重切）都变了 —— 两个事件都得发
  const mark3 = calls.length;
  (blockOf(2).querySelectorAll('.pe-block-modes button')[0] as HTMLButtonElement).click();
  await nextTick();
  const sent3 = writesSince(mark3).map((call) => call.url);
  check(
    '换风格同时发结构和该组条目',
    sent3.length === 2 && sent3.includes(STRUCTURE_URL) && sent3.some((url) => ITEMS_URL.test(url)),
    JSON.stringify(sent3),
  );
}

// ── 翻译：手动「译」立即发、自动译防抖合并、手改写回词库 ──────────────────────
//
// 假的翻译后端（见上面 fetch stub）认一份词库：masterpiece → 杰作，其余现翻成 `译(x)`。
// 设置里的 autoTranslate 初始是 false（前面那些用例不该被翻译请求打扰），这一段先从
// 设置面板把它打开 —— 顺带把设置面板本身走一遍。

console.log('翻译设置面板');
const headerButtons = pickAll('.pe-actions button') as HTMLButtonElement[];
const translateBtn = headerButtons.find((button) => button.textContent?.includes('翻译')) as HTMLButtonElement;
check('表头有「翻译…」入口', translateBtn !== undefined);
translateBtn.click();
await settle();
const panel = pick('.pe-panel') as HTMLElement | null;
check('面板打开并读到设置', panel !== null && panel.textContent?.includes('有道体验版') === true, panel?.textContent?.slice(0, 60));
check(
  '面板显示今天用量和词库条数',
  panel?.textContent?.includes('今天已调用 7 次') === true &&
    panel?.textContent?.includes(`词库 ${Object.keys(fakeTags).length} 条`) === true,
);

const autoBox = pick('.pe-panel input[type="checkbox"]') as HTMLInputElement | null;
check('自动译默认是关的（来自设置）', autoBox !== null && autoBox.checked === false);
if (autoBox !== null) {
  autoBox.checked = true;
  dispatch(autoBox, new window.Event('change'));
  await nextTick();
}
const saveBtn = (pickAll('.pe-panel .pe-actions button') as HTMLButtonElement[])[0] as HTMLButtonElement;
const markSettings = calls.length;
saveBtn.click();
await settle();
const saved = calls.slice(markSettings).filter((call) => call.method === 'PUT' && call.url.endsWith('/settings'));
check(
  '保存设置发一次 PUT /settings，且带上了新开关',
  saved.length === 1 && (saved[0]?.body as { settings?: { autoTranslate?: boolean } })?.settings?.autoTranslate === true,
  JSON.stringify(saved[0]?.body),
);
(pick('.pe-panel .pe-close') as HTMLButtonElement).click();
await nextTick();
check('面板能关掉', pick('.pe-panel') === null);

console.log('自动译：失焦后自动填译文，逐条发（队列合并成一次"排空"）');
// 前面「译文格」那节手改过译文（按设计会写进词库），这里从种子词库重新开始
resetFakeTags();
const add3 = blockOf(0).querySelector('.pe-add') as HTMLInputElement;
const batchesBefore = translateBatches.length;
const countBefore = chips(0).length;
await type(add3, 'masterpiece, solo');
await blur(add3);
check('条目立刻进块', chips(0).length === countBefore + 2 && chips(0).slice(-2).join('|') === 'masterpiece|solo', chips(0).join('|'));
check('译文格还没被填（没到防抖时间）', cellText(0, countBefore) === '译文' && cellText(0, countBefore + 1) === '译文', cellText(0, countBefore));
check('这一刻还没发翻译请求', translateBatches.length === batchesBefore);

await new Promise((resolve) => setTimeout(resolve, 500));
await nextTick();
check('防抖过后自动填上译文（词库命中的用词库）', cellText(0, countBefore) === '杰作' && cellText(0, countBefore + 1) === '译(solo)', JSON.stringify([cellText(0, countBefore), cellText(0, countBefore + 1)]));
const autoBatches = translateBatches.slice(batchesBefore);
check(
  '逐条发：这块里还没译文的一人一个请求（新条目 + 此前没译文的旧条目）',
  autoBatches.length >= 2 && autoBatches.every((batch) => batch.length === 1),
  JSON.stringify(autoBatches),
);
check(
  '顺序按块内条目顺序走',
  sameTexts(autoBatches.map((batch) => batch[0] ?? ''), ['masterpiece v2', 'best quality', '8k', 'masterpiece', 'solo']),
  JSON.stringify(autoBatches),
);
check('自动译的译文也落盘（该组条目被写了一次）', writesSince(markSettings).some((call) => ITEMS_URL.test(call.url)) === true);

console.log('自动译不覆盖已有译文、也不重发');
const batchesBefore2 = translateBatches.length;
await type(add3, 'masterpiece');
await blur(add3);
await new Promise((resolve) => setTimeout(resolve, 500));
await nextTick();
check(
  '只有"还没有译文"的那一条进队列（有译文的连请求都不发）',
  sameTexts(translateBatches.slice(batchesBefore2).flat(), ['masterpiece']),
  JSON.stringify(translateBatches.slice(batchesBefore2)),
);
check('新条目拿到词库里的译文', cellText(0, chips(0).length - 1) === '杰作', cellText(0, chips(0).length - 1));

console.log('单条「译」：点了立刻发，不等防抖');
const markManual = calls.length;
(pickAll('.pe-chip-translation .pe-chip-btn')[2] as HTMLButtonElement).click();
await settle();
check(
  '单条「译」立刻发一次请求',
  calls.slice(markManual).filter((call) => call.method === 'POST' && call.url.endsWith('/translate')).length === 1,
  JSON.stringify(calls.slice(markManual).map((call) => call.url)),
);

console.log('整块「译」：逐条发、已有译文的与禁用的一条都不发');
// 用第二块测：它还没有译文（自动译是按块排队的，前面只排空过第一块）
const block1Chips = chips(1).length;
dispatch(blockOf(1).querySelectorAll('.pe-chip')[1] as HTMLElement, new window.MouseEvent('dblclick', { bubbles: true }));
await nextTick();
check('前置条件：第二块有一条被禁用', blockOf(1).querySelectorAll('.pe-chip-off').length === 1);
const markBlock = translateBatches.length;
(pickAll('.pe-block-tr')[1] as HTMLButtonElement).click();
await settle(30);
const blockBatches = translateBatches.slice(markBlock);
check(
  '整块「译」也是逐条发（禁用的不进）',
  blockBatches.length === block1Chips - 1 && blockBatches.every((batch) => batch.length === 1),
  JSON.stringify(blockBatches),
);
check('第二块的译文填上了', cellText(1, 0) !== '译文' && cellText(1, 0) !== '', cellText(1, 0));

const beforeAllTranslated = translateBatches.length;
(pickAll('.pe-block-tr')[1] as HTMLButtonElement).click();
await settle(30);
check('都有译文了：一个请求都不发（提示而不是重翻）', translateBatches.length === beforeAllTranslated, JSON.stringify(translateBatches.slice(beforeAllTranslated)));

console.log('手改译文写回词库');
const markDict = calls.length;
const cell1 = blockOf(0).querySelectorAll('.pe-chip-translation')[1] as HTMLElement;
cell1.click();
await nextTick();
const cell1Input = blockOf(0).querySelector('.pe-chip-translation .pe-chip-input') as HTMLInputElement | null;
check('译文格能就地编辑', cell1Input !== null);
if (cell1Input !== null) {
  await type(cell1Input, '我改的译文');
  await blur(cell1Input);
  await settle();
  const dictCalls = calls.slice(markDict).filter((call) => call.method === 'PUT' && call.url.endsWith('/tags/entry'));
  check(
    '手改的译文写回词库（PUT /tags/entry，显式标成"我认可的"）',
    dictCalls.length === 1 &&
      (dictCalls[0]?.body as { zh?: string; source?: string })?.zh === '我改的译文' &&
      (dictCalls[0]?.body as { source?: string })?.source === 'user',
    JSON.stringify(dictCalls[0]?.body),
  );
  check('格子显示改后的译文', cellText(0, 1) === '我改的译文', cellText(0, 1));
}

console.log('译文标记：在不在词库里（库 / 机）');
check('词库命中的标「库」', markText(0, 3) === '库', markText(0, 3));
check('机器现翻的标「机」', markText(0, 4) === '机', markText(0, 4));
check('手改过的标「库」（手改 = 已经进库了）', markText(0, 1) === '库', markText(0, 1));
check('没译文的条目不画标记', markText(0, 0) === '机' && markText(1, 1) === '', `${markText(0, 0)} / ${markText(1, 1)}`);

console.log('点「机」= 把这条机器译文存进词库');
const markPromote = calls.length;
const apiCell = blockOf(0).querySelectorAll('.pe-chip-translation')[4] as HTMLElement;
(apiCell.querySelector('.pe-chip-src') as HTMLElement).click();
await settle();
const promoteCalls = calls.slice(markPromote).filter((call) => call.method === 'PUT' && call.url.endsWith('/tags/entry'));
check(
  '点了就发一次 PUT /tags/entry（内容就是这条译文，标成"我认可的"）',
  promoteCalls.length === 1 &&
    (promoteCalls[0]?.body as { en?: string })?.en === 'solo' &&
    (promoteCalls[0]?.body as { source?: string })?.source === 'user',
  JSON.stringify(promoteCalls[0]?.body),
);
check('存进库之后标「库」（进库了就不再是"现翻的"）', markText(0, 4) === '库', markText(0, 4));
check(
  '存过之后不再显示成"可点"（免得以为还能再存一次）',
  (apiCell.querySelector('.pe-chip-src') as HTMLElement).className.includes('pe-chip-src-clickable') === false,
  (apiCell.querySelector('.pe-chip-src') as HTMLElement).className,
);
check('提示说存进词库了', noticeText().includes('已存进词库') === true, noticeText());
check('点「机」不会顺手改译文', cellText(0, 4) === '译(solo)', cellText(0, 4));

console.log('改名：旧译文不跟着新文本留下');
const renameIdx = 1; // 这条此刻的译文是「我改的译文」
const renameChip = blockOf(0).querySelectorAll('.pe-chip')[renameIdx] as HTMLElement;
renameChip.click();
await nextTick();
const renameInput = blockOf(0).querySelector('.pe-chip .pe-chip-input') as HTMLInputElement | null;
check('改名输入框出现', renameInput !== null);
if (renameInput !== null) {
  await type(renameInput, 'best quality v2');
  await blur(renameInput);
  check('改名后旧译文立刻清掉（它对应的是旧文本）', cellText(0, renameIdx) === '译文', cellText(0, renameIdx));
  check('来源标记也跟着没了', markText(0, renameIdx) === '', markText(0, renameIdx));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await nextTick();
  check('自动译随后补上新文本的译文', cellText(0, renameIdx) === '译(best quality v2)', cellText(0, renameIdx));
}

console.log('往后追一句：第一段文本没变，译文该留着');
const appendIdx = 0; // masterpiece v2 → 杰作
check('前置条件：这条有译文', cellText(0, appendIdx) !== '译文', cellText(0, appendIdx));
const appendChip = blockOf(0).querySelectorAll('.pe-chip')[appendIdx] as HTMLElement;
const appendText = chips(0)[appendIdx] ?? ''; // 必须在点击前取：进编辑态后这条的 .pe-chip-text 就没了
appendChip.click();
await nextTick();
const appendInput = blockOf(0).querySelector('.pe-chip .pe-chip-input') as HTMLInputElement | null;
if (appendInput !== null) {
  const kept = cellText(0, appendIdx);
  await type(appendInput, `${appendText}, extra tail`);
  await blur(appendInput);
  check('切出两段后，第一段的译文还在', cellText(0, appendIdx) === kept, `${kept} → ${cellText(0, appendIdx)}`);
}

console.log('翻译服务挂了：格子上留记号，写作不受影响');
translateFails = true;
const markFail = calls.length;
await type(add3, 'brand new tag');
await blur(add3);
await new Promise((resolve) => setTimeout(resolve, 500));
await nextTick();
const failedCell = blockOf(0).querySelectorAll('.pe-chip-translation')[chips(0).length - 1] as HTMLElement | undefined;
check('没翻成的格子挂上失败记号', failedCell?.className.includes('pe-chip-translation-failed') === true, failedCell?.className);
check('失败了也照样落盘（条目本身是好的）', writesSince(markFail).some((call) => ITEMS_URL.test(call.url)) === true);
check('失败不影响输出区', output().includes('brand new tag') === true, JSON.stringify(output()));
translateFails = false;

console.log('词库面板：看 / 搜 / 分类 / 插入 / 改译文 / 改分类 / 删');
// 前面几节的手改 / 点「机」都真的写进了这份假词库（这就是真实行为），面板这节从一份干净的词库开始
resetFakeTags();
const libRow = (en: string): HTMLElement | undefined =>
  pickAll<HTMLElement>('.pe-lib-row').find((row) => row.querySelector('.pe-lib-en')?.textContent?.trim() === en);
const libNames = (): string[] => pickAll('.pe-lib-en').map((el) => el.textContent?.trim() ?? '');
const catLabels = (): string[] =>
  pickAll('.pe-lib-cats button').map((el) => (el.textContent ?? '').trim().split(/\s+/)[0] ?? '');
/** 面板里的异步：搜索有 250ms 防抖，拉列表 + 渲染还要几轮 */
const settleLib = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 320));
  await settle(12);
};

// 先点一下第一块：词库面板「插入到」默认跟着"最后碰过的块"
dispatch(blockOf(0), new window.MouseEvent('click', { bubbles: true }));
await nextTick();
const markLib = calls.length;
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
check(
  '打开面板拉一次词库列表',
  calls.slice(markLib).some((call) => call.method === 'GET' && call.url.includes('/tags')) === true,
  JSON.stringify(calls.slice(markLib).map((call) => call.url)),
);
check('条目都画出来了', libNames().length === 4, libNames().join('|'));
check('顶上写明总数与未分类条数', pick('.pe-lib-stat')?.textContent?.includes('共 4 条') === true && pick('.pe-lib-stat')?.textContent?.includes('未分类 1') === true, pick('.pe-lib-stat')?.textContent);
check('分类树：全部 / 未分类 / 已有分类（按写作分类列）', catLabels().join('|') === '全部|未分类|画质|光照', catLabels().join('|'));
check(
  '库里的条目一律标「库」（不按来源分 —— 进库就是库）',
  pickAll('.pe-lib-src').length === 4 && pickAll('.pe-lib-src').every((el) => el.textContent?.trim() === '库') === true,
  pickAll('.pe-lib-src').map((el) => el.textContent?.trim()).join('|'),
);
check('别名显示在条目上', libRow('cinematic lighting')?.textContent?.includes('cinematic light') === true);

console.log('词库面板：搜索（防抖后发请求，英文/中文/别名都搜）');
const searchBox = pick('.pe-lib-bar .pe-input') as HTMLInputElement;
await type(searchBox, '电影');
await settleLib();
check('搜中文能搜到', libNames().join() === 'cinematic lighting', libNames().join('|'));
check(
  '请求带上了 q',
  calls.slice(markLib).some((call) => call.url.includes(`q=${encodeURIComponent('电影')}`)) === true,
  JSON.stringify(calls.slice(markLib).map((call) => call.url)),
);
await type(searchBox, 'cinematic light');
await settleLib();
check('搜别名也能搜到正名', libNames().join() === 'cinematic lighting', libNames().join('|'));
await type(searchBox, '');
await settleLib();
check('清空搜索恢复全部', libNames().length === 4, libNames().join('|'));

console.log('词库面板：按分类筛');
(pickAll('.pe-lib-cats button')[3] as HTMLButtonElement).click();
await settleLib();
check('点「光照」只剩那两条', libNames().sort().join('|') === 'cinematic lighting|depth of field', libNames().join('|'));
check('分类树高亮当前分类', pickAll('.pe-lib-cats button')[3]?.className.includes('on') === true);
(pickAll('.pe-lib-cats button')[1] as HTMLButtonElement).click();
await settleLib();
check('「未分类」筛出没填分类的那条', libNames().join() === 'ultra detailed', libNames().join('|'));
(pickAll('.pe-lib-cats button')[0] as HTMLButtonElement).click();
await settleLib();

console.log('词库面板：插入到当前块（连译文一起带，不再问接口）');
const markInsert = calls.length;
(libRow('cinematic lighting')?.querySelector('.pe-btn') as HTMLButtonElement).click();
await settleLib();
const insertedAt = chips(0).indexOf('cinematic lighting');
check('条目插进了当前块', insertedAt >= 0, chips(0).join('|'));
check('译文一起带上了', cellText(0, insertedAt) === '电影照明', cellText(0, insertedAt));
check('标记是「库」（插进来的这条就在库里）', markText(0, insertedAt) === '库', markText(0, insertedAt));
check(
  '插入**没有**发翻译请求（库里已经有中文了）',
  calls.slice(markInsert).every((call) => call.url.endsWith('/translate') === false),
  JSON.stringify(calls.slice(markInsert).map((call) => call.url)),
);
check('插入落盘（该组条目写一次）', calls.slice(markInsert).some((call) => ITEMS_URL.test(call.url)) === true);
const chipsAfterInsert = chips(0).length;
(libRow('cinematic lighting')?.querySelector('.pe-btn') as HTMLButtonElement).click();
await settleLib();
check('同一块里插第二次会被挡下（提示而不是又来一条）', chips(0).length === chipsAfterInsert, chips(0).join('|'));
check('提示说清是重复了', noticeText().includes('已经有了') === true, noticeText());

console.log('词库面板：改分类 / 别名');
const ultraRow = libRow('ultra detailed') as HTMLElement;
// 进编辑态后行里就没有 .pe-lib-en 了（模板换了），所以先抓住行元素再用
(ultraRow.querySelectorAll('.pe-btn')[1] as HTMLButtonElement).click();
await nextTick();
const editRow = ultraRow;
check('编辑态给三个输入框（译文 / 分类 / 别名）', editRow.querySelectorAll('.pe-lib-edit .pe-input').length === 3);
check(
  '编辑态看得见在改哪个词（原词不能消失）',
  editRow.querySelector('.pe-lib-edit-head .pe-lib-en')?.textContent?.trim() === 'ultra detailed',
  editRow.querySelector('.pe-lib-edit-head')?.textContent,
);
const editInputs = editRow.querySelectorAll('.pe-lib-edit .pe-input') as unknown as HTMLInputElement[];
await type(editInputs[1] as HTMLInputElement, '画质, 光照');
await type(editInputs[2] as HTMLInputElement, 'very detailed');
const markEdit = calls.length;
(editRow.querySelector('.pe-lib-edit .pe-btn') as HTMLButtonElement).click();
await settleLib();
const editCall = calls.slice(markEdit).find((call) => call.method === 'PUT' && call.url.endsWith('/tags/entry'));
check(
  '保存发一次 PUT /tags/entry（带上分类和别名）',
  (editCall?.body as { categories?: string[]; aliases?: string[] })?.categories?.join() === '画质,光照' &&
    (editCall?.body as { aliases?: string[] })?.aliases?.join() === 'very detailed',
  JSON.stringify(editCall?.body),
);
check('只改分类/别名不传 source（不因为改元数据就变成"我改过译文"）', (editCall?.body as { source?: string })?.source === undefined);
check('分类树跟着多了一条', catLabels().includes('画质') === true, catLabels().join('|'));

console.log('词库面板：改译文 = 我认可了它（升成 user）');
const detailRow = libRow('depth of field') as HTMLElement;
(detailRow.querySelectorAll('.pe-btn')[1] as HTMLButtonElement).click();
await nextTick();
const detailInputs = detailRow.querySelectorAll('.pe-lib-edit .pe-input') as unknown as HTMLInputElement[];
await type(detailInputs[0] as HTMLInputElement, '景深（我确认的）');
const markZh = calls.length;
(detailRow.querySelector('.pe-lib-edit .pe-btn') as HTMLButtonElement).click();
await settleLib();
const zhCall = calls.slice(markZh).find((call) => call.method === 'PUT' && call.url.endsWith('/tags/entry'));
check(
  '改了译文就带上 source:user',
  (zhCall?.body as { zh?: string })?.zh === '景深（我确认的）' && (zhCall?.body as { source?: string })?.source === 'user',
  JSON.stringify(zhCall?.body),
);

console.log('词库面板：删一条');
const markDelete = calls.length;
(ultraRow.querySelectorAll('.pe-btn')[2] as HTMLButtonElement).click();
await settleLib();
check(
  '删除发一次 DELETE /tags/entry',
  calls.slice(markDelete).some((call) => call.method === 'DELETE' && call.url.endsWith('/tags/entry')) === true,
  JSON.stringify(calls.slice(markDelete).map((call) => `${call.method} ${call.url}`)),
);
check('列表里没有了', libNames().includes('ultra detailed') === false, libNames().join('|'));

console.log('词库面板：关掉');
(pick('.pe-close') as HTMLButtonElement).click();
await nextTick();
check('关掉后面板不在了', pick('.pe-lib-row') === null);

console.log(failed === 0 ? '\n✅ 交互测试通过' : `\n❌ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
