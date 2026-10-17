/**
 * LLM 路由（D27/D28）：`/llm/generate`、`/llm/blocks*`、`/llm/prompts`。
 *
 * 规则摘要：
 * - settings.llm.enabled = false 时，`/llm/*` 一律 403 LLM_DISABLED（先查后放行）。
 * - 读 = 全部块可见（带 ai 标记）；改/删 = 块.ai === true；suggest 无写门禁、不落盘。
 * - 一次 `/llm/generate` = 1 次用量（内部多轮 tool call 不另计 —— 计数在 `llm-run`）。
 * - 工具写即时落盘：每次 set_block 都先现读草稿、改完立刻写盘，中途失败不回滚。
 * - 多轮对话在 `routes-llm-chats.ts`，与这里共用 `llm-run` 的内核。
 */
import { DRAFT_FILE, LIMITS, LLM_PROMPTS_FILE } from './constants.js';
import { freeBlockId, rawFromStored, storedFromRaw, text, type BlockMeta, type Stored } from './doc.js';
import { createLlmRunner, joinBlockContent, type LlmTagSource } from './llm-run.js';
import { LLM_PROMPTS_VERSION, loadLlmPrompts, sanitizeLlmPrompt } from './llm-prompts.js';
import { buildItems } from './llm-toolkit.js';
import { readJson, writeJson } from './store.js';
import type { PluginRoutes, PluginSpace, RouteReply } from './types.js';
import { asRecord, isRecord } from './util.js';

export interface LlmRouteHelpers {
  routes: PluginRoutes;
  space: PluginSpace;
  badRequest: (reply: RouteReply, message: string) => unknown;
  log: (message: string) => void;
  tags: () => LlmTagSource;
}

export function registerLlmRoutes({ routes, space, badRequest, log, tags }: LlmRouteHelpers): void {
  const draftFile = space.resolve(DRAFT_FILE);
  const runner = createLlmRunner({ space, log, tags });

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

  const blockSummary = (stored: Stored, meta: BlockMeta) => ({
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    ai: meta.ai,
    itemCount: (stored.items[meta.id] ?? []).length,
  });

  const blockDetail = (stored: Stored, meta: BlockMeta) => ({
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    ai: meta.ai,
    content: joinBlockContent(stored, meta),
  });

  // ── 生成 ────────────────────────────────────────────────────────────────

  routes.post('/llm/generate', async (request, reply) => {
    const result = await runner.run(request.body);
    if (!result.ok) return reply.code(result.status).send({ error: { code: result.code, message: result.message } });
    return result.outcome;
  });

  // ── 区块读写 ────────────────────────────────────────────────────────────

  routes.get('/llm/blocks', async (_request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const stored = loadDraft();
    return { blocks: stored.structure.map((meta) => blockSummary(stored, meta)) };
  });

  routes.get('/llm/blocks/:id', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const stored = loadDraft();
    const idOrName = text(request.params.id, LIMITS.name);
    const target = findBlock(stored, idOrName);
    if (target === null) {
      const candidates = namedCandidates(stored, idOrName);
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
    return { block: blockDetail(stored, target) };
  });

  routes.put('/llm/blocks/:id', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { title?, mode?, content? }');
    const stored = loadDraft();
    const target = findBlock(stored, text(request.params.id, LIMITS.name));
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
    return { block: blockDetail(stored, target) };
  });

  routes.post('/llm/blocks', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
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
        id: freeBlockId(stored.structure),
        title,
        color: runner.color(),
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
    if (!runner.enabled()) return disabled(reply);
    const stored = loadDraft();
    const target = findBlock(stored, text(request.params.id, LIMITS.name));
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
    if (!runner.enabled()) return disabled(reply);
    return { prompts: loadLlmPrompts(space) };
  });

  routes.put('/llm/prompts', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const body = asRecord(request.body);
    const rawList = body !== null && Array.isArray(body.prompts) ? body.prompts : null;
    if (rawList === null) {
      return badRequest(reply, '请求体必须是 { prompts: [{ id?, name, segments: [{ name, role?, content, enabled? }] }] }');
    }
    const prompts = rawList
      .map((one, index) => sanitizeLlmPrompt(one, `prompt-${index + 1}`))
      .filter((prompt) => prompt !== null);
    for (const prompt of prompts) prompt.updatedAt = Date.now();
    writeJson(space.resolve(LLM_PROMPTS_FILE), { version: LLM_PROMPTS_VERSION, prompts });
    return { prompts };
  });
}
