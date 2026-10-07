/**
 * 翻译 / 词库 / 设置三组路由 —— 都是围绕翻译的那一摊事（词库优先 + provider 兜底，固定 en→zh）。
 * 外加词库的**批量导入**（`/tags/import`，灌产物自带的机翻表）。
 *
 * 词库落在 SQLite（见 `tagdb.ts`）、现翻结果只进会话缓存，两者都活在 `registerTranslateRoutes`
 * 的闭包里：重挂 = 新闭包（D20），要活下来的只有写进 `ctx.space` 的东西。库连接是长持的，
 * 所以收尾必须关掉（不关就是句柄 + WAL 文件泄漏）—— 由 `routes.ts` 挂在 `ctx.effect` 上。
 */
import fs from 'node:fs';

import { LEGACY_DICT_FILE, LIMITS, SETTINGS_FILE, TAGS_DB_FILE, TAGS_FILE, USAGE_FILE } from './constants.js';
import { PROVIDERS } from './providers.js';
import { sanitizeSettings, sanitizeUsage, type Settings, type Usage } from './settings.js';
import { readJson, writeJson } from './store.js';
import { BUNDLED_CSV, looksLikeLfsPointer, parseTagCsv } from './tagcsv.js';
import { openTagDb, type TagDb } from './tagdb.js';
import { translateTexts } from './translate.js';
import type { PluginRoutes, PluginSpace, RouteReply } from './types.js';
import { asRecord } from './util.js';

/**
 * 与 `routes.ts` 共享的装配件：路由表、空间句柄与 400 应答由那边统一给出（错误信封只有一份）。
 *
 * 路由表**必须传进来**，不能在这里再 `ctx.routes.for(ID)`：宿主每调用一次 `for()` 就换一张新表
 * （`apps/server/src/handles/routes.ts` 的语义），再领一次会把先注册的预设 / 草稿路由整张丢掉
 * —— 表现出来就是那几个端点全 404。
 */
export interface RouteHelpers {
  routes: PluginRoutes;
  space: PluginSpace;
  badRequest: (reply: RouteReply, message: string) => unknown;
  log: (msg: string) => void;
}

/** 装配返回的收尾句柄：`routes.ts` 把它挂到 `ctx.effect` 上 */
export interface TranslateRoutesHandle {
  close(): void;
}

export function registerTranslateRoutes({ routes, space, badRequest, log }: RouteHelpers): TranslateRoutesHandle {

  const settingsFile = space.resolve(SETTINGS_FILE);
  const tagsDbFile = space.resolve(TAGS_DB_FILE);
  const tagsFile = space.resolve(TAGS_FILE);
  const legacyDictFile = space.resolve(LEGACY_DICT_FILE);
  const usageFile = space.resolve(USAGE_FILE);

  /** 一次写多少条让出一次事件循环（见 `POST /tags/import`） */
  const IMPORT_CHUNK = 20000;
  /** 导入进行中：连点两次按钮 / 两个页面同时点，第二次直接回 409（写是幂等的，但报数会互相骗） */
  let importing = false;

  const today = (): string => new Date().toISOString().slice(0, 10);

  // 词库连接长持（打开一次用到底），但**第一次真要用时才开**：装配阶段不碰盘，
  // 于是"只把路由挂上去"（契约测试就是这么干的）不会凭空造出一个 tags.db。
  // 老词库（tags.json / dict.json）的搬迁在 openTagDb 里，一次性。
  let tagDb: TagDb | null = null;
  const tags = (): TagDb => {
    tagDb ??= openTagDb({ db: tagsDbFile, tagsJson: tagsFile, legacyDictJson: legacyDictFile });
    return tagDb;
  };
  // 现翻结果的会话缓存：**不落盘**，重挂即清。词库是"人认可过的"，这是"这次问过的"。
  const apiCache = new Map<string, string>();
  const loadSettings = (): Settings => sanitizeSettings(readJson(settingsFile, null));
  const loadUsage = (): Usage => sanitizeUsage(readJson(usageFile, null), today());

  routes.get('/settings', async () => ({
    settings: loadSettings(),
    usage: loadUsage(),
    tagCount: tags().count(),
    providers: Object.entries(PROVIDERS).map(([id, provider]) => ({
      id,
      label: provider.label,
      fields: provider.fields,
    })),
  }));

  routes.put('/settings', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object') return badRequest(reply, '请求体必须是 { settings } 对象');
    const patch = asRecord(body)?.settings ?? body;
    const next = sanitizeSettings({ ...loadSettings(), ...(asRecord(patch) ?? {}) });
    writeJson(settingsFile, next);
    return { settings: next };
  });

  /**
   * 批量翻译：results 按 texts 顺序对齐返回。
   * 这里**不写词库** —— 词库只装人认可的（见 `PUT /tags/entry`）；现翻结果只进会话缓存。
   */
  routes.post('/translate', async (request, reply) => {
    const raw = asRecord(request.body)?.texts;
    const texts: string[] | null = Array.isArray(raw) ? raw.filter((item) => typeof item === 'string').slice(0, 50) : null;
    if (texts === null || texts.length === 0) return badRequest(reply, '请求体必须是 { texts: [...] }（1~50 条）');

    const settings = loadSettings();
    const usage = loadUsage();
    const outcome = await translateTexts(texts, { tagLookup: tags(), settings, usage, apiCache });
    writeJson(usageFile, usage);
    return { results: outcome.results, ...(outcome.error === undefined ? {} : { error: outcome.error }) };
  });

  /**
   * 词库列表：面板用（搜索 / 按分类筛 / 分类计数）。
   * 一张表两用 —— 这里只管"管理"那一半，"用"那一半是翻译时按 en/别名命中。
   */
  routes.get('/tags', async (request) => {
    const query = request.query ?? {};
    return tags().query({
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
    const entry = tags().upsert(asRecord(body) ?? {});
    if (entry === null) return badRequest(reply, '需要 en 和 zh（译文不能是空的）');
    return { ok: true, entry };
  });

  /**
   * 手动排序：面板里把一行拖到别的位置之后，把**当前这一页的新顺序**（`keys`）和
   * **被拖的那一条**（`moved`）发过来。服务端取左右邻居的中点，只写 1 行（见 `TagDb.setOrder`）。
   *
   * 为什么要发整页：顺序是相对一整页说的，而"这一页"带着搜索 / 分类筛选，服务端自己猜不出来。
   * `moved` 告诉它"哪一条动了"，不然它没法从一串 key 里看出该改哪一行。
   */
  routes.put('/tags/order', async (request, reply) => {
    const body = asRecord(request.body);
    const keys = body?.keys;
    const moved = body?.moved;
    if (!Array.isArray(keys) || keys.length === 0) return badRequest(reply, '请求体必须是 { keys: [...] }（当前这一页的新顺序）');
    if (keys.length > LIMITS.orderKeys) return badRequest(reply, `一次最多排 ${LIMITS.orderKeys} 条`);
    if (moved !== undefined && moved !== null && typeof moved !== 'string') return badRequest(reply, 'moved 必须是正名字符串');
    const clean = keys.filter((one): one is string => typeof one === 'string' && one.trim() !== '');
    if (clean.length !== keys.length) return badRequest(reply, 'keys 里只能是正名字符串');
    return { ok: true, ...tags().setOrder(clean, typeof moved === 'string' ? moved : null) };
  });

  /**
   * 新建一个分类：**只加名字，一条词都不动**（"先建分类、再往里放词"要走得通）。
   * 重名不算错：`created:false` 让面板说"已经有一个同名的了"。
   */
  routes.post('/tags/categories', async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return badRequest(reply, '请求体必须是 { name }');
    if (name.length > LIMITS.category) return badRequest(reply, `分类名最多 ${LIMITS.category} 个字符`);
    return { ok: true, created: tags().createCategory(name) };
  });

  /**
   * 删掉一个分类：**连它下面的归属一起删**，所以是批量破坏性操作 —— 面板会先把影响多少条
   * 摆给人看再确认。词条本身一条都不删，它们只是变回未分类。
   */
  routes.delete('/tags/categories', async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return badRequest(reply, '请求体必须是 { name }');
    return { ok: true, removed: tags().removeCategory(name) };
  });

  /** 重命名分类（`categories` + `tag_categories` 两张表一起改）；目标名字已存在时 409（不合并） */
  routes.put('/tags/categories', async (request, reply) => {
    const body = asRecord(request.body);
    const from = typeof body?.from === 'string' ? body.from.trim() : '';
    const to = typeof body?.to === 'string' ? body.to.trim() : '';
    if (from === '' || to === '') return badRequest(reply, '请求体必须是 { from, to }');
    if (to.length > LIMITS.category) return badRequest(reply, `分类名最多 ${LIMITS.category} 个字符`);
    const moved = tags().renameCategory(from, to);
    if (moved < 0) {
      reply.code(409);
      return { ok: false, error: { message: `已经有一个叫「${to}」的分类了（不自动合并）` } };
    }
    return { ok: true, moved };
  });

  /** 删一条。传 en（正名） */
  routes.delete('/tags/entry', async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const en = typeof body.en === 'string' ? body.en : (typeof request.query?.en === 'string' ? request.query.en : '');
    if (en.trim() === '') return badRequest(reply, '请求体必须是 { en }');
    return { ok: true, deleted: tags().remove(en) };
  });

  /**
   * 产物里那份内置机翻表在不在、多大 —— 面板靠它决定要不要画「导入」按钮。
   * 只 stat 不解析：5MB / 14 万行读一遍要几百毫秒，而这里只需要回答"按钮点不点得动"。
   */
  const bundledInfo = (): { available: boolean; bytes: number } => {
    try {
      const stat = fs.statSync(BUNDLED_CSV);
      return { available: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
    } catch {
      return { available: false, bytes: 0 };
    }
  };

  routes.get('/tags/import', async () => ({ bundled: bundledInfo() }));

  /**
   * 导入**产物自带**的机翻表（`assets/danbooru-zh.csv`，构建时由 pack.mjs 的 extras 拷进来）。
   *
   * 为什么不是浏览器上传：14 万行 / 5MB 没必要过一遍 HTTP 和宿主内存，而且解析规则已经在
   * `tagcsv.ts` 里了 —— 上传那条路等于再实现一遍，还容易和命令行导出来的库不是一个结果。
   *
   * 分批 + `setImmediate`：宿主是单进程单事件循环，一个事务写完 14 万行要两秒，这两秒里
   * 所有 tab 的请求都得排队。切成小块、块间让出事件循环，把停顿打散。
   *
   * 幂等：重导只是按 `hot` 更新，`source='user'` 的行（你在面板里改过的）一律不动
   * —— 见 `tagdb.ts` 的 `insertTagSql(guardUser)`。
   */
  routes.post('/tags/import', async (request, reply) => {
    if (importing) return reply.code(409).send({ error: { code: 'BUSY', message: '上一次导入还没写完，稍等一下' } });
    const info = bundledInfo();
    if (!info.available) {
      return badRequest(reply, '产物里没有内置机翻表（assets/danbooru-zh.csv）—— 先 pnpm build:plugins');
    }
    let text: string;
    try {
      text = fs.readFileSync(BUNDLED_CSV, 'utf8');
    } catch (err) {
      return badRequest(reply, `读不了内置机翻表：${(err as Error).message}`);
    }
    // 源码里这份 CSV 走 git-lfs：没装 lfs / 跳了 smudge 时这里躺着的是 130 字节的指针，
    // 不当心的话就是"导入成功，入库 0 条"——那比报错难查得多
    if (looksLikeLfsPointer(text)) {
      return badRequest(reply, 'assets/danbooru-zh.csv 是 git-lfs 指针（不是真文件）：先 git lfs pull 再重新构建');
    }

    const started = performance.now();
    const { rows, stats } = parseTagCsv(text);
    const db = tags();
    const before = db.count();
    importing = true;
    let written = 0;
    try {
      for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
        written += db.importEntries(rows.slice(i, i + IMPORT_CHUNK));
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      importing = false;
    }
    const after = db.count();
    log(`导入内置机翻表：候选 ${rows.length} 条 · 入库 ${written} 条 · 库内 ${before} → ${after} 条`);
    return {
      ok: true,
      ...stats,
      rows: rows.length,
      written,
      skipped: rows.length - written,
      before,
      after,
      elapsedMs: Math.round(performance.now() - started),
    };
  });

  return {
    close: (): void => {
      tagDb?.close();
      tagDb = null;
    },
  };
}
