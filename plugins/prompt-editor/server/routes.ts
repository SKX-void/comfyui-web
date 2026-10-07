/**
 * 预设库与草稿的路由 + 装配：`/api/p/prompt-editor/*`（前缀由宿主统一加）。
 *
 * 状态全活在 `registerRoutes` 的闭包里：重挂 = 新闭包（D20），内存里的一切归零，
 * 要活下来的只有写进 `ctx.space` 的东西。
 *
 * 翻译 / 词库 / 设置那三组在 `routes-translate.ts`（注册顺序与原来一致：接在本文件之后）。
 */
import { randomUUID } from 'node:crypto';

import { DEFAULT_COLOR, DRAFT_FILE, ID, LIMITS, PACKAGE, PRESETS_FILE } from './constants.js';
import {
  docFromStored,
  rawFromStored,
  sanitizeBlockMeta,
  sanitizeDoc,
  sanitizeItems,
  sanitizePreset,
  storedFromDoc,
  storedFromRaw,
  text,
  type Item,
  type Preset,
  type Stored,
} from './doc.js';
import { registerTranslateRoutes } from './routes-translate.js';
import { readJson, writeJson } from './store.js';
import type { PluginContext, RouteReply } from './types.js';
import { asRecord, isRecord } from './util.js';

export function registerRoutes(ctx: PluginContext): void {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const log = (msg: string): void => ctx.logger?.info?.(`[${ID}] ${msg}`);

  const presetsFile = space.resolve(PRESETS_FILE);
  const draftFile = space.resolve(DRAFT_FILE);

  const loadPresets = (): Preset[] => {
    const raw = asRecord(readJson(presetsFile, null));
    const list = raw !== null && Array.isArray(raw.presets) ? raw.presets : [];
    return list.map(sanitizePreset).filter((preset) => preset !== null);
  };
  const savePresets = (list: Preset[]): void => writeJson(presetsFile, { version: 1, presets: list });

  const summary = (preset: Preset) => ({
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    blockCount: preset.doc.blocks.length,
    itemCount: preset.doc.blocks.reduce((n, block) => n + block.items.length, 0),
  });

  const findPreset = (presetId: string): Preset | null =>
    loadPresets().find((preset) => preset.id === presetId) ?? null;

  const badRequest = (reply: RouteReply, message: string): unknown =>
    reply.code(400).send({ error: { code: 'BAD_REQUEST', message } });
  const notFound = (reply: RouteReply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个预设' } });

  // ---- 预设库：像 WeiLin 的主标签管理器，只是存储形态换成插件自己的 JSON ----

  routes.get('/presets', async () => ({ presets: loadPresets().map(summary) }));

  routes.get('/presets/:id', async (request, reply) => {
    const preset = findPreset(request.params.id);
    return preset === null ? notFound(reply) : { preset };
  });

  routes.post('/presets', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { name, doc }');
    const doc = sanitizeDoc(body.doc);
    if (doc === null) return badRequest(reply, 'doc 形状不对（应为 { mode, blocks }）');

    const list = loadPresets();
    if (list.length >= LIMITS.presets) {
      return badRequest(reply, `预设数量已达上限 ${LIMITS.presets}，先删掉一些再存`);
    }
    const preset: Preset = {
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
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { name?, doc? }');
    const list = loadPresets();
    const index = list.findIndex((preset) => preset.id === request.params.id);
    const current = list[index];
    if (current === undefined) return notFound(reply);

    const next: Preset = { ...current, updatedAt: Date.now() };
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

  const loadDraft = (): Stored => storedFromRaw(readJson(draftFile, null)) ?? { structure: [], items: {} };

  routes.get('/draft', async () => {
    const stored = storedFromRaw(readJson(draftFile, null));
    return { doc: stored === null ? null : docFromStored(stored) };
  });

  /** 事件 1：组结构。不带条目，所以请求体只跟区块数有关 */
  routes.put('/draft/structure', async (request, reply) => {
    const raw = asRecord(request.body)?.blocks;
    if (!Array.isArray(raw)) return badRequest(reply, '请求体必须是 { blocks: [{ id, title, color, mode }] }');
    const stored = loadDraft();
    const structure = raw
      .slice(0, LIMITS.blocks)
      .filter(isRecord)
      .map((block) => sanitizeBlockMeta(block, 'tag'));
    // 结构里没有的区块 = 被删了：它的条目一起清掉，不留孤儿
    const items: Record<string, Item[]> = {};
    for (const meta of structure) items[meta.id] = stored.items[meta.id] ?? [];
    writeJson(draftFile, rawFromStored({ structure, items }));
    return { ok: true };
  });

  /** 事件 2：某个组的条目。只发这一个组，别的组一个字都不动 */
  routes.put('/draft/blocks/:id/items', async (request, reply) => {
    const raw = asRecord(request.body)?.items;
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
    const doc = sanitizeDoc(asRecord(request.body)?.doc ?? null);
    if (doc === null) return badRequest(reply, '请求体必须是 { doc: { blocks } }');
    writeJson(draftFile, rawFromStored(storedFromDoc(doc)));
    return { ok: true };
  });

  // 翻译 / 词库 / 设置那三组（顺序同原来：接在草稿之后）。路由表**传下去**而不是让那边再领一次：
  // 宿主每次 `ctx.routes.for()` 都换一张新表，领两次会把这里的预设 / 草稿路由整张覆盖掉。
  const translateRoutes = registerTranslateRoutes({ routes, space, badRequest, log });

  ctx.effect(() => () => {
    // 词库是长持的 SQLite 连接：重挂 = 新闭包，不关就是句柄 + WAL 文件泄漏
    translateRoutes.close();
  });
}
