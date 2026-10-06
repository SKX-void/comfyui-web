/**
 * 翻译 / 词库 / 设置三组路由 —— 都是围绕翻译的那一摊事（词库优先 + provider 兜底，固定 en→zh）。
 *
 * 词库常驻内存、现翻结果只进会话缓存，两者都活在 `registerTranslateRoutes` 的闭包里：
 * 重挂 = 新闭包（D20），要活下来的只有写进 `ctx.space` 的东西。
 */
import fs from 'node:fs';

import { LEGACY_DICT_FILE, SETTINGS_FILE, TAGS_FILE, USAGE_FILE } from './constants.js';
import { PROVIDERS } from './providers.js';
import { sanitizeSettings, sanitizeUsage, type Settings, type Usage } from './settings.js';
import { readJson, writeJson } from './store.js';
import { queryTags, removeTag, sanitizeTags, upsertTag, type Tags } from './tags.js';
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
}

export function registerTranslateRoutes({ routes, space, badRequest }: RouteHelpers): void {

  const settingsFile = space.resolve(SETTINGS_FILE);
  const tagsFile = space.resolve(TAGS_FILE);
  const legacyDictFile = space.resolve(LEGACY_DICT_FILE);
  const usageFile = space.resolve(USAGE_FILE);

  const today = (): string => new Date().toISOString().slice(0, 10);

  // 词库常驻内存、改一次落一次盘：自建库就几千条，全量写毫秒级，
  // 换来的是"进程被杀也不丢"——比防抖落盘少一个丢数据的窗口。
  let tagsCache: Tags | null = null;
  const loadTags = (): Tags => {
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
  const apiCache = new Map<string, string>();
  const loadSettings = (): Settings => sanitizeSettings(readJson(settingsFile, null));
  const loadUsage = (): Usage => sanitizeUsage(readJson(usageFile, null), today());

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
    const entry = upsertTag(tags, asRecord(body) ?? {});
    if (entry === null) return badRequest(reply, '需要 en 和 zh（译文不能是空的）');
    writeJson(tagsFile, tags);
    return { ok: true, entry };
  });

  /** 删一条。传 en（正名） */
  routes.delete('/tags/entry', async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const en = typeof body.en === 'string' ? body.en : (typeof request.query?.en === 'string' ? request.query.en : '');
    if (en.trim() === '') return badRequest(reply, '请求体必须是 { en }');
    const tags = loadTags();
    const deleted = removeTag(tags, en);
    if (deleted) writeJson(tagsFile, tags);
    return { ok: true, deleted };
  });
}
