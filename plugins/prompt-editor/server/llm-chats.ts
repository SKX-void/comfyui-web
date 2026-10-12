/**
 * 多轮对话的存储与回放（D28）：`llm-chats.json` 落在 `ctx.space`，重启后还在。
 *
 * 回放策略：只把「用户说了什么 + 上一轮答了什么、动了哪些块」当**纯文本**回放，
 * 不回放 tool_calls / tool 消息 —— 那要求 assistant(tool_calls) 与 tool 消息严格配对，
 * 一旦按条数截断就会让 API 报 400。纯文本既够模型接着聊，也不会因截断而坏。
 */
import { randomUUID } from 'node:crypto';

import { LIMITS, LLM_CHATS_FILE } from './constants.js';
import { text } from './doc.js';
import type { LlmMessage } from './llm-providers.js';
import { readJson, writeJson } from './store.js';
import type { PluginSpace } from './types.js';
import { asRecord, isRecord } from './util.js';

export interface LlmTurn {
  at: number;
  instruction: string;
  reply: string;
  action: string;
  changed: string[];
  created: string[];
  deleted: string[];
  suggestions: { blockId: string; content: string }[];
  toolCalls: number;
  aborted: boolean;
  error?: { code: string; message: string };
}

export interface LlmChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: LlmTurn[];
}

/** 列表里只给摘要：会话可能很长，列表不该拖着全部消息走 */
export interface LlmChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

function strList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === 'string').slice(0, limit);
}

function stamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}

/** 人话动作摘要：回放给模型 + 显示给人，两处共用同一句 */
export function turnAction(turn: Pick<LlmTurn, 'changed' | 'created' | 'deleted' | 'suggestions'>): string {
  const parts: string[] = [];
  if (turn.changed.length > 0) parts.push(`改了 ${turn.changed.length} 块`);
  if (turn.created.length > 0) parts.push(`新建 ${turn.created.length} 块`);
  if (turn.deleted.length > 0) parts.push(`删除 ${turn.deleted.length} 块`);
  if (turn.suggestions.length > 0) parts.push(`${turn.suggestions.length} 条建议`);
  return parts.length === 0 ? '没动任何块' : parts.join('、');
}

export function sanitizeTurn(input: unknown): LlmTurn | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  const instruction = text(raw.instruction, LIMITS.itemText);
  if (instruction === '') return null;
  const suggestions: { blockId: string; content: string }[] = [];
  if (Array.isArray(raw.suggestions)) {
    for (const one of raw.suggestions) {
      if (!isRecord(one)) continue;
      const blockId = text(one.blockId, 64);
      const content = text(one.content, LIMITS.itemText);
      if (blockId !== '' && content !== '') suggestions.push({ blockId, content });
    }
  }
  const turn: LlmTurn = {
    at: stamp(raw.at),
    instruction,
    reply: text(raw.reply, LIMITS.itemText),
    action: text(raw.action, LIMITS.title),
    changed: strList(raw.changed, LIMITS.blocks),
    created: strList(raw.created, LIMITS.blocks),
    deleted: strList(raw.deleted, LIMITS.blocks),
    suggestions: suggestions.slice(0, LIMITS.blocks),
    toolCalls: typeof raw.toolCalls === 'number' ? Math.max(0, Math.floor(raw.toolCalls)) : 0,
    aborted: raw.aborted === true,
  };
  const error = asRecord(raw.error);
  if (error !== null) {
    turn.error = { code: text(error.code, 64), message: text(error.message, LIMITS.itemText) };
  }
  if (turn.action === '') turn.action = turnAction(turn);
  return turn;
}

export function sanitizeChat(input: unknown): LlmChat | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  const turns = (Array.isArray(raw.turns) ? raw.turns : [])
    .map((one) => sanitizeTurn(one))
    .filter((turn): turn is LlmTurn => turn !== null)
    .slice(-LIMITS.llmTurns);
  return {
    id: text(raw.id, 64) || randomUUID(),
    title: text(raw.title, LIMITS.title) || '新对话',
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
    turns,
  };
}

export function loadLlmChats(space: PluginSpace): LlmChat[] {
  const raw = asRecord(readJson(space.resolve(LLM_CHATS_FILE), null));
  const list = raw !== null && Array.isArray(raw.chats) ? raw.chats : [];
  return list
    .map((one) => sanitizeChat(one))
    .filter((chat): chat is LlmChat => chat !== null)
    .slice(0, LIMITS.chats);
}

export function saveLlmChats(space: PluginSpace, chats: LlmChat[]): void {
  writeJson(space.resolve(LLM_CHATS_FILE), { version: 1, chats: chats.slice(0, LIMITS.chats) });
}

/** 新对话的标题 = 第一句话的前 24 字（省得用户自己起名） */
export function chatTitle(instruction: string): string {
  const line = instruction.replace(/\s+/g, ' ').trim();
  return line === '' ? '新对话' : line.slice(0, 24);
}

export function summarizeChat(chat: LlmChat): LlmChatSummary {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, turns: chat.turns.length };
}

export function makeChat(instruction: string): LlmChat {
  const now = Date.now();
  return { id: randomUUID(), title: chatTitle(instruction), createdAt: now, updatedAt: now, turns: [] };
}

export function makeTurn(instruction: string, outcome: {
  reply: string;
  changed: string[];
  created: string[];
  deleted: string[];
  suggestions: { blockId: string; content: string }[];
  toolCalls: number;
  aborted: boolean;
  error?: { code: string; message: string };
}): LlmTurn {
  const base = { changed: outcome.changed, created: outcome.created, deleted: outcome.deleted, suggestions: outcome.suggestions };
  return {
    at: Date.now(),
    instruction,
    reply: outcome.reply,
    action: turnAction(base),
    ...base,
    toolCalls: outcome.toolCalls,
    aborted: outcome.aborted,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

/** 只回放最近 `limit` 轮：对话可以很长，送进模型的部分必须有界 */
export function replayHistory(turns: LlmTurn[], limit: number): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const turn of turns.slice(-limit)) {
    messages.push({ role: 'user', content: turn.instruction });
    messages.push({ role: 'assistant', content: `${turn.reply}\n（本轮动作：${turn.action}）` });
  }
  return messages;
}
