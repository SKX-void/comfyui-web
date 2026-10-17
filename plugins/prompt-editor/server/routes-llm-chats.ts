/**
 * 多轮对话路由（D28）：会话的建/列/读/删 + 每条消息跑一次生成。
 *
 * 生成复用 `llm-run` 的内核 —— 与 `/llm/generate` 同一份总闸、配额、可写范围与落盘语义，
 * 这里只多两件事：按会话回放历史、把结果记成一轮。
 */
import { LIMITS } from './constants.js';
import { text } from './doc.js';
import {
  chatTitle,
  loadLlmChats,
  makeChat,
  makeTurn,
  replayHistory,
  saveLlmChats,
  summarizeChat,
} from './llm-chats.js';
import { createLlmRunner, type LlmTagSource } from './llm-run.js';
import type { PluginRoutes, PluginSpace, RouteReply } from './types.js';
import { asRecord } from './util.js';

export interface LlmChatRouteHelpers {
  routes: PluginRoutes;
  space: PluginSpace;
  badRequest: (reply: RouteReply, message: string) => unknown;
  log: (message: string) => void;
  tags: () => LlmTagSource;
}

export function registerLlmChatRoutes({ routes, space, badRequest, log, tags }: LlmChatRouteHelpers): void {
  const runner = createLlmRunner({ space, log, tags });

  const disabled = (reply: RouteReply): unknown =>
    reply.code(403).send({ error: { code: 'LLM_DISABLED', message: 'LLM 功能未启用（settings.json 的 llm.enabled = false）' } });
  const notFound = (reply: RouteReply): unknown =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个对话' } });
  const chats = () => loadLlmChats(space);

  routes.get('/llm/chats', async (_request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    return { chats: chats().map((chat) => summarizeChat(chat)) };
  });

  routes.post('/llm/chats', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const body = asRecord(request.body);
    const list = chats();
    if (list.length >= LIMITS.chats) return badRequest(reply, `对话数量已达上限 ${LIMITS.chats} 个，先删几个`);
    const title = body === null ? '' : text(body.title, LIMITS.title);
    const chat = makeChat(title);
    list.unshift(chat);
    saveLlmChats(space, list);
    return { chat };
  });

  routes.get('/llm/chats/:id', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const chat = chats().find((one) => one.id === text(request.params.id, 64));
    if (chat === undefined) return notFound(reply);
    return { chat };
  });

  routes.delete('/llm/chats/:id', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const list = chats();
    const id = text(request.params.id, 64);
    const next = list.filter((one) => one.id !== id);
    if (next.length === list.length) return notFound(reply);
    saveLlmChats(space, next);
    return { ok: true, deleted: id };
  });

  routes.post('/llm/chats/:id/messages', async (request, reply) => {
    if (!runner.enabled()) return disabled(reply);
    const list = chats();
    const chat = list.find((one) => one.id === text(request.params.id, 64));
    if (chat === undefined) return notFound(reply);

    const body = asRecord(request.body);
    const instruction = text(body?.instruction, LIMITS.itemText);
    if (instruction === '') return badRequest(reply, 'instruction 不能为空');
    if (chat.turns.length >= LIMITS.llmTurns) {
      return badRequest(reply, `单个对话最多 ${LIMITS.llmTurns} 轮，另开一个对话吧`);
    }

    // 历史只回放最近若干轮的纯文本：tool 消息一旦被截断就会让 API 报 400
    const result = await runner.run(request.body, replayHistory(chat.turns, LIMITS.llmHistoryTurns));
    if (!result.ok) return reply.code(result.status).send({ error: { code: result.code, message: result.message } });

    const turn = makeTurn(instruction, {
      reply: result.outcome.summary,
      changed: result.outcome.changed,
      created: result.outcome.created,
      deleted: result.outcome.deleted,
      suggestions: result.outcome.suggestions,
      toolCalls: result.outcome.toolCalls,
      aborted: result.outcome.aborted,
      ...(result.outcome.error === undefined ? {} : { error: result.outcome.error }),
    });
    chat.turns.push(turn);
    chat.updatedAt = turn.at;
    if (chat.turns.length === 1) chat.title = chatTitle(instruction);
    saveLlmChats(space, list);
    log(`LLM 对话 ${chat.id} 第 ${chat.turns.length} 轮：${turn.action}`);
    return { turn, chat: summarizeChat(chat) };
  });
}
