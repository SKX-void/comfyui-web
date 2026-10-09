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
type FakeTag = { en: string; zh: string; categories: string[]; aliases: string[]; source: string; updatedAt: number; hot: number };
/**
 * 假词库。**刻意不放工作区里出现过的词**（8k / solo / 1girl…）：那几条的断言依赖
 * "没命中词库 → 现翻"，混进来会把"逐条发几条请求"这类断言弄脏。
 */
const tagSeed = (): Record<string, FakeTag> => ({
  masterpiece: { en: 'masterpiece', zh: '杰作', categories: ['画质'], aliases: [], source: 'import', updatedAt: 1, hot: 8419190 },
  'cinematic lighting': { en: 'cinematic lighting', zh: '电影照明', categories: ['光照'], aliases: ['cinematic light'], source: 'user', updatedAt: 2, hot: 0 },
  'depth of field': { en: 'depth of field', zh: '景深', categories: ['光照'], aliases: [], source: 'import', updatedAt: 3, hot: 2400 },
  'ultra detailed': { en: 'ultra detailed', zh: '超详细的', categories: [], aliases: [], source: 'builtin', updatedAt: 4, hot: 0 },
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
  fakeOrder = [];
  // 分类自己是独立的表（真库是 categories）—— 种子里的两个名字都注册过
  fakeCategories = ['画质', '光照'];
  fakeCatOrder = [];
}
let tagStamp = 100;
/** 手动排序后的 key 顺序（空 = 还没排过）。真库里是 `sort` 列，这里只要顺序对得上就够 */
let fakeOrder: string[] = [];
/** 假区块库：真库是 `block-presets.json`，这里就一份内存数组（顺序 = 插入顺序） */
let fakeBlockPresets: {
  id: string;
  name: string;
  updatedAt: number;
  title: string;
  color: string;
  mode: string;
  categoryId: string;
  items: string[];
}[] = [];
let fakeBlockSeq = 0;
/** 列表里的摘要形状：跟 `blockstore.ts` 的 `summarize` 对齐（列表只给摘要 + 前 3 条预览） */
function blockSummary(one: (typeof fakeBlockPresets)[number]): Record<string, unknown> {
  return {
    id: one.id,
    name: one.name,
    updatedAt: one.updatedAt,
    title: one.title,
    color: one.color,
    mode: one.mode,
    categoryId: one.categoryId,
    itemCount: one.items.length,
    preview: one.items.slice(0, 3),
  };
}
/** 区块库的分类：真库里是 `block-presets.json` 的 categories 段（独立 id、允许重名） */
let fakeBlockCats: { id: string; name: string }[] = [];
let fakeBlockCatSeq = 0;
/** 分类实体（含**还没有词用的空分类**）：真库里是 categories 表 */
let fakeCategories: string[] = [];
/** 分类的手动顺序（空 = 还没拖过）。真库里是 `categories.sort`，这里只要顺序对得上就够 */
let fakeCatOrder: string[] = [];

/** 假的 GET /tags：形状与 `server/tagdb.ts` 的 `query()` 一致（这一层只关心前端怎么用，不碰真库） */
function fakeTagList(q: string, category: string, limitRaw?: string | null): unknown {
  // 与真服务端同一套语义：`total` 最多报到 `limit + 1`（精确值要全表扫，故意不报）
  const limit = Math.min(1000, Math.max(1, Number(limitRaw ?? 200) || 200));
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
  const catRank = (name: string): number => {
    const at = fakeCatOrder.indexOf(name);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  // 排过序的按 `fakeOrder` 排在前面（对应真库的 `ORDER BY (sort IS NULL), sort`），其余按 updatedAt
  const rank = (key: string): number => {
    const at = fakeOrder.indexOf(key);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  tags.sort((a, b) => rank(a.en) - rank(b.en) || b.updatedAt - a.updatedAt);
  return {
    tags: tags.slice(0, limit).map((entry) => ({ key: entry.en, ...entry })),
    total: Math.min(tags.length, limit + 1),
    counts,
    categories: [...new Set([...fakeCategories, ...byCategory.keys()])]
      .map((name) => ({ name, count: byCategory.get(name) ?? 0 }))
      // 拖过顺序的排在前面（对应真库的 `(sort IS NULL), sort`），没序号的名次一律垫底
      .sort(
        (a, b) =>
          catRank(a.name) - catRank(b.name) ||
          b.count - a.count ||
          // 并列时按**码点序**（SQLite 的 `name ASC` 是 BINARY 排序）；localeCompare 是另一套，
          // 用它的话假库和真库的并列顺序会不一样（画/光 就是反的）
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      ),
  };
}
let translateFails = false;
/** 产物里那份内置机翻表在不在（`GET /tags/import` 的答案）：面板靠它决定画不画导入按钮 */
let bundledAvailable = true;
const translateBatches: string[][] = [];
/**
 * 假的下游插件：跨域调用要的两样东西 —— 宿主清单里的一行（探测）+ 它的参数快照（组包）。
 * 默认给"跑过一次"的样子：只有真跑过才有参数基底，跨域调用刻意不去猜模板默认值。
 */
let fakePlugins: { id: string; title: string; enabled: boolean; phase: string; error?: string }[] = [
  { id: 'prompt-editor', title: '提示词编辑器', enabled: true, phase: 'active' },
  { id: 'anima-plus', title: 'anima-plus', enabled: true, phase: 'active' },
];
let fakeAnimaState: { values: Record<string, unknown>; savedAt: string | null } = {
  values: {
    prompt: '上一次的描述提示词',
    loras: [{ name: 'Anima\\Anima Turbo LoRA-v0.2', weight: 0.9 }, { name: '', weight: 1 }],
    unet_name: 'Anima\\0.26.9.12.NAI.RDBT  Anima.b1V23Base_fp16.safetensors',
    seed: 421066625562399,
    randomSeed: true,
    steps: 6,
    cfg: 1,
    width: 832,
    height: 1216,
  },
  savedAt: '2026-02-09T12:33:00.000Z',
};
let fakeJobSeq = 0;

Object.defineProperty(globalThis, 'fetch', {
  value: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const path = String(url);
    const body = init?.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ method, url: path, body });
    const reply = (payload: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
    const fail = (message: string) => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ ok: false, error: { message } }),
    });

    // 分类树的手动顺序：真库是 `categories.sort`，第一次拖整树铺序号（这里只记顺序）
    if (method === 'PUT' && path.endsWith('/tags/categories/order')) {
      const names = (body?.names as string[]) ?? [];
      const rebuilt = fakeCatOrder.length === 0 || names.some((name) => !fakeCatOrder.includes(name));
      fakeCatOrder = [...names];
      return reply({ ok: true, written: rebuilt ? names.length : 1, rebuilt });
    }
    // **批量删除**这个分类下的词条：`fakeTags` 里真删掉（不是只摘归属），分类留着
    if (method === 'DELETE' && path.endsWith('/tags/categories/entries')) {
      const name = String(body?.name ?? '').trim();
      let deleted = 0;
      let userDeleted = 0;
      for (const [key, entry] of Object.entries(fakeTags)) {
        if (entry.categories.includes(name)) {
          if (entry.source === 'user') userDeleted += 1;
          delete fakeTags[key];
          deleted += 1;
        }
      }
      return reply({ ok: true, deleted, userDeleted });
    }

    // 分类级管理：分类自己是一张表（真库是 categories 表），所以**空分类也要列出来**
    if (method === 'POST' && path.endsWith('/tags/categories')) {
      const name = String(body?.name ?? '').trim();
      const created = !fakeCategories.includes(name);
      if (created) fakeCategories.push(name);
      return reply({ ok: true, created });
    }
    if (method === 'DELETE' && path.endsWith('/tags/categories')) {
      const name = String(body?.name ?? '').trim();
      fakeCategories = fakeCategories.filter((one) => one !== name);
      let removed = 0;
      for (const entry of Object.values(fakeTags)) {
        if (entry.categories.includes(name)) {
          entry.categories = entry.categories.filter((one) => one !== name);
          removed += 1;
        }
      }
      return reply({ ok: true, removed });
    }
    if (method === 'PUT' && path.endsWith('/tags/categories')) {
      const from = String(body?.from ?? '').trim();
      const to = String(body?.to ?? '').trim();
      if (fakeCategories.includes(to)) return fail(`已经有一个叫「${to}」的分类了（不自动合并）`);
      fakeCategories = fakeCategories.map((one) => (one === from ? to : one));
      let moved = 0;
      for (const entry of Object.values(fakeTags)) {
        if (entry.categories.includes(from)) {
          entry.categories = entry.categories.map((one) => (one === from ? to : one));
          moved += 1;
        }
      }
      return reply({ ok: true, moved });
    }

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
          // 与 server/translate.ts 一致：命中就是"在库里"，但导入的机翻单独报（工作区画「导」）
          return { text, translation: hit.zh, source: hit.source === 'import' ? 'import' : 'dict' };
        }),
      });
    }
    // 内置机翻表：面板打开时只**问一次**（GET，只 stat 产物里那份 CSV），点了按钮才写（POST）。
    // 这两条必须排在下面那条笼统的 `GET .../tags` 前面，否则会被它当成"查词库列表"接走。
    if (method === 'GET' && path.endsWith('/tags/import')) {
      return reply({ bundled: { available: bundledAvailable, bytes: 5448620 } });
    }
    // 手动排序：面板把这一页的新顺序整批发来，服务端记成 sort=1..N。
    // 这里也把它真的应用一遍（假库是对象，顺序另存一个数组），这样"拖完顺序真的变了"也验得到。
    if (method === 'PUT' && path.endsWith('/tags/order')) {
      const body = JSON.parse(init?.body === undefined ? '{}' : String(init.body)) as { keys?: string[]; moved?: string };
      const keys = body.keys ?? [];
      const known = keys.filter((key) => fakeTags[key] !== undefined);
      // 与真服务端同一套语义：还没铺过序号 = 整页重铺（rebuilt），铺过了 = 只写被拖的那一行
      const rebuilt = fakeOrder.length === 0;
      fakeOrder = [...known, ...fakeOrder.filter((key) => !known.includes(key))];
      return reply({ ok: true, written: rebuilt ? known.length : 1, rebuilt });
    }
    if (method === 'POST' && path.endsWith('/tags/import')) {
      // 与 server 那条路同一个语义：写进库里；已经是你改过的（user）不动
      const incoming: FakeTag[] = [
        { en: '1girl', zh: '1女', categories: ['机翻-通用'], aliases: [], source: 'import', updatedAt: 0, hot: 8419190 },
        { en: 'hatsune_miku', zh: '初音未来', categories: ['机翻-角色'], aliases: [], source: 'import', updatedAt: 0, hot: 120000 },
      ];
      let written = 0;
      for (const entry of incoming) {
        if (fakeTags[entry.en]?.source === 'user') continue;
        fakeTags[entry.en] = entry;
        written += 1;
      }
      return reply({
        ok: true,
        lines: 142571,
        rows: incoming.length,
        written,
        skipped: incoming.length - written,
        before: 0,
        after: Object.keys(fakeTags).length,
        noZh: 0,
        placeholder: 8224,
        duplicates: 0,
        elapsedMs: 12,
      });
    }
    if (method === 'GET' && path.includes('/tags')) {
      const url = new URL(path, 'http://localhost');
      return reply(
        fakeTagList(
          url.searchParams.get('q') ?? '',
          url.searchParams.get('category') ?? '',
          url.searchParams.get('limit'),
        ),
      );
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
        // 手改不动热度（与 server/tagdb.ts 的 mergeTag 一致）
        hot: current?.hot ?? 0,
      };
      return reply({ ok: true, entry: fakeTags[en] });
    }
    if (method === 'DELETE' && path.endsWith('/tags/entry')) {
      const en = String(body?.en ?? '');
      const had = fakeTags[en] !== undefined;
      delete fakeTags[en];
      return reply({ ok: true, deleted: had });
    }
    // 区块库：列表只给摘要（面板要的预览在 preview 里），按 id 取整条
    if (method === 'GET' && path.endsWith('/block-presets')) {
      return reply({ presets: fakeBlockPresets.map(blockSummary) });
    }
    if (method === 'PUT' && path.endsWith('/block-presets/order')) {
      const ids = (body?.ids as string[]) ?? [];
      // 没提到的垫到最后：与真服务端一样（`presets` 本来就是有序数组，重排 = 换排列）
      const rank = (id: string): number => {
        const at = ids.indexOf(id);
        return at < 0 ? ids.length + 1 : at;
      };
      fakeBlockPresets = [...fakeBlockPresets].sort((a, b) => rank(a.id) - rank(b.id));
      return reply({ presets: fakeBlockPresets.map(blockSummary) });
    }
    // 区块库的分类（跟词库分类不是一个东西：那边按名字寻址，这边独立 id、允许重名）
    if (method === 'GET' && path.endsWith('/block-categories')) {
      return reply({
        categories: fakeBlockCats.map((one) => ({
          id: one.id,
          name: one.name,
          count: fakeBlockPresets.filter((preset) => preset.categoryId === one.id).length,
        })),
        uncategorized: fakeBlockPresets.filter((preset) => preset.categoryId === '').length,
      });
    }
    if (method === 'POST' && path.endsWith('/block-categories')) {
      fakeBlockCatSeq += 1;
      const created = { id: `bc${fakeBlockCatSeq}`, name: String(body?.name ?? '') };
      fakeBlockCats.push(created);
      return reply({ category: created });
    }
    if (method === 'PUT' && path.endsWith('/block-categories/order')) {
      const ids = (body?.ids as string[]) ?? [];
      // 没提到的垫到最后：与真服务端一样，顺序以请求为准
      const rank = (id: string): number => {
        const at = ids.indexOf(id);
        return at < 0 ? ids.length + 1 : at;
      };
      fakeBlockCats = [...fakeBlockCats].sort((a, b) => rank(a.id) - rank(b.id));
      return reply({
        categories: fakeBlockCats.map((one) => ({
          id: one.id,
          name: one.name,
          count: fakeBlockPresets.filter((preset) => preset.categoryId === one.id).length,
        })),
      });
    }
    if (method === 'PUT' && path.endsWith('/block-categories')) {
      const hit = fakeBlockCats.find((one) => one.id === String(body?.id ?? ''));
      if (hit === undefined) return fail('没有这个分类');
      hit.name = String(body?.name ?? hit.name);
      return reply({ category: hit });
    }
    if (method === 'DELETE' && path.endsWith('/block-categories')) {
      const id = String(body?.id ?? '');
      const before = fakeBlockCats.length;
      fakeBlockCats = fakeBlockCats.filter((one) => one.id !== id);
      let cleared = 0;
      for (const preset of fakeBlockPresets) {
        if (preset.categoryId !== id) continue;
        preset.categoryId = '';
        cleared += 1;
      }
      return reply({ removed: fakeBlockCats.length !== before, cleared });
    }
    if (method === 'GET' && path.includes('/block-presets/')) {
      const id = path.slice(path.lastIndexOf('/') + 1);
      const hit = fakeBlockPresets.find((one) => one.id === id);
      return hit === undefined ? fail('没有这个预设区块') : reply({ preset: hit });
    }
    if (method === 'POST' && path.endsWith('/block-presets')) {
      fakeBlockSeq += 1;
      const created = {
        id: `bp${fakeBlockSeq}`,
        name: String(body?.name ?? ''),
        updatedAt: 1000 + fakeBlockSeq,
        title: String(body?.title ?? ''),
        color: String(body?.color ?? '#6ea8fe'),
        mode: String(body?.mode ?? 'tag'),
        categoryId: String(body?.categoryId ?? ''),
        items: (body?.items as string[]) ?? [],
      };
      fakeBlockPresets.push(created);
      return reply({ preset: created });
    }
    if (method === 'PUT' && path.includes('/block-presets/')) {
      const id = path.slice(path.lastIndexOf('/') + 1);
      const hit = fakeBlockPresets.find((one) => one.id === id);
      if (hit === undefined) return fail('没有这个预设区块');
      hit.name = String(body?.name ?? hit.name);
      if (body?.categoryId !== undefined) hit.categoryId = String(body.categoryId);
      return reply({ preset: hit });
    }
    if (method === 'DELETE' && path.includes('/block-presets/')) {
      const id = path.slice(path.lastIndexOf('/') + 1);
      const before = fakeBlockPresets.length;
      fakeBlockPresets = fakeBlockPresets.filter((one) => one.id !== id);
      return reply({ removed: fakeBlockPresets.length !== before });
    }
    // 宿主清单（跨域调用拿它判断下游装没装 / 启没启）
    if (method === 'GET' && path === '/api/plugins') {
      return reply({ plugins: fakePlugins });
    }
    // 假 anima-plus：参数快照（组包的基底）+ 作业（真发一次调用）
    if (path.startsWith('/api/p/anima-plus/api/')) {
      if (method === 'GET' && path.endsWith('/api/state')) {
        return reply({ ...fakeAnimaState, file: '/tmp/last-state.json' });
      }
      if (method === 'PUT' && path.endsWith('/api/state')) {
        fakeAnimaState = {
          values: (body?.values ?? {}) as Record<string, unknown>,
          savedAt: '2026-02-09T13:00:00.000Z',
        };
        return reply({ ...fakeAnimaState, file: '/tmp/last-state.json' });
      }
      if (method === 'POST' && path.endsWith('/api/jobs')) {
        fakeJobSeq += 1;
        return reply({
          jobId: `job${fakeJobSeq}`,
          promptId: 'p1',
          status: 'queued',
          queuePosition: 2,
          createdAt: '2026-02-09T13:00:00.000Z',
        });
      }
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

/** 行上的动作按钮按文字找：编辑模式一开，按钮集合就从「插入」变成「改 / 删」，按下标会点成删 */
function rowBtn(row: Element | null | undefined, label: string): HTMLButtonElement {
  const hit = [...(row?.querySelectorAll('.pe-lib-actions .pe-btn') ?? [])].find(
    (one) => (one.textContent ?? '').trim() === label,
  );
  if (hit === undefined) throw new Error(`这一行没有「${label}」按钮`);
  return hit as HTMLButtonElement;
}

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
  '装载阶段不写回（只有 5 次 GET：/draft、/settings，加跨域区的探测、预热与参数快照）',
  calls.every((call) => call.method === 'GET') &&
    calls.length === 5 &&
    calls.some((call) => call.url.endsWith('/draft') === true) &&
    calls.some((call) => call.url.endsWith('/settings') === true) &&
    calls.some((call) => call.url === '/api/plugins') &&
    // 探测成功后顺手预热：对方 /object_info 那 2s 的检查不能留到第一次发图时才做
    calls.some((call) => call.url.endsWith('/anima-plus/api/deps') === true) &&
    calls.some((call) => call.url.endsWith('/anima-plus/api/state') === true),
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

console.log('译文标记：在不在词库里，以及"谁写的"（库 / 导 / 机）');
check(
  '命中导入的机翻标「导」（十几万条灌进来后，全画「库」就分不出哪条是我改过的）',
  markText(0, 3) === '导',
  markText(0, 3),
);
check('机器现翻的标「机」', markText(0, 4) === '机', markText(0, 4));
check('手改过的标「库」（手改 = 已经进库了，而且是"人写的"）', markText(0, 1) === '库', markText(0, 1));
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

/**
 * 打开编辑模式（幂等）：面板每次打开都会回到浏览模式，需要改/删的小节各自先开一下。
 * 面板没开的时候它什么都不做 —— 所以调用要放在"面板已经开起来"之后。
 */
async function editModeOn(): Promise<void> {
  if ((pick('.pe-lib-mode')?.textContent ?? '').includes('关')) {
    (pick('.pe-lib-mode') as HTMLButtonElement).click();
    await nextTick();
  }
}
// 前面几节的手改 / 点「机」都真的写进了这份假词库（这就是真实行为），面板这节从一份干净的词库开始
resetFakeTags();
const libRow = (en: string): HTMLElement | undefined =>
  pickAll<HTMLElement>('.pe-lib-row').find((row) => row.querySelector('.pe-lib-en')?.textContent?.trim() === en);
const libNames = (): string[] => pickAll('.pe-lib-en').map((el) => el.textContent?.trim() ?? '');
/**
 * 分类树里**能点的那些**（全部 / 未分类 / 每个分类），不含 ＋新建、改名、删除那几个小按钮 ——
 * 它们也是 button，混在一起会把序号和文案都搅乱。
 */
const catPicks = (): HTMLButtonElement[] => [
  ...pickAll<HTMLButtonElement>('.pe-lib-cats > button'),
  ...pickAll<HTMLButtonElement>('.pe-lib-cats .pe-lib-cat-pick'),
];
const catLabels = (): string[] =>
  catPicks().map((el) => (el.textContent ?? '').trim().split(/\s+/)[0] ?? '');
/** 某个分类那一行上的管理按钮（改 / 清 / 删）。**按文字找**：按钮会增减，按下标会点错 */
const catRowTools = (name: string): HTMLButtonElement[] => {
  const row = pickAll('.pe-lib-cat-row').find((one) => (one.textContent ?? '').includes(name));
  return row === undefined ? [] : [...row.querySelectorAll<HTMLButtonElement>('.pe-lib-cat-tool')];
};
const catTool = (name: string, label: string): HTMLButtonElement => {
  const hit = catRowTools(name).find((one) => (one.textContent ?? '').trim() === label);
  if (hit === undefined) throw new Error(`「${name}」这一行没有「${label}」按钮`);
  return hit;
};
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
check('分类树：全部 / 未分类 / 已有分类（计数多的在前）', catLabels().join('|') === '全部|未分类|光照|画质', catLabels().join('|'));
check(
  '库里的条目一律标「库」（不按来源分 —— 进库就是库）',
  pickAll('.pe-lib-src').length === 4 && pickAll('.pe-lib-src').every((el) => el.textContent?.trim() === '库') === true,
  pickAll('.pe-lib-src').map((el) => el.textContent?.trim()).join('|'),
);
check('别名显示在条目上', libRow('cinematic lighting')?.textContent?.includes('cinematic light') === true);
check(
  '热度显示成短标签（8.4M / 2k）—— 面板是按它排序的，看得见才知道那一页为什么这么排；自己写的条目没热度就不显示',
  libRow('masterpiece')?.querySelector('.pe-lib-hot')?.textContent?.trim() === '8.4M' &&
    libRow('depth of field')?.querySelector('.pe-lib-hot')?.textContent?.trim() === '2k' &&
    libRow('cinematic lighting')?.querySelector('.pe-lib-hot') === null,
);

// 编辑模式：插入与编辑互斥（「删」没有二次确认，误触一次这条就没了）
check(
  '默认是浏览模式：行上只有「插入」',
  (libRow('masterpiece')?.querySelector('.pe-lib-actions')?.textContent ?? '').trim() === '插入',
  (libRow('masterpiece')?.querySelector('.pe-lib-actions')?.textContent ?? '').trim(),
);
check('浏览模式下：分类标签上没有摘分类的「×」', pick('.pe-lib-cat-x') === null);
check(
  '浏览模式下：左边分类树没有管理入口（＋ 新建分类 / 改 / 删 都不出现）',
  pick('.pe-lib-cat-new') === null && pick('.pe-lib-cat-tool') === null,
);
check('开关上写着当前状态', (pick('.pe-lib-mode')?.textContent ?? '').trim() === '编辑模式：关');

(pick('.pe-lib-mode') as HTMLButtonElement).click();
await nextTick();
check(
  '打开编辑模式：行上换成「改 / 删」，插入藏起来',
  (libRow('masterpiece')?.querySelector('.pe-lib-actions')?.textContent ?? '').trim() === '改删' &&
    (pick('.pe-lib-mode') as HTMLElement).className.includes('on') &&
    (pick('.pe-lib-mode')?.textContent ?? '').trim() === '编辑模式：开',
  (libRow('masterpiece')?.querySelector('.pe-lib-actions')?.textContent ?? '').trim(),
);
check(
  '打开编辑模式：左边分类树出现管理入口',
  pick('.pe-lib-cat-new') !== null && pick('.pe-lib-cat-tool') !== null,
);

// 关掉模式时不能留下"模式关了、某一行却还是表单"这种自相矛盾的状态
(pickAll('.pe-lib-actions .pe-btn')[0] as HTMLButtonElement).click();
await nextTick();
check('开了模式点「改」才进编辑态', pick('.pe-lib-edit') !== null);
(pick('.pe-lib-mode') as HTMLButtonElement).click();
await nextTick();
check(
  '关掉编辑模式：退出编辑态 + 行上回到只有「插入」',
  pick('.pe-lib-edit') === null &&
    (libRow('masterpiece')?.querySelector('.pe-lib-actions')?.textContent ?? '').trim() === '插入',
  `edit=${pick('.pe-lib-edit') !== null} actions=${(libRow('masterpiece')?.querySelector('.pe-lib-actions')?.textContent ?? '').trim()}`,
);
check(
  '关掉编辑模式：分类树的管理入口也收回去',
  pick('.pe-lib-cat-new') === null && pick('.pe-lib-cat-tool') === null,
);

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
(catPicks()[2] as HTMLButtonElement).click();
await settleLib();
check('点「光照」只剩那两条', libNames().sort().join('|') === 'cinematic lighting|depth of field', libNames().join('|'));
check('分类树高亮当前分类', catPicks()[2]?.className.includes('on') === true);
(catPicks()[1] as HTMLButtonElement).click();
await settleLib();
check('「未分类」筛出没填分类的那条', libNames().join() === 'ultra detailed', libNames().join('|'));
(catPicks()[0] as HTMLButtonElement).click();
await settleLib();

console.log('词库面板：插入到当前块（连译文一起带，不再问接口）');
const markInsert = calls.length;
(libRow('cinematic lighting')?.querySelector('.pe-btn') as HTMLButtonElement).click();
await settleLib();
const insertedAt = chips(0).indexOf('cinematic lighting');
check('条目插进了当前块', insertedAt >= 0, chips(0).join('|'));
check('译文一起带上了', cellText(0, insertedAt) === '电影照明', cellText(0, insertedAt));
check(
  '标记是「库」（插进来的这条是人写的/内置的，不是导入的机翻）',
  markText(0, insertedAt) === '库',
  markText(0, insertedAt),
);
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
await editModeOn();
const ultraRow = libRow('ultra detailed') as HTMLElement;
// 进编辑态后行里就没有 .pe-lib-en 了（模板换了），所以先抓住行元素再用
rowBtn(ultraRow, '改').click();
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
check(
  '在面板里动过就传 source: user（改分类/别名也算 —— 导入的十几万条里，你挪过分类的条目下次导入不许被冲回去）',
  (editCall?.body as { source?: string })?.source === 'user',
  JSON.stringify(editCall?.body),
);
check('分类树跟着多了一条', catLabels().includes('画质') === true, catLabels().join('|'));

console.log('词库面板：改译文（同样升成 user）');
await editModeOn();
const detailRow = libRow('depth of field') as HTMLElement;
rowBtn(detailRow, '改').click();
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
await editModeOn();
const markDelete = calls.length;
rowBtn(ultraRow, '删').click();
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

console.log('词库面板：空库 → 提示 + 手动导入内置机翻表');
// 真·空库（把假词库清空）。导入只在这里发生，而且只有点了按钮才会发生
for (const key of Object.keys(fakeTags)) delete fakeTags[key];
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
// 编辑模式把「插入」藏起来了，所以它不能粘着：重开面板 = 回到"能插"的状态
check(
  '重新打开面板回到浏览模式（编辑模式不粘着）',
  (pick('.pe-lib-mode')?.textContent ?? '').trim() === '编辑模式：关' &&
    pick('.pe-lib-cat-new') === null,
  (pick('.pe-lib-mode')?.textContent ?? '').trim(),
);
await settleLib();
const emptyCard = pick('.pe-lib-empty');
check(
  '空库时给一条"不用自己收集 CSV"的路（说明 + 按钮）',
  emptyCard?.textContent?.includes('导入内置的 danbooru 机翻表') === true,
  emptyCard?.textContent?.trim(),
);
check(
  '按钮上写明这一下要写进去多少（体积从产物问出来，不写死）',
  pick('.pe-lib-empty .pe-btn')?.textContent?.trim() === '导入内置机翻表' &&
    emptyCard?.textContent?.includes('5.2MB') === true,
  `${pick('.pe-lib-empty .pe-btn')?.textContent?.trim()} · ${emptyCard?.textContent?.includes('5.2MB')}`,
);
const markImport = calls.length;
(pick('.pe-lib-empty .pe-btn') as HTMLButtonElement).click();
await settleLib();
check(
  '点了才发 POST /tags/import（打开面板只问一次 GET，不动库）',
  calls
    .slice(markImport)
    .filter((call) => call.url.includes('/tags/import'))
    .map((call) => call.method)
    .join() === 'POST',
  JSON.stringify(calls.slice(markImport).map((call) => `${call.method} ${call.url}`)),
);
check(
  '导完说清楚入库多少条 / 你改过的没动，列表跟着刷新',
  pick('.pe-hint')?.textContent?.includes('入库 2 条') === true && libNames().length === 2,
  `${pick('.pe-hint')?.textContent} · ${libNames().join('|')}`,
);
check(
  '库里有东西之后：空态卡让位给页脚一个"重导"小按钮（换了新版 CSV 再导一遍用）',
  pick('.pe-lib-empty') === null && pick('.pe-btn-quiet') !== null,
  pick('.pe-btn-quiet')?.textContent?.trim(),
);
(pick('.pe-close') as HTMLButtonElement).click();
await nextTick();

// 产物里没有内置表（手写丢进 tabs/ 的目录、没跑过 build:plugins）：按钮不该画，且要说清楚怎么补
for (const key of Object.keys(fakeTags)) delete fakeTags[key];
bundledAvailable = false;
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
check(
  '产物里没有内置机翻表：不画按钮，写清楚先 pnpm build:plugins',
  pick('.pe-lib-empty .pe-btn') === null && pick('.pe-lib-empty')?.textContent?.includes('pnpm build:plugins') === true,
  pick('.pe-lib-empty')?.textContent?.trim(),
);
bundledAvailable = true;
(pick('.pe-close') as HTMLButtonElement).click();
await nextTick();
resetFakeTags();

console.log('词库面板：拖拽改分类（拖到左边分类上 = 换成那一个）');
// 上一行 resetFakeTags() 把假词库恢复成种子（4 条），面板是关着的 —— 重新打开
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
const navBtn = (name: string): HTMLElement =>
  catPicks().find((one) => (one.textContent ?? '').trim().startsWith(name)) as HTMLElement;
/** 拖一行到左边某个分类上：dragstart 在**可拖的那个元素**（`.pe-lib-line`）上、dragover + drop 在落点上 */
const dragTo = async (en: string, target: string): Promise<void> => {
  dispatch(libRow(en)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  const to = navBtn(target);
  dispatch(to, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  await nextTick();
  dispatch(to, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settleLib();
};
const putWritesSince = (mark: number) =>
  calls.slice(mark).filter((call) => call.method === 'PUT' && call.url.endsWith('/tags/entry'));

const markDrag = calls.length;
await dragTo('masterpiece', '光照');
const dragWrites = putWritesSince(markDrag);
check(
  '拖到分类上 = 发一次 PUT，分类**就是那一个**（不是加一个）',
  dragWrites.length === 1 &&
    JSON.stringify(dragWrites[0]?.body?.categories) === '["光照"]' &&
    dragWrites[0]?.body?.source === 'user',
  JSON.stringify(dragWrites.map((call) => call.body)),
);
check('拖完说清楚去了哪（没有保存按钮 —— 松手就是改了）', pick('.pe-hint')?.textContent?.includes('→ 光照') === true, pick('.pe-hint')?.textContent);
check('行上的分类跟着变了', libRow('masterpiece')?.textContent?.includes('光照') === true, libRow('masterpiece')?.textContent);

const markNone = calls.length;
await dragTo('masterpiece', '未分类');
const noneWrite = putWritesSince(markNone)[0];
check(
  '拖到「未分类」= 分类清空（那是个真状态，不是特例）',
  noneWrite !== undefined && JSON.stringify(noneWrite.body?.categories) === '[]',
  JSON.stringify(noneWrite?.body),
);
check('清空后提示也换了说法', pick('.pe-hint')?.textContent?.includes('未分类') === true, pick('.pe-hint')?.textContent);

console.log('词库面板：增减分类的独立入口（× 摘掉 · 编辑态点标签加/减）');
await editModeOn();
const markX = calls.length;
const xButton = libRow('depth of field')?.querySelector('.pe-lib-cat-x') as HTMLElement;
xButton.click();
await settleLib();
const xWrite = putWritesSince(markX)[0];
check(
  '行上分类标签的「×」= 摘掉那个分类（拖拽答不了"减"）',
  putWritesSince(markX).length === 1 && JSON.stringify(xWrite?.body?.categories) === '[]',
  JSON.stringify(putWritesSince(markX).map((call) => call.body)),
);
check('摘掉后行上不再有那个分类', libRow('depth of field')?.querySelector('.pe-lib-cat') === null, libRow('depth of field')?.textContent);

// 编辑态：点标签 = 加/减（精确那条路），输入框仍在（批量改 / 造新分类名）
rowBtn(libRow('cinematic lighting'), '改').click();
await nextTick();
const pickLabels = (): string[] =>
  pickAll<HTMLElement>('.pe-lib-edit-cats .pe-lib-cat-pick').map((one) => (one.textContent ?? '').trim());
const pickByName = (name: string): HTMLElement =>
  pickAll<HTMLElement>('.pe-lib-edit-cats .pe-lib-cat-pick').find((one) => (one.textContent ?? '').trim() === name) as HTMLElement;
const catInput = (): HTMLInputElement => pick('.pe-lib-edit-cats .pe-input') as HTMLInputElement;
check(
  '编辑态列出的分类 = 左边分类树那批（分类做成实体后，**没人用的分类也还在**，只是计数 0）',
  pickLabels().join('|') === '光照|画质',
  pickLabels().join('|'),
);
// cinematic lighting 本来就是「光照」→ 点它 = 去掉；再点 = 加回来
pickByName('光照').click();
await nextTick();
check('点一下已有的分类 = 从输入框去掉', catInput().value === '', catInput().value);
pickByName('光照').click();
await nextTick();
check('再点一下 = 加回来', catInput().value === '光照', catInput().value);
// 收尾：取消编辑，别把这条留在编辑态影响后面的小节
(pickAll<HTMLButtonElement>('.pe-lib-edit .pe-btn')[1] as HTMLButtonElement).click();
await nextTick();
(pick('.pe-close') as HTMLButtonElement).click();
await nextTick();
resetFakeTags();

console.log('词库面板：分类级管理（新建 / 改名 / 删除）');
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
// 面板每次打开都回到浏览模式，所以要等它开起来再开编辑模式
await editModeOn();
// 前面的小节**真的**写过库（手改译文、改分类都走真接口），所以先要一个确定的起点：
// 种子 = 光照(2 条：cinematic lighting / depth of field) + 画质(1 条：masterpiece)
resetFakeTags();
await type(pick('.pe-lib-bar .pe-input') as HTMLInputElement, '');
await settleLib();
check('起点：分类树按计数排（光照 2 条 / 画质 1 条）', catLabels().join('|') === '全部|未分类|光照|画质', catLabels().join('|'));
// 新建：一个还没有任何词用的空分类，也得能建、能列出来
const newBtn = pick('.pe-lib-cat-new') as HTMLButtonElement | null;
check('分类树顶部有「＋ 新建分类」', newBtn !== null && (newBtn.textContent ?? '').includes('新建分类'), newBtn?.textContent ?? '没有');
newBtn?.click();
await nextTick();
const newCatInput = pick('.pe-lib-cat-input') as HTMLInputElement | null;
check('点了之后出现输入框', newCatInput !== null);
// 抢焦点这条是真踩过的坑：不抢焦点，`@keyup.enter/esc` 挂在输入框上就永远不触发，
// 用户看到的是"点了没反应，也没法取消"
check('新建的输入框自己拿到焦点', document.activeElement === newCatInput, document.activeElement?.tagName);
check(
  '新建有「新建 / 取消」两个按钮（不是只能靠键盘）',
  pickAll('.pe-lib-cat-btns .pe-btn').map((el) => el.textContent?.trim()).join() === '新建,取消',
  pickAll('.pe-lib-cat-btns .pe-btn').map((el) => el.textContent?.trim()).join('|'),
);
const markNew = calls.length;
if (newCatInput !== null) {
  await type(newCatInput, '我的分类');
  (pickAll('.pe-lib-cat-btns .pe-btn')[0] as HTMLButtonElement).click();
  await settleLib();
}
check(
  '新建发一次 POST /tags/categories，带的是名字',
  calls.slice(markNew).filter((call) => call.method === 'POST' && call.url.endsWith('/tags/categories')).length === 1 &&
    JSON.stringify(calls.slice(markNew).find((call) => call.method === 'POST')?.body) === JSON.stringify({ name: '我的分类' }),
  JSON.stringify(calls.slice(markNew).map((call) => call.body)),
);
check(
  '空分类也出现在树里（计数 0）—— 这就是分类做成实体表的意义',
  catLabels().includes('我的分类') &&
    (catPicks().find((one) => (one.textContent ?? '').includes('我的分类'))?.textContent ?? '').includes('0'),
  catLabels().join('|'),
);
check('提示说清了新建结果', (pick('.pe-hint')?.textContent ?? '').includes('已新建分类'), pick('.pe-hint')?.textContent ?? '');

// 改名：挂着分类的那条要跟着走
const renameTool = catTool('画质', '改');
renameTool.click();
await nextTick();
const newRenameInput = pick('.pe-lib-cat-input') as HTMLInputElement | null;
const markRename = calls.length;
check('改名的输入框自己拿到焦点', document.activeElement === newRenameInput, document.activeElement?.tagName);
check('改名时那一行被标出来（改的是哪个）', pick('.pe-lib-cat-row-editing') !== null);
check(
  '改名有「改名 / 取消」两个按钮',
  pickAll('.pe-lib-cat-btns .pe-btn').map((el) => el.textContent?.trim()).join() === '改名,取消',
  pickAll('.pe-lib-cat-btns .pe-btn').map((el) => el.textContent?.trim()).join('|'),
);
// Esc 取消：靠的是输入框上的 @keyup.esc，所以必须真的有焦点
dispatch(newRenameInput as HTMLInputElement, new window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
await nextTick();
check('按 Esc 撤掉改名，且一个请求都不发', pick('.pe-lib-cat-input') === null && calls.length === markRename);
catTool('画质', '改').click();
await nextTick();
if (newRenameInput !== null) {
  await type(newRenameInput, '画质与风格');
  dispatch(newRenameInput, new window.KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  await settleLib();
}
check(
  '改名发一次 PUT /tags/categories（from/to）',
  JSON.stringify(calls.slice(markRename).find((call) => call.method === 'PUT')?.body) ===
    JSON.stringify({ from: '画质', to: '画质与风格' }),
  JSON.stringify(calls.slice(markRename).map((call) => call.body)),
);
check('树里换成新名字，用它的词条跟着走', catLabels().includes('画质与风格') && !catLabels().includes('画质'), catLabels().join('|'));
check('改名后条目上也是新分类', libRow('masterpiece')?.textContent?.includes('画质与风格') === true);

// 删除：批量破坏性，所以先摆影响范围再确认
const markBeforeAsk = calls.length;
catTool('光照', '删').click();
await nextTick();
const warn = pick('.pe-lib-cat-warn')?.textContent ?? '';
check('点「×」先出确认，并写清影响多少条', warn.includes('光照') && warn.includes('2'), warn.replace(/\s+/g, ' '));
check('确认之前一个请求都不发', calls.length === markBeforeAsk, JSON.stringify(calls.slice(markBeforeAsk)));
(pickAll('.pe-lib-cat-btns .pe-btn')[1] as HTMLButtonElement).click();
await nextTick();
check('点「取消」就撤掉，也不发请求', pick('.pe-lib-cat-warn') === null && calls.length === markBeforeAsk);
catTool('光照', '删').click();
await nextTick();
const markRemove = calls.length;
(pickAll('.pe-lib-cat-btns .pe-btn')[0] as HTMLButtonElement).click();
await settleLib();
check(
  '确认删除发一次 DELETE /tags/categories',
  JSON.stringify(calls.slice(markRemove).find((call) => call.method === 'DELETE')?.body) === JSON.stringify({ name: '光照' }),
  JSON.stringify(calls.slice(markRemove).map((call) => call.body)),
);
check('分类没了，条目本身还在（只是变回未分类）', !catLabels().includes('光照') && libRow('cinematic lighting') !== null, catLabels().join('|'));
check('提示说清了"词条本身没删"', (pick('.pe-hint')?.textContent ?? '').includes('词条本身没删'), pick('.pe-hint')?.textContent ?? '');
(pick('.pe-close') as HTMLButtonElement).click();
await nextTick();
resetFakeTags();

console.log('词库面板：分类排序 + 清空分类内容');
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
await editModeOn();
const catRow = (name: string): HTMLElement | null =>
  ([...document.querySelectorAll('.pe-lib-cat-row')] as HTMLElement[]).find(
    (one) => one.querySelector('.pe-lib-cat-name')?.textContent?.trim() === name,
  ) ?? null;
check('起点：分类树按计数（光照 2 条在前）', catLabels().join('|') === '全部|未分类|光照|画质', catLabels().join('|'));

// 拖最后一个分类到最前面：happy-dom 拿不到布局，dragover 一律按"插到这一行前面"算
const markCat = calls.length;
const catDragStart = (el: Element): void => dispatch(el, new window.DragEvent('dragstart', { bubbles: true }));
const catDragOver = (el: Element): void =>
  dispatch(el, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
const catDropOn = (el: Element): void => dispatch(el, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
catDragStart(catRow('画质') as Element);
catDragOver(catRow('光照') as Element);
catDropOn(catRow('光照') as Element);
await settleLib();
const catCalls = calls.slice(markCat).filter((call) => call.url.endsWith('/tags/categories/order'));
check(
  '拖分类发一次 PUT /tags/categories/order，带的是新顺序 + 被拖的那个',
  catCalls.length === 1 &&
    JSON.stringify(catCalls[0]?.body) === JSON.stringify({ names: ['画质', '光照'], moved: '画质' }),
  JSON.stringify(catCalls[0]?.body ?? null),
);
check('分类顺序真的变了（光照 退到后面）', catLabels().join('|') === '全部|未分类|画质|光照', catLabels().join('|'));
check(
  '第一次拖如实说是重铺序号（分类只有几个，整树铺）',
  (pick('.pe-hint')?.textContent ?? '').includes('重铺了序号') === true,
  pick('.pe-hint')?.textContent ?? '',
);

// 拖回原位不该发请求（不然每点一下都写一遍）
const markStill = calls.length;
catDragStart(catRow('画质') as Element);
catDragOver(catRow('画质') as Element);
catDropOn(catRow('画质') as Element);
await settleLib();
check(
  '拖回原位不发请求',
  calls.slice(markStill).every((call) => !call.url.endsWith('/tags/categories/order')),
  JSON.stringify(calls.slice(markStill).map((call) => call.url)),
);

// 清空 ≠ 删除：分类留着、计数归零、词条一条不删
const markClear = calls.length;
const clearBtn = ([...document.querySelectorAll('.pe-lib-cat-tool')] as HTMLElement[]).find(
  (one) => one.textContent?.trim() === '清' && one.closest('.pe-lib-cat-row') === catRow('光照'),
);
check('编辑模式下每个分类行有三个工具（改 / 清 / 删）', document.querySelectorAll('.pe-lib-cat-tool').length === 6,
  String(document.querySelectorAll('.pe-lib-cat-tool').length));
(clearBtn as HTMLButtonElement).click();
await nextTick();
check(
  '点「清」先摆出影响范围（几条会被删掉、不可撤销、分类留着）',
  (pick('.pe-lib-cat-warn')?.textContent ?? '').includes('2') &&
    (pick('.pe-lib-cat-warn')?.textContent ?? '').includes('从词库里删掉') &&
    (pick('.pe-lib-cat-warn')?.textContent ?? '').includes('不可撤销') &&
    (pick('.pe-lib-cat-warn')?.textContent ?? '').includes('分类本身留着'),
  (pick('.pe-lib-cat-warn')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
);
check('清空前分类还在', catLabels().includes('光照') === true, catLabels().join('|'));
const clearCalls = calls.slice(markClear).filter((call) => call.url.endsWith('/tags/categories/entries'));
check(
  '确认前一个请求都没发',
  clearCalls.length === 0,
  JSON.stringify(calls.slice(markClear).map((call) => call.url)),
);
(pickAll('.pe-lib-cat-btns .pe-btn')[0] as HTMLButtonElement).click();
await settleLib();
const doneClear = calls.slice(markClear).filter((call) => call.url.endsWith('/tags/categories/entries'));
check(
  '确认后发一次 DELETE /tags/categories/entries，带的是分类名',
  doneClear.length === 1 && JSON.stringify(doneClear[0]?.body) === JSON.stringify({ name: '光照' }),
  JSON.stringify(doneClear[0]?.body ?? null),
);
check('分类还在，只是计数归零（清空 ≠ 删除）', catLabels().join('|') === '全部|未分类|画质|光照', catLabels().join('|'));
check('词条真的从库里删掉了（列表里只剩没被删的那两条）', libNames().length === 2, libNames().join('|'));
check(
  '提示说清了删了几条、分类留着、其中几条是手改过的',
  (pick('.pe-hint')?.textContent ?? '').includes('已从库里删掉 2 条') === true &&
    (pick('.pe-hint')?.textContent ?? '').includes('光照') === true &&
    (pick('.pe-hint')?.textContent ?? '').includes('其中 1 条是你手改过的') === true,
  pick('.pe-hint')?.textContent ?? '',
);

// 这一段是全套里唯一**真删词条**的：删完把假库恢复成种子，后面的章节还要用那 4 条
// （走搜索框这条最稳：清空输入 + 派发 input 一定会重新拉列表）
resetFakeTags();
const seedBox = pick('.pe-lib-bar .pe-input') as HTMLInputElement;
seedBox.value = '';
dispatch(seedBox, new window.Event('input', { bubbles: true }));
await settleLib();
check('恢复种子（这一段是唯一真删词条的）', libNames().length === 4, `${libNames().join('|')} · 分类 ${catLabels().join('|')}`);

console.log('词库面板：六点手柄 + 拖拽排序 + 拖拽时左侧高亮');
(pickAll('.pe-top .pe-actions button')[2] as HTMLButtonElement).click();
await settleLib();
const rowKeys = (): string[] =>
  pickAll<HTMLElement>('.pe-lib-row .pe-lib-en').map((one) => (one.textContent ?? '').trim());
check(
  '每行前面有六点手柄（内联 SVG，6 个点）',
  pickAll('.pe-lib-row .pe-lib-grip svg circle').length === pickAll('.pe-lib-row').length * 6,
  `${pickAll('.pe-lib-row .pe-lib-grip').length} 个手柄 / ${pickAll('.pe-lib-row').length} 行`,
);
check('手柄带得动这一行（手柄所在的 .pe-lib-line 是可拖的）', pick('.pe-lib-row .pe-lib-line')?.getAttribute('draggable') === 'true');

// 拖起来：左边整列点亮（所有能放的地方都显出来），悬停到的那个再加强
const orderBefore = rowKeys();
dispatch(libRow(orderBefore[3] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragstart', { bubbles: true }));
await nextTick();
check('一拿起手柄，左侧整列点亮（能放的地方都显出来）', pick('.pe-lib-cats-dragging') !== null, pick('.pe-lib-cats')?.className);
check(
  '点亮的是"能放的"那几个：未分类 + 已有分类（「全部」不是落点）',
  pickAll('.pe-lib-cats [data-drop="ok"]').length === catPicks().length - 1,
  `${pickAll('.pe-lib-cats [data-drop="ok"]').length} / ${catPicks().length} 个落点`,
);
// 悬停到第一行上半边 = 插到最前面
const firstLine = libRow(orderBefore[0] as string)?.querySelector('.pe-lib-line') as Element;
dispatch(firstLine, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
await nextTick();
check('悬停的行画出插入位置（插到它前面）', libRow(orderBefore[0] as string)?.className.includes('pe-lib-row-over-before') === true);
const markOrder = calls.length;
dispatch(firstLine, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
await settleLib();
const orderWrites = calls.slice(markOrder).filter((call) => call.method === 'PUT' && call.url.endsWith('/tags/order'));
const sentKeys = (orderWrites[0]?.body as { keys?: string[] } | undefined)?.keys ?? [];
const sentMoved = (orderWrites[0]?.body as { moved?: string } | undefined)?.moved;
check(
  '松手 = 发一次 PUT /tags/order：这一页的新顺序 + 被拖的那条（moved）',
  orderWrites.length === 1 && sentKeys[0] === orderBefore[3] && sentKeys.length === orderBefore.length && sentMoved === orderBefore[3],
  JSON.stringify({ keys: sentKeys.slice(0, 3), moved: sentMoved }),
);
check('拖完顺序真的变了（服务端记下后再读回来）', rowKeys()[0] === orderBefore[3], rowKeys().join(' | '));
check('第一次拖是"整页铺序号"，提示如实说出来', (pick('.pe-hint')?.textContent ?? '').includes('重排了序号'), pick('.pe-hint')?.textContent ?? '');

// 拖完要重新拉一次列表 —— 「读取中…」**必须待在头部常驻**（只切 visibility）：
// 它原来是列表里的第一行，出现/消失就把下面所有行顶下去再弹回来（布局抖一下）
const loadingNode = pick('.pe-panel-head .pe-lib-loading');
check(
  '「读取中…」在头部、不在列表里',
  loadingNode !== null && pick('.pe-lib-list .pe-lib-loading') === null,
  loadingNode?.className,
);
check('闲着的时候它只是占位（不显示，但盒子一直在）', loadingNode?.className === 'pe-lib-loading', loadingNode?.className);

// 第二次拖（序号已经铺过了）= 只写一行，提示不该再说"重排了序号"
const seededKeys = rowKeys();
dispatch(libRow(seededKeys[2] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragstart', { bubbles: true }));
await nextTick();
dispatch(libRow(seededKeys[0] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
await nextTick();
dispatch(libRow(seededKeys[0] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
await settleLib();
check('铺过序号之后再拖：提示就是「顺序已记下」（不喊重排）', (pick('.pe-hint')?.textContent ?? '') === '顺序已记下', pick('.pe-hint')?.textContent ?? '');
check(
  '再拉一次数据后它还是同一个节点（只切 class，不增删 → 不动布局）',
  pick('.pe-panel-head .pe-lib-loading') === loadingNode,
);

// 拖回原位 = 不发请求（不然随手一点就写一整页）
const markNoop = calls.length;
const stillKeys = rowKeys();
dispatch(libRow(stillKeys[0] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragstart', { bubbles: true }));
await nextTick();
dispatch(libRow(stillKeys[0] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
await nextTick();
dispatch(libRow(stillKeys[0] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
await settleLib();
check(
  '拖回原地（顺序没变）= 一个请求都不发',
  calls.slice(markNoop).filter((call) => call.url.endsWith('/tags/order')).length === 0,
  JSON.stringify(calls.slice(markNoop).map((call) => call.url)),
);

// 筛选 / 搜索出来的是一小撮：在那一小撮里拖顺序会把它们整批顶到全库最前，说不通 —— 所以不接排序
await type(pick('.pe-lib-bar .pe-input') as HTMLInputElement, 'a');
await settleLib();
const filtered = rowKeys();
check('搜索后列表变短了（下面要在这一小撮里试拖顺序）', filtered.length < stillKeys.length, `${filtered.length} vs ${stillKeys.length}`);
const markFiltered = calls.length;
if (filtered.length >= 2) {
  dispatch(libRow(filtered[1] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  const target = libRow(filtered[0] as string)?.querySelector('.pe-lib-line') as Element;
  dispatch(target, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  await nextTick();
  dispatch(target, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settleLib();
}
check(
  '搜索态下拖行不排序（一个 /tags/order 都不发）',
  calls.slice(markFiltered).filter((call) => call.url.endsWith('/tags/order')).length === 0,
  JSON.stringify(calls.slice(markFiltered).map((call) => call.url)),
);
// 但筛选态下"拖到左边换分类"照旧（那是两件事）
const markFilteredCat = calls.length;
dispatch(libRow(filtered[0] as string)?.querySelector('.pe-lib-line') as Element, new window.DragEvent('dragstart', { bubbles: true }));
await nextTick();
dispatch(navBtn('未分类'), new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
await nextTick();
dispatch(navBtn('未分类'), new window.DragEvent('drop', { bubbles: true, cancelable: true }));
await settleLib();
check(
  '搜索态下拖到左边分类仍然生效（排序和换分类是两件事）',
  calls.slice(markFilteredCat).filter((call) => call.method === 'PUT' && call.url.endsWith('/tags/entry')).length === 1,
  JSON.stringify(calls.slice(markFilteredCat).map((call) => call.url)),
);

// 头部数字：不筛选时写全库，筛选时得写"命中"（原来不管搜什么都写全库总数，容易被读成"搜到这么多"）
await type(pick('.pe-lib-bar .pe-input') as HTMLInputElement, '');
await settleLib();
const statAll = pick('.pe-lib-stat')?.textContent ?? '';
check('没筛选时头部写「共 N 条 · 未分类 M」', statAll.includes('共') && statAll.includes('未分类'), statAll);
await type(pick('.pe-lib-bar .pe-input') as HTMLInputElement, '电影');
await settleLib();
const statHits = pick('.pe-lib-stat')?.textContent ?? '';
check('筛选时头部改成「命中 N 条 · 全库 M」', statHits.includes('命中 1 条') && statHits.includes('全库'), statHits);

// 加载更多：一次只取 300 条，后面的行原来除了搜索没有入口
for (let i = 0; i < 400; i += 1) {
  fakeTags[`bulk_${i}`] = { en: `bulk_${i}`, zh: `批量${i}`, categories: [], aliases: [], source: 'import', updatedAt: 0, hot: 0 };
}
const moreBox = pick('.pe-lib-bar .pe-input') as HTMLInputElement;
await type(moreBox, 'bulk');
await settleLib();
check('一页只给 300 条', pickAll('.pe-lib-row').length === 300, String(pickAll('.pe-lib-row').length));
const moreBtn = pick('.pe-lib-more') as HTMLButtonElement | null;
check('还有更多时出现「加载更多」（并写着已显示多少）', moreBtn !== null && (moreBtn.textContent ?? '').includes('300'), moreBtn?.textContent ?? '没有按钮');
const markMore = calls.length;
moreBtn?.click();
await settleLib();
check(
  '点了之后按 limit=600 再取一次',
  calls.slice(markMore).some((call) => call.url.includes('limit=600')) === true,
  JSON.stringify(calls.slice(markMore).map((call) => call.url)),
);
check('400 条全出来了，按钮自己收起来', pickAll('.pe-lib-row').length === 400 && pick('.pe-lib-more') === null, String(pickAll('.pe-lib-row').length));
(pick('.pe-close') as HTMLButtonElement).click();
await nextTick();
resetFakeTags();

console.log('跨块拖条目：块类型相同才接');
const dragStart = (el: Element): void => dispatch(el, new window.DragEvent('dragstart', { bubbles: true }));
const dragOver = (el: Element): void =>
  dispatch(el, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
const dragEnd = (el: Element): void => dispatch(el, new window.DragEvent('dragend', { bubbles: true }));
const dropOn = (el: Element): void => dispatch(el, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
const chipAt = (blockIndex: number, chipIndex: number): HTMLElement =>
  blockOf(blockIndex).querySelectorAll('.pe-chip')[chipIndex] as HTMLElement;
const bodyOf = (blockIndex: number): HTMLElement => blockOf(blockIndex).querySelector('.pe-block-body') as HTMLElement;

// 第 3 块在风格开关那节末尾又切回了 tag；这里再切回自然语言，拿它当"类型不同"的靶子
// （重切出来的条目会排进自动译，等那一波走完再往下测）
(blockOf(2).querySelectorAll('.pe-block-modes button')[1] as HTMLButtonElement).click();
await new Promise((resolve) => setTimeout(resolve, 500));
await settle(12);
check(
  '前置条件：第 1、2 块 tag，第 3 块自然语言',
  blockOf(0).querySelector('.pe-block-body-text') === null &&
    blockOf(1).querySelector('.pe-block-body-text') === null &&
    blockOf(2).querySelector('.pe-block-body-text') !== null,
);

// ① 同类块：第 1 块的第 1 条 → 第 2 块的第 1 条（落点 = 插到那一条前面）
const srcText = chips(0)[0] ?? '';
const dstBefore = chips(1);
dragStart(chipAt(0, 0));
await nextTick();
check('起手后源条目进入拖拽态', chipAt(0, 0).className.includes('pe-chip-dragging') === true, chipAt(0, 0).className);
dragOver(chipAt(1, 0));
await nextTick();
check(
  '悬停在同类块的条目上会亮',
  blockOf(1).querySelectorAll('.pe-chip-over').length === 1,
  String(blockOf(1).querySelectorAll('.pe-chip-over').length),
);
const markMove = calls.length;
dropOn(chipAt(1, 0));
await nextTick();
await settle();
dragEnd(chipAt(1, 0));
await nextTick();
check('条目搬到了目标块的落点上', sameTexts(chips(1), [srcText, ...dstBefore]), chips(1).join('|'));
check('源块里不再有它', chips(0).includes(srcText) === false, chips(0).join('|'));
const movedWrites = writesSince(markMove).filter((call) => ITEMS_URL.test(call.url));
check(
  '源块与目标块各落盘一次（草稿是按组存的）',
  movedWrites.length === 2 && new Set(movedWrites.map((call) => call.url)).size === 2,
  JSON.stringify(movedWrites.map((call) => call.url)),
);

// ② 类型不同：tag 的一条拖进自然语言块 —— 不落地，一个写请求都不该发
const crossText = chips(0)[0] ?? '';
const textBefore = chips(2);
const markCross = calls.length;
dragStart(chipAt(0, 0));
await nextTick();
dragOver(chipAt(2, 0));
await nextTick();
check('类型不同的块不亮（拖过去也不会落地）', blockOf(2).querySelectorAll('.pe-chip-over').length === 0);
dropOn(chipAt(2, 0));
await nextTick();
await settle();
dragEnd(chipAt(0, 0));
await nextTick();
check('类型不同：条目留在原块', chips(0)[0] === crossText, chips(0).join('|'));
check('类型不同：目标块原样', sameTexts(chips(2), textBefore), chips(2).join('|'));
check(
  '类型不同：一个写请求都不发',
  writesSince(markCross).length === 0,
  JSON.stringify(writesSince(markCross).map((call) => call.url)),
);

// ③ 拖到块体空白 = 追加到末尾（落点是 items.length）
const tailText = chips(0)[0] ?? '';
const tailBefore = chips(1);
dragStart(chipAt(0, 0));
await nextTick();
dragOver(bodyOf(1));
await nextTick();
check('拖到块体空白：整块亮起来（落点是末尾）', blockOf(1).querySelector('.pe-block-body-drop') !== null);
dropOn(bodyOf(1));
await nextTick();
await settle();
dragEnd(bodyOf(1));
await nextTick();
check('拖到块体空白 = 追加到末尾', sameTexts(chips(1), [...tailBefore, tailText]), chips(1).join('|'));

// ④ 区块排序的落点也是块体/条目：条目那套处理器**不能把 drop 吞掉**（没在拖条目就放行）
const titleOf = (blockIndex: number): string =>
  (blockOf(blockIndex).querySelector('.pe-block-title') as HTMLInputElement).value;
const firstTitle = titleOf(0);
const markReorder = calls.length;
const grip = blockOf(0).querySelector('.pe-block-grip') as HTMLElement;
dragStart(grip);
await nextTick();
dragOver(bodyOf(1));
await nextTick();
dropOn(bodyOf(1));
await nextTick();
await settle();
dragEnd(grip);
await nextTick();
check('拖区块把手到别的块体上：区块真的换位了', titleOf(1) === firstTitle, `${firstTitle} → ${titleOf(0)}|${titleOf(1)}`);
check(
  '区块换位只发结构（不含条目）',
  writesSince(markReorder).length === 1 && writesSince(markReorder)[0]?.url === STRUCTURE_URL,
  JSON.stringify(writesSince(markReorder).map((call) => call.url)),
);

console.log('区块颜色：预设色板之外，可以自己写一个颜色字符串');
const colorDot = blockOf(0).querySelector('.pe-block-dot') as HTMLElement;
colorDot.click();
await nextTick();
check('点色点打开色板', blockOf(0).querySelector('.pe-palette') !== null);
check(
  '色板里 8 个预设色 + 一个自定义输入框',
  blockOf(0).querySelectorAll('.pe-swatch').length === 8 && blockOf(0).querySelector('.pe-swatch-input') !== null,
);
const colorInput = blockOf(0).querySelector('.pe-swatch-input') as HTMLInputElement;
check(
  '打开时输入框里就是当前色（好在这个基础上改）',
  colorInput.value === blockOf(0).style.borderColor,
  `${colorInput.value} / ${blockOf(0).style.borderColor}`,
);

const markColor = calls.length;
await type(colorInput, '#123456');
await blur(colorInput);
check('自定义颜色落到区块上（边框跟着变）', blockOf(0).style.borderColor === '#123456', blockOf(0).style.borderColor);
check('提交后面板不关（关掉的话"失焦即提交"这条链会断）', blockOf(0).querySelector('.pe-palette') !== null);
const colorWrite = writesSince(markColor);
check(
  '发一次结构写（颜色是区块属性，跟结构走）',
  colorWrite.length === 1 && colorWrite[0]?.url === STRUCTURE_URL,
  JSON.stringify(colorWrite.map((call) => call.url)),
);
check(
  '结构里带的是自定义色',
  ((colorWrite[0]?.body?.blocks ?? []) as Record<string, unknown>[])[0]?.color === '#123456',
  JSON.stringify(colorWrite[0]?.body),
);

const markColor2 = calls.length;
await type(colorInput, 'rgb(1, 2, 3)');
await pressEnter(colorInput);
check('回车也能提交', blockOf(0).style.borderColor === 'rgb(1, 2, 3)', blockOf(0).style.borderColor);
check('非十六进制的字符串照收（颜色就是个 CSS 值）', writesSince(markColor2).length === 1);

const markColor3 = calls.length;
await blur(colorInput);
check('值没变就不发写请求（反复失焦不该刷草稿）', writesSince(markColor3).length === 0, JSON.stringify(writesSince(markColor3).map((call) => call.url)));

const markColor4 = calls.length;
(blockOf(0).querySelectorAll('.pe-swatch')[1] as HTMLButtonElement).click();
await nextTick();
check(
  '预设色照旧：点一下换色并关面板',
  blockOf(0).style.borderColor === '#4ac38a' && blockOf(0).querySelector('.pe-palette') === null,
  blockOf(0).style.borderColor,
);
check('预设色同样只发一次结构写', writesSince(markColor4).length === 1, JSON.stringify(writesSince(markColor4).map((call) => call.url)));

console.log('区块库：存一块 / 插入 / 改名 / 删除');
{
  // 存进库的只有**启用且非空**的条目（禁用的本来就不进输出），所以断言也得按这把尺子取
  const enabledChips = (blockIndex: number): string[] =>
    [...blockOf(blockIndex).querySelectorAll('.pe-chip:not(.pe-chip-off) > .pe-chip-text')]
      .map((el) => (el.textContent ?? '').trim())
      .filter((text) => text !== '');
  const blkLibBtn = pickAll('.pe-top .pe-actions button')[3] as HTMLButtonElement;
  check('表头有「区块库…」入口', (blkLibBtn.textContent ?? '').includes('区块库') === true, blkLibBtn.textContent ?? '');
  blkLibBtn.click();
  await settle();
  check('打开面板并拉到列表', pick('.pe-panel')?.textContent?.includes('区块库') === true && pick('.pe-blk-tip') !== null);
  check('空库给一句"怎么存"的提示', (pick('.pe-blk-tip')?.textContent ?? '').includes('点「存」') === true, pick('.pe-blk-tip')?.textContent ?? '');

  // 在区块表头点「存」：把这一块的快照送进面板
  const firstBlock = blockOf(0);
  const headSave = firstBlock.querySelector('.pe-block-save') as HTMLButtonElement;
  check('区块表头有「存」按钮', headSave !== null && (headSave.textContent ?? '').trim() === '存');
  const titleBefore = (firstBlock.querySelector('.pe-block-title') as HTMLInputElement).value;
  const chipsBefore = enabledChips(0);
  headSave.click();
  await settle();
  const nameBox = pick('.pe-blk-save .pe-input') as HTMLInputElement;
  check('点「存」后出现名字框，并**真的抢到焦点**（不然回车存不了、看着像没反应）', document.activeElement === nameBox, String(document.activeElement?.className ?? document.activeElement?.tagName));
  check('名字框预填区块标题', nameBox.value === titleBefore, nameBox.value);

  // 取消：待存的块收回去，输入框消失
  (pickAll('.pe-blk-save .pe-btn')[1] as HTMLButtonElement).click();
  await nextTick();
  check('点「取消」把待存的块收回去', pick('.pe-blk-save') === null && pick('.pe-blk-tip') !== null);

  // 叉掉面板 = 这次「存块」不作数：不然下次从「区块库…」进来还停在待存那一屏
  headSave.click();
  await settle();
  check('再点「存」：名字框又出来', pick('.pe-blk-save') !== null);
  (pick('.pe-close') as HTMLButtonElement).click();
  await nextTick();
  check('叉掉后面板关上了', pick('.pe-panel') === null);
  blkLibBtn.click();
  await settle();
  check(
    '叉掉后再打开区块库：是干净的面板（不是待存那一屏）',
    pick('.pe-blk-save') === null && pick('.pe-blk-tip') !== null,
    (pick('.pe-blk-save')?.textContent ?? pick('.pe-blk-tip')?.textContent ?? '').trim(),
  );

  // 真的存一次：先把这一块临时改成 2 条 + 1 条禁用，验证"禁用的不带进库"
  headSave.click();
  await settle();
  const markSave = calls.length;
  await type(pick('.pe-blk-save .pe-input') as HTMLInputElement, '我的质量块');
  (pickAll('.pe-blk-save .pe-btn')[0] as HTMLButtonElement).click();
  await settle();
  const posted = calls.slice(markSave).find((call) => call.method === 'POST' && call.url.endsWith('/block-presets'));
  check(
    '存进库：POST 带上整块快照（名字 / 标题 / 颜色 / 风格 / 条目文本）',
    posted?.body?.name === '我的质量块' &&
      posted?.body?.title === titleBefore &&
      typeof posted?.body?.color === 'string' &&
      posted?.body?.mode === 'tag',
    JSON.stringify(posted?.body),
  );
  check('条目文本跟着走（禁用的那条不带）', sameTexts((posted?.body?.items as string[]) ?? [], chipsBefore), `${JSON.stringify(posted?.body?.items)} vs ${JSON.stringify(chipsBefore)}`);
  check('存完列表里出现了它（带风格 / 条数）', pickAll('.pe-item-name').length === 1 && (pick('.pe-item-meta')?.textContent ?? '').includes('条'), pick('.pe-item-meta')?.textContent ?? '');

  // 条目默认收着；点一块才按 id 取整条铺出来（列表里只有摘要 + 前 3 条预览）
  const savedItems = (posted?.body?.items as string[]) ?? [];
  check('默认不展示条目（只有摘要和 ▸）', pick('.pe-item-tokens') === null && (pick('.pe-caret')?.textContent ?? '') === '▸', pick('.pe-caret')?.textContent ?? '（没有 ▸）');
  check(
    '展开开关在色点左边（跟名字同一行，不单占一行）',
    pick('.pe-item-name .pe-caret') !== null && (pick('.pe-caret')?.nextElementSibling?.className ?? '') === 'pe-blk-color',
    `caret 在名称行内：${pick('.pe-item-name .pe-caret') !== null}，下一个兄弟：${pick('.pe-caret')?.nextElementSibling?.className ?? '（无）'}`,
  );
  const markExpand = calls.length;
  (pick('.pe-item-head') as HTMLElement).click();
  await settle();
  check(
    '点开才按 id 取整条（列表里没有全部条目）',
    calls.slice(markExpand).some((call) => call.method === 'GET' && call.url.endsWith('/block-presets/bp1')) === true,
    JSON.stringify(calls.slice(markExpand).map((call) => `${call.method} ${call.url}`)),
  );
  check(
    '展开后铺出**全部**条目（不是摘要里那 3 条）',
    savedItems.length > 3 && sameTexts(pickAll('.pe-token').map((one) => one.textContent ?? ''), savedItems),
    `${pickAll('.pe-token').length} 条：${pickAll('.pe-token').map((one) => one.textContent).join('|')} vs ${savedItems.length} 条`,
  );
  check('▾ 跟着翻过来（还标了能收起）', (pick('.pe-caret')?.textContent ?? '') === '▾' && (pick('.pe-item-head')?.getAttribute('title') ?? '').includes('收起') === true);
  const markCollapse = calls.length;
  (pick('.pe-item-head') as HTMLElement).click();
  await settle();
  check('再点收起：条目收掉，也不再发请求', pick('.pe-item-tokens') === null && calls.slice(markCollapse).length === 0, `${calls.length - markCollapse} 个请求`);
  check('提示说清了存了什么', (pick('.pe-hint')?.textContent ?? '').includes('已存进区块库：「我的质量块」') === true, pick('.pe-hint')?.textContent ?? '');
  check('存完名字框收起来（一次存一块）', pick('.pe-blk-save') === null);

  // ── 浏览 / 编辑模式：管理入口只在编辑模式出现（跟词库面板同一套）──────────────
  const win = window as unknown as Record<string, unknown>;
  const realPrompt = win.prompt;
  const realConfirm = win.confirm;
  const catRows = (): HTMLElement[] => pickAll('.pe-catnav-row') as HTMLElement[];
  const catRowOf = (label: string): HTMLElement | undefined =>
    catRows().find((row) => (row.textContent ?? '').includes(label));
  const catLabels = (): string =>
    catRows()
      .map((row) => (row.querySelector('.pe-catnav-name')?.textContent ?? '').trim())
      .join('|');
  const modeBtn = (): HTMLButtonElement => pick('.pe-blk-mode') as HTMLButtonElement;
  // 编辑模式一开，行上的按钮集合就变了（浏览：插入；编辑：改名 / 删除），所以按文字找
  const itemBtn = (label: string): HTMLButtonElement => {
    const hit = pickAll('.pe-item-actions .pe-btn').find((one) => (one.textContent ?? '').trim() === label);
    if (hit === undefined) throw new Error(`行上没有「${label}」按钮`);
    return hit as HTMLButtonElement;
  };
  const catBtn = (row: HTMLElement, label: string): HTMLButtonElement => {
    const hit = [...row.querySelectorAll('.pe-catnav-op')].find((one) => (one.textContent ?? '').trim() === label);
    if (hit === undefined) throw new Error(`这一行没有「${label}」`);
    return hit as HTMLButtonElement;
  };
  const manageBtn = (label: string): HTMLButtonElement => {
    const hit = pickAll('.pe-catnav-btns .pe-btn').find((one) => (one.textContent ?? '').trim() === label);
    if (hit === undefined) throw new Error(`管理区没有「${label}」按钮`);
    return hit as HTMLButtonElement;
  };

  check('左栏钉着「全部」和「未分类」两行', catLabels() === '全部|未分类', catLabels());
  check('默认选中「全部」（进面板是来找块的，不是只看没归类的）', (pick('.pe-catnav-row.on')?.textContent ?? '').includes('全部') === true);
  check('「未分类」的计数是现算的（刚存的那块还没归类）', (catRows()[1]?.textContent ?? '').includes('1') === true, catRows()[1]?.textContent ?? '');
  (catRows()[1] as HTMLElement).click();
  await nextTick();
  check('点「未分类」只列没归类的块', pickAll('.pe-item').length === 1);
  (catRows()[0] as HTMLElement).click();
  await nextTick();

  // 浏览模式（默认）：只插不改
  check('默认是浏览模式', modeBtn().textContent?.includes('编辑模式：关') === true, modeBtn().textContent ?? '');
  check('浏览模式：行上只有「插入」', pickAll('.pe-item-actions .pe-btn').length === 1 && itemBtn('插入') !== null);
  check('浏览模式：行是只读的（不给拖）', pick('.pe-item')?.getAttribute('draggable') === 'false', String(pick('.pe-item')?.getAttribute('draggable')));
  check('浏览模式：左栏没有 ＋、也没有「改 / 删」', pick('.pe-catnav-new') === null && pickAll('.pe-catnav-op').length === 0);
  const markBrowse = calls.length;
  (catRows()[1] as HTMLElement).click();
  await settle();
  check('浏览模式点分类只是筛选，不发写请求', calls.slice(markBrowse).every((call) => call.method === 'GET') === true, JSON.stringify(calls.slice(markBrowse).map((call) => `${call.method} ${call.url}`)));
  (catRows()[0] as HTMLElement).click();
  await nextTick();

  modeBtn().click();
  await nextTick();
  check('切到编辑模式：左栏出现 ＋', modeBtn().textContent?.includes('编辑模式：开') === true && pick('.pe-catnav-new') !== null);
  check(
    '编辑模式：行上变成 改名 / 删除（「插入」收起来），并且能拖了',
    pickAll('.pe-item-actions .pe-btn').length === 2 && itemBtn('改名') !== null && pick('.pe-item')?.getAttribute('draggable') === 'true',
    String(pick('.pe-item')?.getAttribute('draggable')),
  );

  // 新建分类：左栏 ＋ → 就地输入 → 新建（不用 window.prompt）
  const markCatNew = calls.length;
  (pick('.pe-catnav-new') as HTMLButtonElement).click();
  await nextTick();
  const catInput = pick('.pe-catnav-input') as HTMLInputElement;
  check('点 ＋ 就地出现输入框，并**真的抢到焦点**', document.activeElement === catInput, String(document.activeElement?.className ?? document.activeElement?.tagName));
  check('名字还空着时「新建」是禁用的', manageBtn('新建').disabled === true);
  await type(catInput, ' 人物 ');
  manageBtn('新建').click();
  await settle();
  check(
    '新建分类：POST /block-categories，名字 trim 过',
    calls.slice(markCatNew).some((call) => call.method === 'POST' && call.url.endsWith('/block-categories') && call.body?.name === '人物') === true,
    JSON.stringify(calls.slice(markCatNew).map((call) => `${call.method} ${call.url}`)),
  );
  check('新分类挂在「未分类」后面，管理区收起来了', catLabels() === '全部|未分类|人物' && pick('.pe-catnav-manage') === null, catLabels());

  // 归类：把行拖到左栏的分类上（不再有下拉）
  check('编辑模式里也没有归类下拉了（改拖拽）', pick('.pe-item-actions .pe-select') === null);
  const markMove = calls.length;
  dispatch(pick('.pe-item') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  check(
    '拖着行的时候分类树整棵变成落点（「未分类」也在，「全部」不在）',
    pickAll('.pe-catnav-row[data-drop="ok"]').length === 2,
    String(pickAll('.pe-catnav-row[data-drop="ok"]').length),
  );
  const personRow = catRowOf('人物') as Element;
  dispatch(personRow, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  await nextTick();
  check('悬停的那一行亮成落点', (pick('.pe-catnav-drop')?.textContent ?? '').includes('人物') === true, pick('.pe-catnav-drop')?.textContent ?? '');
  dispatch(personRow, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  const movedCall = calls.slice(markMove).find((call) => call.method === 'PUT' && call.url.endsWith('/block-presets/bp1'));
  check('拖到分类上 = 归类（PUT 只带 categoryId）', JSON.stringify(movedCall?.body) === JSON.stringify({ categoryId: 'bc1' }), JSON.stringify(movedCall?.body ?? null));
  check(
    '归完类计数跟着走（人物 1 / 未分类 0）',
    (catRows()[2]?.textContent ?? '').includes('1') === true && (catRows()[1]?.textContent ?? '').includes('0') === true,
    `${catRows()[2]?.textContent} ${catRows()[1]?.textContent}`,
  );
  check(
    '行上出现分类小标签，落点收起来了',
    (pick('.pe-item-cat')?.textContent ?? '') === '人物' && pick('.pe-catnav-drop') === null,
    pick('.pe-item-cat')?.textContent ?? '',
  );

  // 拖回「未分类」= 摘掉归类（摘掉再归回去：后面的筛选用例还要它挂在「人物」上）
  const markClear = calls.length;
  dispatch(pick('.pe-item') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  const noneRow = catRows()[1] as Element;
  dispatch(noneRow, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  dispatch(noneRow, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  const cleared = calls.slice(markClear).find((call) => call.method === 'PUT' && call.url.endsWith('/block-presets/bp1'));
  check('拖到「未分类」= 摘掉归类（categoryId 空串）', JSON.stringify(cleared?.body) === JSON.stringify({ categoryId: '' }), JSON.stringify(cleared?.body ?? null));
  check('小标签跟着变回「未分类」', (pick('.pe-item-cat')?.textContent ?? '') === '未分类', pick('.pe-item-cat')?.textContent ?? '');

  dispatch(pick('.pe-item') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  dispatch(catRowOf('人物') as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  dispatch(catRowOf('人物') as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  check(
    '归回「人物」：计数回到 人物 1 / 未分类 0',
    (catRows()[2]?.textContent ?? '').includes('1') === true && (catRows()[1]?.textContent ?? '').includes('0') === true,
    `${catRows()[2]?.textContent} ${catRows()[1]?.textContent}`,
  );

  // 按分类筛
  (catRows()[2] as HTMLElement).click();
  await nextTick();
  check('选中分类：只列归到它的块', pickAll('.pe-item').length === 1 && (pick('.pe-item-name')?.textContent ?? '').includes('我的质量块') === true);
  (catRows()[1] as HTMLElement).click();
  await nextTick();
  check(
    '选中「未分类」：刚归类的那块不在了（空文案要说清是这个分类空）',
    pickAll('.pe-item').length === 0 && (pick('.pe-empty')?.textContent ?? '').includes('这个分类里还没有区块') === true,
    pick('.pe-empty')?.textContent ?? '',
  );
  (catRows()[0] as HTMLElement).click();
  await nextTick();
  check('选中「全部」：又都回来了', pickAll('.pe-item').length === 1);

  // 再建一个分类，用来验拖拽排序
  (pick('.pe-catnav-new') as HTMLButtonElement).click();
  await nextTick();
  await type(pick('.pe-catnav-input') as HTMLInputElement, '光照');
  manageBtn('新建').click();
  await settle();
  check('两个分类都在左栏', catLabels() === '全部|未分类|人物|光照', catLabels());

  // 拖拽排序：happy-dom 拿不到布局，dragover 一律按"插到这一行前面"算
  const markOrder = calls.length;
  dispatch(catRowOf('光照') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  dispatch(catRowOf('人物') as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  dispatch(catRowOf('人物') as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  const orderCall = calls.slice(markOrder).find((call) => call.method === 'PUT' && call.url.endsWith('/block-categories/order'));
  check('拖分类发一次 PUT /block-categories/order，带的是整列新顺序（按 id，不按名字）', JSON.stringify(orderCall?.body) === JSON.stringify({ ids: ['bc2', 'bc1'] }), JSON.stringify(orderCall?.body ?? null));
  check('分类顺序真的变了', catLabels() === '全部|未分类|光照|人物', catLabels());

  const markStill = calls.length;
  dispatch(catRowOf('光照') as Element, new window.DragEvent('dragstart', { bubbles: true }));
  dispatch(catRowOf('光照') as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  dispatch(catRowOf('光照') as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  check('拖回原位不发请求（不然每点一下都写一遍）', calls.slice(markStill).every((call) => !call.url.endsWith('/block-categories/order')) === true, JSON.stringify(calls.slice(markStill).map((call) => call.url)));

  // 改名：左栏「改」→ 就地输入 → 改名
  const markCatRename = calls.length;
  catBtn(catRowOf('光照') as HTMLElement, '改').click();
  await nextTick();
  const renameInput = pick('.pe-catnav-input') as HTMLInputElement;
  check('点「改」后输入框里是现在的名字（并抢到焦点）', renameInput.value === '光照' && document.activeElement === renameInput, renameInput.value);
  await type(renameInput, '改过的分类');
  manageBtn('改名').click();
  await settle();
  const catRenamed = calls.slice(markCatRename).find((call) => call.method === 'PUT' && call.url.endsWith('/block-categories'));
  check('改分类名：PUT 带 id + 新名字（按 id 走，所以跟别的分类重名也行）', JSON.stringify(catRenamed?.body) === JSON.stringify({ id: 'bc2', name: '改过的分类' }), JSON.stringify(catRenamed?.body ?? null));
  check('左栏跟着变', catLabels() === '全部|未分类|改过的分类|人物', catLabels());

  // 删分类：先摆影响范围再确认；块回到未分类，块一条不删
  const markCatDel = calls.length;
  catBtn(catRowOf('人物') as HTMLElement, '删').click();
  await nextTick();
  check('删分类前说清影响几块（块本身一条不删）', (pick('.pe-catnav-warn')?.textContent ?? '').includes('1 块会变成未分类') === true, pick('.pe-catnav-warn')?.textContent ?? '');
  check('确认前一个写请求都不发', calls.slice(markCatDel).every((call) => call.method === 'GET') === true, JSON.stringify(calls.slice(markCatDel).map((call) => `${call.method} ${call.url}`)));
  manageBtn('确认删除').click();
  await settle();
  const catDeleted = calls.slice(markCatDel).find((call) => call.method === 'DELETE' && call.url.endsWith('/block-categories'));
  check('删分类：DELETE 带的是分类 id', JSON.stringify(catDeleted?.body) === JSON.stringify({ id: 'bc1' }), JSON.stringify(catDeleted?.body ?? null));
  check(
    '删完分类没了、块回到未分类（块数不变）',
    catLabels() === '全部|未分类|改过的分类' && pickAll('.pe-item').length === 1 && (catRows()[1]?.textContent ?? '').includes('1') === true,
    `${catLabels()} / ${pickAll('.pe-item').length}`,
  );

  // 库内排序：拖行到行上（只有「全部」视图给排）。先再存一块 —— 一行看不出排序
  (blockOf(1).querySelector('.pe-block-save') as HTMLButtonElement).click();
  await settle();
  await type(pick('.pe-blk-save .pe-input') as HTMLInputElement, '第二条');
  (pickAll('.pe-blk-save .pe-btn')[0] as HTMLButtonElement).click();
  await settle();
  check(
    '库里现在两块，新的排在后面',
    pickAll('.pe-item').length === 2 && (pickAll('.pe-item-title')[1]?.textContent ?? '') === '第二条',
    pickAll('.pe-item-title').map((one) => one.textContent).join('|'),
  );

  const markSort = calls.length;
  dispatch(pickAll('.pe-item')[1] as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  await nextTick();
  check('拖到另一行上：出现插入位置的横线', pick('.pe-item-over-before') !== null, String(pickAll('.pe-item-over-before').length));
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  const sortCall = calls.slice(markSort).find((call) => call.method === 'PUT' && call.url.endsWith('/block-presets/order'));
  check('排序：PUT /block-presets/order 带整列新顺序（按 id）', JSON.stringify(sortCall?.body) === JSON.stringify({ ids: ['bp2', 'bp1'] }), JSON.stringify(sortCall?.body ?? null));
  check(
    '列表顺序真的换了',
    (pickAll('.pe-item-title')[0]?.textContent ?? '') === '第二条',
    pickAll('.pe-item-title').map((one) => one.textContent).join('|'),
  );

  // 拖了一下又放回原处：位置没变就不写盘
  const markSortStill = calls.length;
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  await settle();
  check('拖回原位不发请求', calls.slice(markSortStill).every((call) => !call.url.endsWith('/block-presets/order')) === true, JSON.stringify(calls.slice(markSortStill).map((call) => call.url)));

  // 筛过的视图不给排：新顺序是相对子集说的，落盘必然错位
  // （分类用例把「人物」删了，所以挑「未分类」—— 这会儿两块都在里面）
  (catRows()[1] as HTMLElement).click();
  await nextTick();
  check('未分类视图里两块都在（这样拖才有意义）', pickAll('.pe-item').length === 2, String(pickAll('.pe-item').length));
  const markFiltered = calls.length;
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('dragstart', { bubbles: true }));
  await nextTick();
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('dragover', { bubbles: true, cancelable: true }));
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('drop', { bubbles: true, cancelable: true }));
  dispatch(pickAll('.pe-item')[0] as Element, new window.DragEvent('dragend', { bubbles: true }));
  await settle();
  check('筛过分类的视图里不给拖排序（不发 /order）', calls.slice(markFiltered).every((call) => !call.url.endsWith('/block-presets/order')) === true, JSON.stringify(calls.slice(markFiltered).map((call) => call.url)));
  (catRows()[0] as HTMLElement).click();
  await nextTick();

  // 第二块只是为排序造的：删掉，后面的改名 / 删除用例还是只针对第一块（按 id 断言）
  // 删除要两步（行上先点「删除」，再点「确认删除」）：没有浏览器弹窗
  itemBtn('删除').click();
  await nextTick();
  itemBtn('确认删除').click();
  await settle();
  check(
    '第二块删掉，列表恢复成一块',
    pickAll('.pe-item').length === 1 && (pickAll('.pe-item-title')[0]?.textContent ?? '') !== '第二条',
    pickAll('.pe-item-title').map((one) => one.textContent).join('|'),
  );

  // 存块归到哪：跟着左栏选中的分类走（那一行不再有下拉 —— 块还没进列表，没地方拖）
  (catRows()[2] as HTMLElement).click();
  await nextTick();
  (blockOf(1).querySelector('.pe-block-save') as HTMLButtonElement).click();
  await settle();
  check(
    '存块那一行说清会存到哪一堆（跟着左栏走）',
    (pick('.pe-blk-target')?.textContent ?? '').includes('改过的分类') === true,
    pick('.pe-blk-target')?.textContent ?? '',
  );
  check('那一行没有下拉了', pick('.pe-blk-save .pe-select') === null);
  const markSaveCat = calls.length;
  await type(pick('.pe-blk-save .pe-input') as HTMLInputElement, '归过去的块');
  (pickAll('.pe-blk-save .pe-btn')[0] as HTMLButtonElement).click();
  await settle();
  const savedInto = calls.slice(markSaveCat).find((call) => call.method === 'POST' && call.url.endsWith('/block-presets'));
  check('存的请求就带着这个分类', savedInto?.body?.categoryId === 'bc2', JSON.stringify(savedInto?.body ?? null));
  check('存完就在这个分类里（左栏正筛着它）', pickAll('.pe-item').length === 1 && (pick('.pe-item-cat')?.textContent ?? '') === '改过的分类', pick('.pe-item-cat')?.textContent ?? '');
  itemBtn('删除').click();
  await nextTick();
  itemBtn('确认删除').click();
  await settle();
  (catRows()[0] as HTMLElement).click();
  await nextTick();

  // 切回浏览模式：管理入口和归类下拉一起收掉
  modeBtn().click();
  await nextTick();
  check(
    '退出编辑模式：＋ 收起来、行又不能拖了、只剩「插入」',
    pick('.pe-catnav-new') === null && pick('.pe-item')?.getAttribute('draggable') === 'false' && pickAll('.pe-item-actions .pe-btn').length === 1,
  );

  win.prompt = realPrompt;
  win.confirm = realConfirm;

  // 插入：新增一块、追加到最后（浏览模式的唯一动作）
  const blocksBefore = pickAll('.pe-block').length;
  const batchesBeforeBlock = translateBatches.length;
  const markInsert = calls.length;
  itemBtn('插入').click();
  await settle();
  check('插入前先按 id 取整条（列表里只有摘要）', calls.slice(markInsert).some((call) => call.method === 'GET' && call.url.endsWith('/block-presets/bp1')) === true, JSON.stringify(calls.slice(markInsert).map((call) => call.url)));
  check('插入 = 新增一块、追加到最后（已有区块一个不动）', pickAll('.pe-block').length === blocksBefore + 1 && blockOf(blocksBefore) !== null);
  check('新块的标题 = 预设的标题', (blockOf(blocksBefore).querySelector('.pe-block-title') as HTMLInputElement).value === titleBefore, (blockOf(blocksBefore).querySelector('.pe-block-title') as HTMLInputElement).value);
  check('新块的条目 = 预设里那些文本', sameTexts(enabledChips(blocksBefore), chipsBefore), `${enabledChips(blocksBefore).join('|')} vs ${chipsBefore.join('|')}`);
  check('新块的风格跟着预设走（tag）', (blockOf(blocksBefore).querySelector('.pe-block-modes button.active')?.textContent ?? '').trim() === 'tag');
  check(
    '新块的译文是空的（库里不带译文，等你自己查）',
    blockOf(blocksBefore).querySelector('.pe-chip-translation-empty') !== null,
    cellText(blocksBefore, 0),
  );
  check('插入也发了一次结构写（新块要落盘）', calls.slice(markInsert).some((call) => call.method === 'PUT' && call.url.endsWith('/draft/structure')) === true);

  // 插进来的条目没有译文（库里刻意不存）→ 自动译开着的话要排队去翻，跟手打一条新条目同一条路
  await new Promise((resolve) => setTimeout(resolve, 600));
  const autoBatches = translateBatches.slice(batchesBeforeBlock);
  check(
    '插入的块自动排队翻译（自动译开着，逐条发）',
    autoBatches.length === chipsBefore.length && sameTexts(autoBatches.map((one) => one[0] ?? ''), chipsBefore),
    JSON.stringify(autoBatches),
  );
  check('翻完译文落到格子里', cellText(blocksBefore, 0) !== '' && cellText(blocksBefore, 0) !== '译文', cellText(blocksBefore, 0));

  // 改名 / 删除：就地编辑（跟词库一致，没有 window.prompt / window.confirm），只在编辑模式里出现
  modeBtn().click();
  await nextTick();
  check('再进编辑模式：行上是改名 / 删除', modeBtn().textContent?.includes('编辑模式：开') === true && itemBtn('改名') !== null);
  const markRename = calls.length;
  itemBtn('改名').click();
  await nextTick();
  const rowRenameInput = pick('.pe-item-rename') as HTMLInputElement | null;
  check('改名是就地的：行上出现输入框，带着原名', rowRenameInput !== null && rowRenameInput.value === '我的质量块', rowRenameInput?.value ?? '（没有输入框）');
  check('改名框自己抢焦点（不抢的话敲键盘没反应）', document.activeElement === rowRenameInput, String(document.activeElement?.className ?? document.activeElement?.tagName));
  await type(rowRenameInput as HTMLInputElement, '改过的名字');
  itemBtn('改名').click();
  await settle();
  const renamed = calls.slice(markRename).find((call) => call.method === 'PUT' && call.url.includes('/block-presets/'));
  check('改名：PUT 只带名字', renamed?.body?.name === '改过的名字' && Object.keys(renamed?.body ?? {}).length === 1, JSON.stringify(renamed?.body));
  check('改名后列表里就是新名字', (pick('.pe-item-name')?.textContent ?? '').includes('改过的名字') === true, pick('.pe-item-name')?.textContent ?? '');
  check('提交后输入框收起来了', pick('.pe-item-rename') === null);

  // 改名点取消：输入框收掉，一个请求都不发
  const markNoop = calls.length;
  itemBtn('改名').click();
  await nextTick();
  itemBtn('取消').click();
  await settle();
  check('改名点取消：不发请求、名字不动', calls.slice(markNoop).length === 0 && (pick('.pe-item-name')?.textContent ?? '').includes('改过的名字') === true, `${calls.length - markNoop} 个请求`);

  // 名字没改就直接点「改名」：不发请求（不然白写一次盘）
  const markSame = calls.length;
  itemBtn('改名').click();
  await nextTick();
  itemBtn('改名').click();
  await settle();
  check('名字没变时不发请求', calls.slice(markSame).length === 0, String(calls.length - markSame));

  // 删除：先「删除」再「确认删除」（两步，没有浏览器弹窗）
  itemBtn('删除').click();
  await nextTick();
  const markDel = calls.length;
  check('点「删除」只是摆出确认，还没删', itemBtn('确认删除') !== null && calls.slice(markDel).length === 0);
  itemBtn('取消').click();
  await nextTick();
  const rowBtnLabels = (): string[] => pickAll('.pe-item-actions .pe-btn').map((one) => (one.textContent ?? '').trim());
  check('删确认能取消：按钮退回「改名 / 删除」', rowBtnLabels().join('|') === '改名|删除', rowBtnLabels().join('|'));
  itemBtn('删除').click();
  await nextTick();
  itemBtn('确认删除').click();
  await settle();
  check(
    '删除：DELETE 打的是这一条的 id',
    calls.slice(markDel).some((call) => call.method === 'DELETE' && call.url.endsWith('/block-presets/bp1')) === true,
    JSON.stringify(calls.slice(markDel).map((call) => `${call.method} ${call.url}`)),
  );
  check('删完库空了（工作区那块不受影响）', pickAll('.pe-item-name').length === 0 && pick('.pe-empty') !== null);
  win.prompt = realPrompt;
  win.confirm = realConfirm;

  (pick('.pe-close') as HTMLButtonElement).click();
  await nextTick();
  check('面板能关掉', pick('.pe-panel') === null);
}

// ── 跨域调用：把输出填进 anima-plus 的描述提示词，并向它发起一次出图 ──────────
console.log('跨域调用（输出 → anima-plus）');
{
  await settle();
  const runButton = (): HTMLButtonElement => pick('.pe-cross-run') as HTMLButtonElement;
  const panelText = (selector: string): string => (pick(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

  check('输出下面挂着跨域调用区', pick('.pe-cross') !== null && runButton() !== null);
  check('认出了下游是 anima-plus', panelText('.pe-cross-name').includes('anima-plus'), panelText('.pe-cross-name'));
  check(
    '参数摘要是对方最后一次状态（模型名只取路径末段）',
    panelText('.pe-cross-params').includes('b1V23Base_fp16.safetensors') &&
      panelText('.pe-cross-params').includes('832×1216') &&
      panelText('.pe-cross-params').includes('LoRA 1 条'),
    panelText('.pe-cross-params'),
  );
  check('种子策略写在摘要里（每次重抽）', panelText('.pe-cross-params').includes('每次重抽'), panelText('.pe-cross-params'));

  const mark = calls.length;
  const sentText = output();
  runButton().click();
  await settle(20);
  const wrote = calls
    .slice(mark)
    .find((call) => call.method === 'PUT' && call.url.endsWith('/api/p/anima-plus/api/state'));
  const posted = calls
    .slice(mark)
    .find((call) => call.method === 'POST' && call.url.endsWith('/api/p/anima-plus/api/jobs'));
  const sent = posted?.body?.values as Record<string, unknown> | undefined;
  check('提交的值里 prompt 就是输出', sent?.prompt === sentText && sentText !== '', String(sent?.prompt));
  check(
    '基底没被改：模型 / 尺寸 / 步数都来自对方的 last-state',
    sent?.unet_name === 'Anima\\0.26.9.12.NAI.RDBT  Anima.b1V23Base_fp16.safetensors' &&
      sent?.width === 832 &&
      sent?.height === 1216 &&
      sent?.steps === 6,
  );
  check(
    'randomSeed 开着 → 提交的是新抽的种子',
    typeof sent?.seed === 'number' && sent.seed !== 421066625562399,
    String(sent?.seed),
  );
  check(
    '写回对方快照的那一份与提交的是同一份',
    wrote !== undefined && JSON.stringify(wrote.body?.values) === JSON.stringify(sent),
  );
  check(
    '回执：作业号 + 排队位 + 这次用的种子',
    panelText('.pe-cross-receipt').includes('job1') &&
      panelText('.pe-cross-receipt').includes('排队第 2 位') &&
      panelText('.pe-cross-receipt').includes(String(sent?.seed)),
    panelText('.pe-cross-receipt'),
  );
  check(
    '回执里给了去 anima-plus 看进度的链接',
    (pick('.pe-cross-link') as HTMLAnchorElement | null)?.getAttribute('href') === '/w/anima-plus',
  );
  check(
    '提交完对方那份快照里的提示词也换成了这次输出',
    fakeAnimaState.values.prompt === sentText,
    String(fakeAnimaState.values.prompt),
  );

  // 对方还没跑过一次：没有参数基底，按钮禁用并把原因说出来
  fakeAnimaState = { values: {}, savedAt: null };
  (pick('.pe-cross-refresh') as HTMLButtonElement).click();
  await settle();
  check('没有「最后一次状态」时按钮禁用', runButton().disabled === true);
  check('并且说清了为什么', panelText('.pe-cross-hint').includes('最后一次状态'), panelText('.pe-cross-hint'));

  // 对方没装载（或没点重扫）：同样禁用，但原因是另一回事
  fakePlugins = fakePlugins.filter((one) => one.id !== 'anima-plus');
  (pick('.pe-cross-refresh') as HTMLButtonElement).click();
  await settle();
  check('下游不在宿主清单里时说清是没装载', panelText('.pe-cross-hint').includes('重新扫描'), panelText('.pe-cross-hint'));
  check('探测结果也写在面板上', panelText('.pe-cross-status').includes('宿主里没有'), panelText('.pe-cross-status'));
}

console.log(failed === 0 ? '\n✅ 交互测试通过' : `\n❌ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
