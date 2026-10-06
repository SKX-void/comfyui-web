/**
 * prompt-editor —— 纯编写类 tab（**不负责绘图**）。
 *
 * 前端是主角（区块式工作区 + tag/自然语言两种切分视图 + 纯文本输出）。
 * 服务端只做一件事：把「预设库」和「当前草稿」落在插件自己的空间里 ——
 * 存储形态自管（D12），核不参与、不迁移、不清理。
 *
 * 只 import node 内置模块，**不 import cordis**：宿主已经把 cordis 打进自己的产物，
 * 插件再引一份就是两个实例。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'prompt-editor';

export const inject = ['routes', 'space'];

const ID = 'prompt-editor';
/** 空间按**包名**分配，所以这里必须写本插件的包名 */
const PACKAGE = '@comfyui-web/prompt-editor';
const PRESETS_FILE = 'presets.json';
const DRAFT_FILE = 'draft.json';

/** 上限：自用工具也要防「一个坏请求 / 手改坏的文件」把 UI 撑爆 */
const LIMITS = {
  presets: 300,
  name: 120,
  blocks: 200,
  items: 5000,
  itemText: 4000,
  title: 200,
  color: 32,
  translation: 4000,
  category: 24,
  categories: 12,
  aliases: 16,
};

const MODES = new Set(['tag', 'text']);
/** 兜底色：结构写入还没落地时给区块垫的默认色（与前端调色板第一格一致） */
const DEFAULT_COLOR = '#6ea8fe';

// ===========================================================================
// 1. 形状收敛：盘上的、请求里的数据都不信任，一律过一遍
// ===========================================================================

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function id(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, 64) : randomUUID();
}

function sanitizeItems(input) {
  return (Array.isArray(input) ? input.slice(0, LIMITS.items) : [])
    .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      id: id(item.id),
      text: text(item.text, LIMITS.itemText),
      // 缺省是「启用」：手写一份预设时不该因为漏字段就整块被吞掉
      enabled: item.enabled !== false,
      translation: text(item.translation, LIMITS.translation),
      // 译文来源：'' 未知/无译文 · api 现翻（没进词库）· dict 词库命中 · user 手改或存过
      source: ITEM_SOURCES.has(item.source) ? item.source : (LEGACY_ITEM_SOURCES[item.source] ?? ''),
    }));
}

/** 区块的「属性」（不含条目）：标题 / 颜色 / 风格。顺序由数组本身表达 */
function sanitizeBlockMeta(block, fallbackMode) {
  return {
    id: id(block.id),
    title: text(block.title, LIMITS.title),
    color: text(block.color, LIMITS.color),
    mode: MODES.has(block.mode) ? block.mode : fallbackMode,
  };
}

/** 把任意输入收敛成一份 Doc；形状不对（比如整个不是对象）返回 null */
export function sanitizeDoc(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const blocks = Array.isArray(input.blocks) ? input.blocks.slice(0, LIMITS.blocks) : [];
  // 风格现在挂在区块上；`input.mode` 是早期"全局风格"版本的字段，留着当老预设/老草稿的兜底
  const legacyMode = MODES.has(input.mode) ? input.mode : 'tag';
  return {
    version: 1,
    blocks: blocks
      .filter((block) => block !== null && typeof block === 'object' && !Array.isArray(block))
      .map((block) => ({ ...sanitizeBlockMeta(block, legacyMode), items: sanitizeItems(block.items) })),
  };
}

// ===========================================================================
// 2. 草稿在盘上分两段：组结构（顺序 + 属性）与条目（按区块 id 分组）
//
// 拆开是为了**一次编辑只写一段**：改区块属性只动结构（O(区块数)，不含条目），
// 某个区块编辑完只动它自己的条目（O(该区块条目数)）。
// 整份 doc 一起写的话，改一个字就要把全文档重新序列化+传一遍，放大太厉害。
// ===========================================================================

/** 盘上的草稿 → { structure, items }；老格式（条目直接挂在 block.items 上）也认 */
export function storedFromRaw(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, LIMITS.blocks) : [];
  const grouped = raw.items !== null && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {};
  const legacyMode = MODES.has(raw.mode) ? raw.mode : 'tag';
  const structure = [];
  const items = {};
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const meta = sanitizeBlockMeta(block, legacyMode);
    structure.push(meta);
    items[meta.id] = sanitizeItems(Array.isArray(block.items) ? block.items : grouped[meta.id]);
  }
  return { structure, items };
}

export function rawFromStored(stored) {
  return { version: 1, blocks: stored.structure, items: stored.items };
}

/** { structure, items } → Doc（GET /draft 回给前端的就是它） */
export function docFromStored(stored) {
  return {
    version: 1,
    blocks: stored.structure.map((meta) => ({ ...meta, items: stored.items[meta.id] ?? [] })),
  };
}

/** Doc → { structure, items }（整份替换：载入预设 / 清空） */
export function storedFromDoc(doc) {
  const items = {};
  for (const block of doc.blocks) items[block.id] = block.items;
  return { structure: doc.blocks.map(({ items: _items, ...meta }) => meta), items };
}

function sanitizePreset(input) {  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const doc = sanitizeDoc(input.doc);
  if (doc === null) return null;
  return {
    id: id(input.id),
    name: text(input.name, LIMITS.name) || '未命名预设',
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
    doc,
  };
}

// ===========================================================================
// 2. 落盘：整文件 JSON + 原子替换
// ===========================================================================

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 不存在 / 读坏了都退化成默认值：这里没有"必须炸"的理由，坏文件不该让 tab 起不来
    return fallback;
  }
}

/** 先写临时文件再 rename：进程在写一半时被杀，旧文件仍然完整 */
function writeJson(file, value) {
  // 目录可能被人手动删掉（docs/config.md 就把"删掉＝回到默认"写成用法）——
  // 不补建的话运行期每次写都是 500，得重挂插件才好
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

// ===========================================================================
// 2.5 翻译：权重语法掩码 → 词库 → provider（固定 en→zh）
// ===========================================================================

const TAGS_FILE = 'tags.json';
/** 老词库：只有 { entries } 平表（en/zh/source），没有分类和别名。读到它就迁进 tags.json，原文件留着不删 */
const LEGACY_DICT_FILE = 'dict.json';
const SETTINGS_FILE = 'settings.json';
const USAGE_FILE = 'usage.json';

/** 词条来源：user = 手动入库的（手改 / 显式存过，导入不许覆盖它）· import = 导入的 · builtin = 内置的 */
const TAG_SOURCES = new Set(['user', 'import', 'builtin']);
/** 老数据里的 `api`（机器现翻写进去的）归到 import：都不是人认可的，面板里能一键清掉 */
const LEGACY_TAG_SOURCES = { api: 'import' };
/** 条目译文的来源标记（前端画「我 / 库 / 机」用，见 client/src/model.ts 的 ItemSource） */
/**
 * 条目来源只有两态：`dict` = 这条译文在词库里 · `api` = 机器现翻的、还没进库。
 * （徽章只说"在不在库里" —— "谁写的"不再区分：手改的、词库命中的、点「机」存过的，都在库里。）
 */
const ITEM_SOURCES = new Set(['api', 'dict']);
/** 老草稿里的 `user`（手改的）折进 `dict` */
const LEGACY_ITEM_SOURCES = { user: 'dict' };

const DEFAULT_SETTINGS = {
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  // 两次 provider 调用之间的最小间隔。实测体验版约 6 次/窗口就回 errorCode 411
  // 「请求频率过快」（间隔 1.5s 也救不了，6s 连打 8 次全过），所以默认压到 6s。
  minIntervalMs: 6000,
};

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 权重语法掩码：MT 接口不认识 `(masterpiece:1.2)` 这种写法，整条丢过去会翻出
 * `（杰作：1.2）` 之类直接不能用的东西。所以先把"要翻的词"剥出来，翻完按原样贴回。
 *
 * 认 `(x)` `(x:1.2)` `[x]` `[x:1.2]` `{a|b}` `x:1.2`；`<lora:...>` 跳过
 * （模型名是标识符，翻了就废）。认不出来就整条当普通文本翻。
 */
export function maskPromptSyntax(input) {
  const text = String(input ?? '').trim();
  if (text === '') return { parts: [], rebuild: () => '' };
  if (text.startsWith('<') && text.endsWith('>')) return { skip: true, parts: [], rebuild: () => text };

  const first = text[0];
  const last = text[text.length - 1];
  const closer = { '(': ')', '[': ']', '{': '}' }[first];

  if (closer === last) {
    const inner = text.slice(1, -1).trim();
    if (first === '{') {
      const parts = inner.split('|').map((part) => part.trim());
      if (parts.length > 1 && parts.every((part) => part !== '')) {
        return { parts, rebuild: (translated) => `{${translated.join('|')}}` };
      }
    } else {
      const weighted = /^(.*?):([\d.]+)$/.exec(inner);
      const word = (weighted === null ? inner : weighted[1]).trim();
      // 词里还带冒号说明是 `[a:b:0.5]` 这类交替语法，结构我们没解析，别硬翻
      if (word !== '' && !word.includes(':')) {
        const weight = weighted === null ? '' : `:${weighted[2]}`;
        return { parts: [word], rebuild: (translated) => `${first}${translated[0] ?? word}${weight}${last}` };
      }
    }
  }

  // 裸的 `tag:1.2`：只在完全没有空格时才认，免得把 "time: 5" 这种句子切坏
  const bare = /^([^\s:]+):([\d.]+)$/.exec(text);
  if (bare !== null) {
    return { parts: [bare[1]], rebuild: (translated) => `${translated[0] ?? bare[1]}:${bare[2]}` };
  }

  return { parts: [text], rebuild: (translated) => translated[0] ?? text };
}

/**
 * 词库键：tag 大小写不敏感（`1Girl` 和 `1girl` 是同一条），空白折叠。
 * 正名键和别名键都用它归一化，查表才能一次命中。
 */
export function tagKey(input) {
  return String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 字符串数组收敛：去空、去重、截断、限个数。不是数组就返回 null（调用方好区分"没给"和"给了空的"） */
function strList(value, max, itemMax) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    const one = typeof item === 'string' ? item.trim().slice(0, itemMax) : '';
    if (one !== '' && !out.includes(one)) out.push(one);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 词库（`tags.json`）：**一张表两用** —— 翻译按 `en` / `aliases` 命中，面板按 `categories` 分组。
 *
 * 同时吃两种形状：新版 `{ version:2, entries }`（带 categories/aliases）和老的 `dict.json`
 * 平表（只有 en/zh/source）—— 迁移就是"把老文件过一遍这个函数再写到新文件名"。
 */
export function sanitizeTags(input) {
  const entries = {};
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input.entries : null;
  if (raw === null || typeof raw !== 'object') return { version: 2, entries, aliasIndex: {} };
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') continue;
    const normalized = tagKey(key);
    const zh = typeof value.zh === 'string' ? value.zh.trim().slice(0, LIMITS.translation) : '';
    if (normalized === '' || zh === '') continue;
    const en = typeof value.en === 'string' && value.en.trim() !== '' ? value.en.trim() : key;
    entries[normalized] = {
      en: en.slice(0, LIMITS.itemText),
      zh,
      categories: strList(value.categories, LIMITS.categories, LIMITS.category) ?? [],
      aliases: strList(value.aliases, LIMITS.aliases, LIMITS.itemText) ?? [],
      source: TAG_SOURCES.has(value.source) ? value.source : (LEGACY_TAG_SOURCES[value.source] ?? 'import'),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    };
  }
  return { version: 2, entries, aliasIndex: buildAliasIndex(entries) };
}

/**
 * 别名索引（派生数据，每次收敛时重算，别手改）：别名键 → 正名键。
 * 正名自己在表里、或别名就是另一个正名时，以正名为准（别名不该把正名顶掉）。
 */
function buildAliasIndex(entries) {
  const index = {};
  for (const [key, entry] of Object.entries(entries)) {
    for (const alias of entry.aliases) {
      const aliasKey = tagKey(alias);
      if (aliasKey === '' || aliasKey === key || entries[aliasKey] !== undefined) continue;
      if (index[aliasKey] === undefined) index[aliasKey] = key;
    }
  }
  return index;
}

/** 查词库：先按正名，再按别名。命中返回词条（调用方只关心"在不在库里"，所以 user/dict 都算在库） */
export function tagsLookup(tags, text) {
  const key = tagKey(text);
  if (key === '') return null;
  const entry = tags?.entries?.[key];
  if (entry !== undefined) return entry;
  const canonical = tags?.aliasIndex?.[key];
  return canonical === undefined ? null : (tags.entries[canonical] ?? null);
}

/**
 * 写一条 / 改一条。**手改的（`source:'user'`）永不被非 user 的写入覆盖** ——
 * 用户改过的就是最终答案，不然下一次自动译会把他刚改的译文又冲掉。
 *
 * 只给 `en` 时（面板里改分类 / 别名）其余字段沿用原值：局部更新不该把译文抹掉。
 */
export function upsertTag(tags, patch, now = Date.now()) {
  const en = String(patch?.en ?? patch?.text ?? '').trim();
  const key = tagKey(en);
  if (key === '') return null;
  const current = tags.entries[key];
  const asked = typeof patch?.zh === 'string' ? patch.zh : (typeof patch?.translation === 'string' ? patch.translation : '');
  const zh = asked.trim() === '' ? (current?.zh ?? '') : asked.trim();
  if (zh === '') return null;
  // 不给 source 就沿用原值（面板里只改分类时不该把"导入的"提升成"我认可的"），新条目默认 user
  const source = TAG_SOURCES.has(patch?.source) ? patch.source : (current?.source ?? 'user');
  if (current !== undefined && current.source === 'user' && source !== 'user') return null;
  tags.entries[key] = {
    en: en.slice(0, LIMITS.itemText),
    zh: zh.slice(0, LIMITS.translation),
    categories: strList(patch?.categories, LIMITS.categories, LIMITS.category) ?? current?.categories ?? [],
    aliases: strList(patch?.aliases, LIMITS.aliases, LIMITS.itemText) ?? current?.aliases ?? [],
    source,
    updatedAt: now,
  };
  tags.aliasIndex = buildAliasIndex(tags.entries);
  return tags.entries[key];
}

/** 删一条。返回是否真删掉了 */
export function removeTag(tags, en) {
  const key = tagKey(en);
  if (key === '' || tags.entries[key] === undefined) return false;
  delete tags.entries[key];
  tags.aliasIndex = buildAliasIndex(tags.entries);
  return true;
}

/** 面板用：搜索（en / zh / 别名）+ 按分类筛 + 分类计数。分类 `__none__` = 未分类 */
export function queryTags(tags, options = {}) {
  const needle = String(options.q ?? '').trim().toLowerCase();
  const category = String(options.category ?? '');
  const limit = clampInt(options.limit, 1, 1000, 200);

  const all = Object.entries(tags.entries).map(([key, entry]) => ({ key, ...entry }));
  const counts = { total: all.length, uncategorized: 0 };
  const byCategory = new Map();
  for (const entry of all) {
    if (entry.categories.length === 0) counts.uncategorized += 1;
    for (const name of entry.categories) byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
  }

  const filtered = all.filter((entry) => {
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
  // 最近改的排前面：刚存进去的那条应该立刻看得见
  filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.en.localeCompare(b.en));

  return {
    tags: filtered.slice(0, limit),
    total: filtered.length,
    counts,
    categories: [...byCategory.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

export function sanitizeSettings(input) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    provider: Object.hasOwn(PROVIDERS, raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider,
    autoTranslate: raw.autoTranslate === undefined ? DEFAULT_SETTINGS.autoTranslate : raw.autoTranslate === true,
    maxCallsPerDay: clampInt(raw.maxCallsPerDay, 0, 100000, DEFAULT_SETTINGS.maxCallsPerDay),
    timeoutMs: clampInt(raw.timeoutMs, 1000, 30000, DEFAULT_SETTINGS.timeoutMs),
    minIntervalMs: clampInt(raw.minIntervalMs, 0, 60000, DEFAULT_SETTINGS.minIntervalMs),
  };
}

/** 用量按天记：跨天自动清零，免得昨天烧完的配额今天还算在头上 */
export function sanitizeUsage(input, today) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  if (raw.date !== today) return { date: today, calls: 0 };
  return { date: today, calls: clampInt(raw.calls, 0, 1000000, 0) };
}

const YOUDAO_URL = 'https://aidemo.youdao.com/trans';
/** 撞上限流后退避多久（毫秒），第 n 次重试等 BACKOFF * 2^(n-1) */
const RATE_LIMIT_BACKOFF_MS = 20000;
const RATE_LIMIT_RETRIES = 2;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 全局节流：记"上一次真的打出去"的时刻。**跨请求、跨批次都算**——
 * 前端逐条发也一样，节流放在这里才是唯一说了算的地方。
 * 重挂插件会重置（模块级状态），这是可接受的：它只是限速，不是账本。
 */
let youdaoLastCallAt = 0;

/**
 * 打一次有道体验版。限流不走 HTTP 状态码（HTTP 一直是 200），
 * 而是在 body 里回 `{ errorCode: 411, msg: '请求频率过快' }` —— 所以必须读 body。
 * 限流错误挂 `rateLimited: true`，交给上层决定退避重试。
 */
async function youdaoOnce(text, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(YOUDAO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: text.slice(0, 1000), from: 'en', to: 'zh-CHS' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.ok !== true) {
    const error = new Error(`有道返回 HTTP ${response.status}`);
    error.rateLimited = response.status === 429 || response.status === 503;
    throw error;
  }
  const json = await response.json();
  const code = String(json.errorCode ?? '');
  if (code === '411') {
    const error = new Error('有道限流：请求频率过快');
    error.rateLimited = true;
    throw error;
  }
  if (code !== '0') throw new Error(`有道返回错误码 ${code}`);
  const translation = Array.isArray(json.translation) ? json.translation.join('') : String(json.translation ?? '');
  if (translation.trim() === '') throw new Error('有道返回了空译文');
  return translation;
}

/**
 * provider 适配器：一家一个对象，上层只认"给我一批英文，还我一批中文"。
 * 签名 / 批量语义 / 限长 / 限速这些脏活全关在这里。
 *
 * 体验版一次只收一个 q（限 1000 字符），而且限流很紧：实测约 6 次/窗口就 411，
 * 触发后几十秒到几分钟才恢复。所以这里是**一次一个、两次之间至少隔 minIntervalMs、
 * 撞上 411 就退避重试**；`sleep`/`now` 可注入，测试里传 0 间隔就不会真等。
 */
export const PROVIDERS = {
  'youdao-demo': {
    label: '有道体验版（免费、无需 key）',
    fields: [],
    async translate(texts, options = {}) {
      const {
        fetchImpl = fetch,
        timeoutMs = 8000,
        minIntervalMs = DEFAULT_SETTINGS.minIntervalMs,
        retries = RATE_LIMIT_RETRIES,
        sleep = sleepMs,
        now = Date.now,
      } = options;
      const out = [];
      for (const text of texts) {
        for (let attempt = 0; ; attempt += 1) {
          const wait = youdaoLastCallAt + minIntervalMs - now();
          if (wait > 0) await sleep(wait);
          youdaoLastCallAt = now();
          try {
            out.push(await youdaoOnce(text, { fetchImpl, timeoutMs }));
            break;
          } catch (error) {
            if (error?.rateLimited !== true || attempt >= retries) throw error;
            await sleep(RATE_LIMIT_BACKOFF_MS * 2 ** attempt);
          }
        }
      }
      return out;
    },
  },
};

/**
 * 批量翻译：**词库优先**（命中就不发请求），未命中的才交给 provider。
 *
 * **现翻的结果不进词库**：词库只装"人认可过的"（手改 / 显式保存）。现翻结果放
 * `apiCache`（进程内，重挂就没），它只用来避免同一个词在一个会话里被反复翻 ——
 * 体验版限流很紧（约 6 次/窗口），能少发一次是一次。
 *
 * 依赖注入（fetchImpl / now / usage / apiCache）是为了能在契约测试里跑 stub，不碰真网。
 * 返回的 `results` 严格按入参顺序对齐：results[i] 对应 texts[i]，前端自己记 id ↔ 下标。
 */
export async function translateTexts(texts, options = {}) {
  const {
    tags = { version: 2, entries: {}, aliasIndex: {} },
    settings = DEFAULT_SETTINGS,
    usage = null,
    apiCache = null,
    fetchImpl = fetch,
    // sleep / now 透传给 provider：测试注入 no-op 就不真等节流
    sleep = undefined,
    now = undefined,
  } = options;

  const provider = PROVIDERS[settings.provider];
  const results = texts.map((text) => {
    const hit = tagsLookup(tags, text);
    // 词库命中：人认可的标 user（「我」），导入/内置的标 dict（「库」）—— 前端据此画标记
    // 词条自己的 source（user/import/builtin）跟工作区的徽章无关：命中就是"在库里"
    if (hit !== null) return { text, translation: hit.zh, source: 'dict' };
    const key = tagKey(text);
    if (key === '') return { text, translation: '', source: 'empty' };
    const cached = apiCache?.get(key);
    // 会话内记得的现翻结果：还是"机翻"（视觉标记不变），只是这次不再打接口
    if (typeof cached === 'string' && cached !== '') return { text, translation: cached, source: 'api' };
    return { text, translation: '', source: 'pending' };
  });

  // 掩码剥开：`(x:1.2)` 只把 x 交出去，一个片段算一次 provider 调用
  const groups = [];
  results.forEach((result, index) => {
    if (result.source !== 'pending') return;
    const plan = maskPromptSyntax(result.text);
    if (plan.skip === true || plan.parts.length === 0) {
      results[index] = { text: result.text, translation: '', source: 'skip' };
      return;
    }
    groups.push({ index, plan, fragments: plan.parts });
  });

  if (groups.length === 0 || provider === undefined) return { results };

  // 配额按**整条文本**算：宁可少翻几条，也不能翻一半（`{a|b}` 只翻一支会拼出半个结构）
  const budget = usage === null ? Infinity : Math.max(0, settings.maxCallsPerDay - usage.calls);
  const chosen = [];
  let cost = 0;
  for (const group of groups) {
    if (cost + group.fragments.length > budget) break;
    cost += group.fragments.length;
    chosen.push(group);
  }

  let truncated = false;
  if (chosen.length === 0 && budget <= 0) truncated = true;

  if (chosen.length > 0) {
    const fragments = chosen.flatMap((group) => group.fragments);
    let translations;
    try {
      translations = await provider.translate(fragments, {
        fetchImpl,
        timeoutMs: settings.timeoutMs,
        minIntervalMs: settings.minIntervalMs,
        sleep,
        now,
      });
    } catch (error) {
      for (const group of chosen) results[group.index] = { text: texts[group.index], translation: '', source: 'error' };
      return {
        results,
        error: {
          code: error?.rateLimited === true ? 'RATE_LIMIT' : 'PROVIDER',
          message: String(error?.message ?? error),
        },
      };
    }
    if (usage !== null) usage.calls += fragments.length;
    let cursor = 0;
    for (const group of chosen) {
      const parts = translations.slice(cursor, cursor + group.fragments.length);
      cursor += group.fragments.length;
      const translation = group.plan.rebuild(parts).trim();
      results[group.index] = { text: texts[group.index], translation, source: 'api' };
      if (translation !== '') apiCache?.set(tagKey(texts[group.index]), translation);
    }
    truncated = truncated || cost < groups.reduce((n, group) => n + group.fragments.length, 0);
    // 配额没轮上的别把内部状态漏给前端：统一标 error（前端据此知道"这次没翻成、别马上重试"）
    results.forEach((result, index) => {
      if (result.source === 'pending') results[index] = { text: texts[index], translation: '', source: 'error' };
    });
    return {
      results,
      ...(truncated
        ? { error: { code: 'QUOTA', message: `今日翻译次数已用完（上限 ${settings.maxCallsPerDay}）` } }
        : {}),
    };
  }

  for (const group of groups) results[group.index] = { text: texts[group.index], translation: '', source: 'error' };
  return {
    results,
    error: { code: 'QUOTA', message: `今日翻译次数已用完（上限 ${settings.maxCallsPerDay}）` },
  };
}

// ===========================================================================
// 3. 路由：/api/p/prompt-editor/*（前缀由宿主统一加）
// ===========================================================================

export function apply(ctx) {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const log = (msg) => ctx.logger?.info?.(`[${ID}] ${msg}`);

  const presetsFile = space.resolve(PRESETS_FILE);
  const draftFile = space.resolve(DRAFT_FILE);

  const loadPresets = () => {
    const raw = readJson(presetsFile, null);
    const list = raw !== null && typeof raw === 'object' && Array.isArray(raw.presets) ? raw.presets : [];
    return list.map(sanitizePreset).filter((preset) => preset !== null);
  };
  const savePresets = (list) => writeJson(presetsFile, { version: 1, presets: list });

  const summary = (preset) => ({
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    blockCount: preset.doc.blocks.length,
    itemCount: preset.doc.blocks.reduce((n, block) => n + block.items.length, 0),
  });

  const findPreset = (presetId) => loadPresets().find((preset) => preset.id === presetId) ?? null;

  const badRequest = (reply, message) =>
    reply.code(400).send({ error: { code: 'BAD_REQUEST', message } });
  const notFound = (reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个预设' } });

  // ---- 预设库：像 WeiLin 的主标签管理器，只是存储形态换成插件自己的 JSON ----

  routes.get('/presets', async () => ({ presets: loadPresets().map(summary) }));

  routes.get('/presets/:id', async (request, reply) => {
    const preset = findPreset(request.params.id);
    return preset === null ? notFound(reply) : { preset };
  });

  routes.post('/presets', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '请求体必须是 { name, doc }');
    }
    const doc = sanitizeDoc(body.doc);
    if (doc === null) return badRequest(reply, 'doc 形状不对（应为 { mode, blocks }）');

    const list = loadPresets();
    if (list.length >= LIMITS.presets) {
      return badRequest(reply, `预设数量已达上限 ${LIMITS.presets}，先删掉一些再存`);
    }
    const preset = {
      id: randomUUID(),
      name: text(body.name, LIMITS.name) || '未命名预设',
      updatedAt: Date.now(),
      doc,
    };
    list.push(preset);
    savePresets(list);
    log(`新增预设「${preset.name}」（共 ${list.length} 条）`);
    return reply.code(201).send({ preset });
  });

  /** 改名与覆盖保存共用：只改传进来的字段 */
  routes.put('/presets/:id', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '请求体必须是 { name?, doc? }');
    }
    const list = loadPresets();
    const index = list.findIndex((preset) => preset.id === request.params.id);
    if (index === -1) return notFound(reply);

    const current = list[index];
    const next = { ...current, updatedAt: Date.now() };
    if (typeof body.name === 'string') next.name = text(body.name, LIMITS.name) || current.name;
    if (body.doc !== undefined) {
      const doc = sanitizeDoc(body.doc);
      if (doc === null) return badRequest(reply, 'doc 形状不对（应为 { blocks: [...] }）');
      next.doc = doc;
    }
    list[index] = next;
    savePresets(list);
    return { preset: next };
  });

  routes.delete('/presets/:id', async (request, reply) => {
    const list = loadPresets();
    const next = list.filter((preset) => preset.id !== request.params.id);
    if (next.length === list.length) return notFound(reply);
    savePresets(next);
    return { ok: true, remaining: next.length };
  });

  // ---- 草稿：刷新页面不丢工作；只留一份，不做历史 ----
  //
  // 编辑热路径上只有两个写事件（前端按"改了多大一块"分派）：
  //   1. 组结构变了（区块增删/排序/标题/颜色/风格）→ PUT /draft/structure
  //   2. 某个组编辑完了（那个组的条目变了）        → PUT /draft/blocks/:id/items
  // 整份替换（载入预设 / 清空）不在热路径上，走 PUT /draft。

  const loadDraft = () => storedFromRaw(readJson(draftFile, null)) ?? { structure: [], items: {} };

  routes.get('/draft', async () => {
    const stored = storedFromRaw(readJson(draftFile, null));
    return { doc: stored === null ? null : docFromStored(stored) };
  });

  /** 事件 1：组结构。不带条目，所以请求体只跟区块数有关 */
  routes.put('/draft/structure', async (request, reply) => {
    const body = request.body;
    const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.blocks : null;
    if (!Array.isArray(raw)) return badRequest(reply, '请求体必须是 { blocks: [{ id, title, color, mode }] }');
    const stored = loadDraft();
    const structure = raw
      .slice(0, LIMITS.blocks)
      .filter((block) => block !== null && typeof block === 'object' && !Array.isArray(block))
      .map((block) => sanitizeBlockMeta(block, 'tag'));
    // 结构里没有的区块 = 被删了：它的条目一起清掉，不留孤儿
    const items = {};
    for (const meta of structure) items[meta.id] = stored.items[meta.id] ?? [];
    writeJson(draftFile, rawFromStored({ structure, items }));
    return { ok: true };
  });

  /** 事件 2：某个组的条目。只发这一个组，别的组一个字都不动 */
  routes.put('/draft/blocks/:id/items', async (request, reply) => {
    const body = request.body;
    const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.items : null;
    if (!Array.isArray(raw)) return badRequest(reply, '请求体必须是 { items: [...] }');
    const blockId = text(request.params.id, 64);
    const stored = loadDraft();
    if (blockId === '') return badRequest(reply, '缺少区块 id');
    if (!stored.structure.some((meta) => meta.id === blockId)) {
      // 结构写入还没落地（新建区块时两次请求可能乱序）：先垫一条默认属性。
      // 宁可多一个空区块，也不丢条目 —— 下一次结构写入会按结构把它清掉。
      stored.structure.push({ id: blockId, title: '', color: DEFAULT_COLOR, mode: 'tag' });
    }
    stored.items[blockId] = sanitizeItems(raw);
    writeJson(draftFile, rawFromStored(stored));
    return { ok: true };
  });

  /** 整份替换：载入预设 / 清空工作区。少见，不拆 */
  routes.put('/draft', async (request, reply) => {
    const body = request.body;
    const doc = sanitizeDoc(body !== null && typeof body === 'object' ? body.doc : null);
    if (doc === null) return badRequest(reply, '请求体必须是 { doc: { blocks } }');
    writeJson(draftFile, rawFromStored(storedFromDoc(doc)));
    return { ok: true };
  });

  // ---- 翻译：词库优先 + provider 兜底（固定 en→zh，见 2.5 节）----

  const settingsFile = space.resolve(SETTINGS_FILE);
  const tagsFile = space.resolve(TAGS_FILE);
  const legacyDictFile = space.resolve(LEGACY_DICT_FILE);
  const usageFile = space.resolve(USAGE_FILE);

  const today = () => new Date().toISOString().slice(0, 10);

  // 词库常驻内存、改一次落一次盘：自建库就几千条，全量写毫秒级，
  // 换来的是"进程被杀也不丢"——比防抖落盘少一个丢数据的窗口。
  let tagsCache = null;
  const loadTags = () => {
    if (tagsCache !== null) return tagsCache;
    const raw = readJson(tagsFile, null);
    if (raw !== null) {
      tagsCache = sanitizeTags(raw);
      return tagsCache;
    }
    // 没有 tags.json 就把老词库迁过来。
    const legacy = readJson(legacyDictFile, null);
    tagsCache = sanitizeTags(legacy);
    if (legacy !== null) {
      writeJson(tagsFile, tagsCache);
      // 老文件改名而不是删掉：一是留个原件（迁移出问题还能翻），
      // 二是**免得它复活** —— 不然你删了 tags.json，下次读盘又把这批老条目灌回来。
      try {
        fs.renameSync(legacyDictFile, `${legacyDictFile}.migrated`);
      } catch {
        // 改名失败（权限/占用）不该让插件起不来：数据已经在新文件里了
      }
    }
    return tagsCache;
  };
  // 现翻结果的会话缓存：**不落盘**，重挂即清。词库是"人认可过的"，这是"这次问过的"。
  const apiCache = new Map();
  const loadSettings = () => sanitizeSettings(readJson(settingsFile, null));
  const loadUsage = () => sanitizeUsage(readJson(usageFile, null), today());

  routes.get('/settings', async () => ({
    settings: loadSettings(),
    usage: loadUsage(),
    tagCount: Object.keys(loadTags().entries).length,
    providers: Object.entries(PROVIDERS).map(([id, provider]) => ({
      id,
      label: provider.label,
      fields: provider.fields,
    })),
  }));

  routes.put('/settings', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object') return badRequest(reply, '请求体必须是 { settings } 对象');
    const next = sanitizeSettings({ ...loadSettings(), ...(body.settings ?? body) });
    writeJson(settingsFile, next);
    return { settings: next };
  });

  /**
   * 批量翻译：results 按 texts 顺序对齐返回。
   * 这里**不写词库** —— 词库只装人认可的（见 `PUT /tags/entry`）；现翻结果只进会话缓存。
   */
  routes.post('/translate', async (request, reply) => {
    const body = request.body;
    const texts =
      body !== null && typeof body === 'object' && Array.isArray(body.texts)
        ? body.texts.filter((item) => typeof item === 'string').slice(0, 50)
        : null;
    if (texts === null || texts.length === 0) return badRequest(reply, '请求体必须是 { texts: [...] }（1~50 条）');

    const settings = loadSettings();
    const usage = loadUsage();
    const tags = loadTags();
    const outcome = await translateTexts(texts, { tags, settings, usage, apiCache });
    writeJson(usageFile, usage);
    return { results: outcome.results, ...(outcome.error === undefined ? {} : { error: outcome.error }) };
  });

  /**
   * 词库列表：面板用（搜索 / 按分类筛 / 分类计数）。
   * 一张表两用 —— 这里只管"管理"那一半，"用"那一半是翻译时按 en/别名命中。
   */
  routes.get('/tags', async (request) => {
    const query = request.query ?? {};
    return queryTags(loadTags(), {
      q: typeof query.q === 'string' ? query.q : '',
      category: typeof query.category === 'string' ? query.category : '',
      limit: query.limit,
    });
  });

  /**
   * 写一条 / 改一条：手改译文、点「机」存进词库、面板里改分类或别名，都走这里。
   * 默认 `source:'user'`（= 人认可的）；将来做导入时显式传 `import` / `builtin`。
   */
  routes.put('/tags/entry', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object') return badRequest(reply, '请求体必须是 { en, zh, categories?, aliases? }');
    const tags = loadTags();
    const entry = upsertTag(tags, body);
    if (entry === null) return badRequest(reply, '需要 en 和 zh（译文不能是空的）');
    writeJson(tagsFile, tags);
    return { ok: true, entry };
  });

  /** 删一条。传 en（正名） */
  routes.delete('/tags/entry', async (request, reply) => {
    const body = request.body;
    const en = typeof body?.en === 'string' ? body.en : (typeof request.query?.en === 'string' ? request.query.en : '');
    if (en.trim() === '') return badRequest(reply, '请求体必须是 { en }');
    const tags = loadTags();
    const deleted = removeTag(tags, en);
    if (deleted) writeJson(tagsFile, tags);
    return { ok: true, deleted };
  });

  ctx.effect(() => () => {
    // 本插件没有定时器 / 长连接；留一个显式的收尾点，重挂时语义清楚
  });
}
