/**
 * LLM 路由（D27）：`/llm/generate`、`/llm/blocks*`、`/llm/prompts`。
 *
 * 规则摘要：
 * - settings.llm.enabled = false 时，`/llm/*` 一律 403 LLM_DISABLED（先查后放行）。
 * - 读 = 全部块可见（带 ai 标记）；改/删 = 块.ai === true；suggest 无写门禁、不落盘。
 * - 一次 `/llm/generate` = 1 次用量（内部多轮 tool call 不另计）。
 * - 工具写即时落盘：每次 set_block 都先现读草稿、改完立刻写盘，中途失败不回滚。
 */
import { randomUUID } from 'node:crypto';

import { DRAFT_FILE, LIMITS, LLM_PROMPTS_FILE, SETTINGS_FILE, USAGE_FILE } from './constants.js';
import { rawFromStored, storedFromRaw, text, type BlockMeta, type Stored } from './doc.js';
import { runLlmAgent } from './llm.js';
import { interpolatePrompt, loadLlmPrompts, sanitizeLlmPrompt } from './llm-prompts.js';
import { buildItems, describeWorkspace, makeToolkit, type LlmStats } from './llm-toolkit.js';
import { sanitizeSettings, sanitizeUsage, type Settings, type Usage } from './settings.js';
import { readJson, writeJson } from './store.js';
import type { TagLookup } from './tags.js';
import type { PluginRoutes, PluginSpace, RouteReply } from './types.js';
import { asRecord, isRecord } from './util.js';

export interface LlmRouteHelpers {
  routes: PluginRoutes;
  space: PluginSpace;
  badRequest: (reply: RouteReply, message: string) => unknown;
  log: (message: string) => void;
  tags: () => TagLookup;
}

const CONTENT_SEPARATOR: Record<string, string> = { tag: ', ', text: ' ' };

export function registerLlmRoutes({ routes, space, badRequest, log, tags }: LlmRouteHelpers): void {
  const settingsFile = space.resolve(SETTINGS_FILE);
  const usageFile = space.resolve(USAGE_FILE);
  const draftFile = space.resolve(DRAFT_FILE);

  const today = (): string => new Date().toISOString().slice(0, 10);
  const loadSettings = (): Settings => sanitizeSettings(readJson(settingsFile, null));
  const loadUsage = (): Usage => sanitizeUsage(readJson(usageFile, null), today());
  const loadDraft = (): Stored => storedFromRaw(readJson(draftFile, null)) ?? { structure: [], items: {} };
  const saveDraft = (stored: Stored): void => writeJson(draftFile, rawFromStored(stored));

  const disabled = (reply: RouteReply): unknown =>
    reply.code(403).send({ error: { code: 'LLM_DISABLED', message: 'LLM 功能未启用（settings.json 的 llm.enabled = false）' } });

  const findBlock = (stored: Stored, idOrName: string): BlockMeta | null => {
    const direct = stored.structure.find((meta) => meta.id === idOrName);
    if (direct !== undefined) return direct;
    const named = stored.structure.filter((meta) => meta.title === idOrName);
    if (named.length === 1) return named[0] ?? null;
    return null;
  };

  const namedCandidates = (stored: Stored, idOrName: string): BlockMeta[] =>
    stored.structure.filter((meta) => meta.title === idOrName);

  const joinContent = (stored: Stored, meta: BlockMeta): string => {
    const items = (stored.items[meta.id] ?? []).filter((item) => item.enabled && item.text.trim() !== '');
    return items.map((item) => item.text.trim()).join(CONTENT_SEPARATOR[meta.mode] ?? ', ');
  };

  const blockSummary = (stored: Stored, meta: BlockMeta) => ({
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    ai: meta.ai,
    itemCount: (stored.items[meta.id] ?? []).length,
  });

  // ── 生成 ────────────────────────────────────────────────────────────────

  routes.post('/llm/generate', async (request, reply) => {
    const settings = loadSettings();
    if (!settings.llm.enabled) return disabled(reply);

    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { instruction, ... }');
    const instruction = text(body.instruction, LIMITS.itemText);
    if (instruction === '') return badRequest(reply, 'instruction 不能为空');

    const usage = loadUsage();
    if (usage.llmCalls >= settings.llm.maxCallsPerDay) {
      return reply.code(429).send({ error: { code: 'LLM_QUOTA', message: '今日 LLM 调用次数已用完，明天自动恢复' } });
    }
    usage.llmCalls += 1;
    writeJson(usageFile, usage);

    const blockIds = Array.isArray(body.blockIds)
      ? (body.blockIds as unknown[]).filter((one): one is string => typeof one === 'string')
      : [];
    const allowCreate = body.allowCreate !== false;
    const stored = loadDraft();
    const writableIds = new Set(
      stored.structure.filter((meta) => meta.ai === true && blockIds.includes(meta.id)).map((meta) => meta.id),
    );
    if (writableIds.size === 0 && !allowCreate) {
      return badRequest(reply, '没有可写的 AI 区块（blockIds 里没有 ai 标记的块），且 allowCreate = false');
    }

    const prompts = loadLlmPrompts(space);
    const promptId = typeof body.promptId === 'string' ? body.promptId : '';
    const prompt = (promptId === '' ? prompts[0] : prompts.find((one) => one.id === promptId)) ?? null;
    if (prompt === null) return badRequest(reply, '没有这个初始提示词模板（promptId）');

    const stats: LlmStats = { changed: [], created: [], deleted: [], suggestions: [] };
    const toolkit = makeToolkit({ settings, stored, writableIds, allowCreate, stats, saveDraft, buildItems: (content, mode) => buildItems(content, mode, tags) });

    const system = interpolatePrompt(
      prompt.template,
      { workspace: describeWorkspace(stored, writableIds, joinContent), instruction },
      log,
    );
    const outcome = await runLlmAgent({ llm: settings.llm, system, user: instruction, toolkit });

    return {
      changed: stats.changed,
      created: stats.created,
      deleted: stats.deleted,
      suggestions: stats.suggestions,
      summary: outcome.summary,
      toolCalls: outcome.toolCalls,
      aborted: outcome.aborted,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  });

  // ── 区块读写 ────────────────────────────────────────────────────────────

  routes.get('/llm/blocks', async (_request, reply) => {
    if (!loadSettings().llm.enabled) return disabled(reply);
    const stored = loadDraft();
    return { blocks: stored.structure.map((meta) => blockSummary(stored, meta)) };
  });

  routes.get('/llm/blocks/:id', async (request, reply) => {
    if (!loadSettings().llm.enabled) return disabled(reply);
    const stored = loadDraft();
    const target = findBlock(stored, text(request.params.id, LIMITS.name));
    if (target === null) {
      const candidates = namedCandidates(stored, text(request.params.id, LIMITS.name));
      if (candidates.length > 1) {
        return reply.code(409).send({
          error: {
            code: 'AMBIGUOUS',
            message: '多个区块同名，请用 id 寻址',
            candidates: candidates.map((meta) => blockSummary(stored, meta)),
          },
        });
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个区块' } });
    }
    return { block: { id: target.id, title: target.title, mode: target.mode, ai: target.ai, content: joinContent(stored, target) } };
  });

  routes.put('/llm/blocks/:id', async (request, reply) => {
    if (!loadSettings().llm.enabled) return disabled(reply);
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { title?, mode?, content? }');
    const stored = loadDraft();
    const idOrName = text(request.params.id, LIMITS.name);
    const target = findBlock(stored, idOrName);
    if (target === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个区块' } });
    if (!target.ai) {
      return reply.code(403).send({ error: { code: 'NOT_AI_BLOCK', message: '这个区块不是 AI 区块，不能通过 /llm 修改' } });
    }
    const hasMode = typeof body.mode === 'string';
    const hasContent = typeof body.content === 'string';
    if (hasMode && !hasContent) return badRequest(reply, '改 mode 必须同时带 content');
    if (hasMode && body.mode !== 'tag' && body.mode !== 'text') return badRequest(reply, 'mode 只能是 tag 或 text');

    const mode = hasMode ? (body.mode as 'tag' | 'text') : target.mode;
    if (typeof body.title === 'string' && text(body.title, LIMITS.title) !== '') target.title = text(body.title, LIMITS.title);
    target.mode = mode;
    if (hasContent) {
      const next = buildItems(body.content as string, mode, tags);
      target.enabled = true;
      stored.items[target.id] = [...next, ...(stored.items[target.id] ?? []).filter((item) => !item.enabled)];
    }
    saveDraft(stored);
    return { block: { id: target.id, title: target.title, mode: target.mode, ai: target.ai, content: joinContent(stored, target) } };
  });

  routes.post('/llm/blocks', async (request, reply) => {
    const settings = loadSettings();
    if (!settings.llm.enabled) return disabled(reply);
    const body = asRecord(request.body);
    const rawList = body !== null && Array.isArray(body.blocks) ? body.blocks : null;
    if (rawList === null) return badRequest(reply, '请求体必须是 { blocks: [{ title, mode?, content }] }');
    const stored = loadDraft();
    if (stored.structure.length + rawList.length > LIMITS.blocks) {
      return badRequest(reply, `区块数量已达上限 ${LIMITS.blocks} 个`);
    }
    const created: { id: string; title: string; mode: string; ai: boolean; itemCount: number }[] = [];
    for (const raw of rawList) {
      if (!isRecord(raw)) continue;
      const title = text(raw.title, LIMITS.title);
      const content = text(raw.content, LIMITS.itemText);
      if (title === '' || content === '') continue;
      const mode = raw.mode === 'text' ? 'text' : 'tag';
      const meta: BlockMeta = {
        id: randomUUID(),
        title,
        color: settings.llm.newBlockColor,
        mode,
        collapsed: false,
        enabled: true,
        ai: true,
      };
      stored.structure.push(meta);
      stored.items[meta.id] = buildItems(content, mode, tags);
      created.push(blockSummary(stored, meta));
    }
    saveDraft(stored);
    log(`LLM 批量新建 ${created.length} 个区块`);
    return { created };
  });

  routes.delete('/llm/blocks/:id', async (request, reply) => {
    if (!loadSettings().llm.enabled) return disabled(reply);
    const stored = loadDraft();
    const idOrName = text(request.params.id, LIMITS.name);
    const target = findBlock(stored, idOrName);
    if (target === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个区块' } });
    if (!target.ai) {
      return reply.code(403).send({ error: { code: 'NOT_AI_BLOCK', message: '这个区块不是 AI 区块，不能通过 /llm 删除' } });
    }
    stored.structure = stored.structure.filter((meta) => meta.id !== target.id);
    delete stored.items[target.id];
    saveDraft(stored);
    return { ok: true, deleted: target.id };
  });

  // ── 初始提示词模板 ──────────────────────────────────────────────────────

  routes.get('/llm/prompts', async (_request, reply) => {
    if (!loadSettings().llm.enabled) return disabled(reply);
    return { prompts: loadLlmPrompts(space) };
  });

  routes.put('/llm/prompts', async (request, reply) => {
    if (!loadSettings().llm.enabled) return disabled(reply);
    const body = asRecord(request.body);
    const rawList = body !== null && Array.isArray(body.prompts) ? body.prompts : null;
    if (rawList === null) return badRequest(reply, '请求体必须是 { prompts: [{ id?, name, template }] }');
    const prompts = rawList
      .map((one, index) => sanitizeLlmPrompt(one, `prompt-${index + 1}`))
      .filter((prompt) => prompt !== null);
    for (const prompt of prompts) prompt.updatedAt = Date.now();
    writeJson(space.resolve(LLM_PROMPTS_FILE), { version: 1, prompts });
    return { prompts };
  });
}
