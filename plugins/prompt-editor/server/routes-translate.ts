/**
 * 翻译 / 设置两组路由 —— 都是围绕翻译的那一摊事（词库优先 + provider 兜底，固定 en→zh）。
 *
 * 词库落在 SQLite（见 `tagdb.ts`）、现翻结果只进会话缓存，两者都活在 `registerTranslateRoutes`
 * 的闭包里：重挂 = 新闭包（D20），要活下来的只有写进 `ctx.space` 的东西。库连接是长持的，
 * 所以收尾必须关掉（不关就是句柄 + WAL 文件泄漏）—— 由 `routes.ts` 挂在 `ctx.effect` 上。
 *
 * 词库那一摊路由（`/tags*`）在 `routes-tags.ts`：它借用这里的 `tags()` 访问器，
 * **不自己开连接**（两份 `DatabaseSync` 就是两个 WAL 写入者）。
 */
import { LEGACY_DICT_FILE, SETTINGS_FILE, TAGS_DB_FILE, TAGS_FILE, USAGE_FILE } from './constants.js';
import { PROVIDERS } from './providers.js';
import { sanitizeSettings, sanitizeUsage, type Settings, type Usage } from './settings.js';
import { readJson, writeJson } from './store.js';
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

/** 装配返回的收尾句柄：`routes.ts` 把它挂到 `ctx.effect` 上；`tags` 借给 `routes-tags.ts` */
export interface TranslateRoutesHandle {
  close(): void;
  tags(): TagDb;
}

export function registerTranslateRoutes({ routes, space, badRequest }: RouteHelpers): TranslateRoutesHandle {
  const settingsFile = space.resolve(SETTINGS_FILE);
  const tagsDbFile = space.resolve(TAGS_DB_FILE);
  const tagsFile = space.resolve(TAGS_FILE);
  const legacyDictFile = space.resolve(LEGACY_DICT_FILE);
  const usageFile = space.resolve(USAGE_FILE);

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

  return {
    tags,
    close: (): void => {
      tagDb?.close();
      tagDb = null;
    },
  };
}
