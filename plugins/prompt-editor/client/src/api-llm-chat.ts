/**
 * 多轮对话的接口层（D28）：会话的建 / 列 / 读 / 删 + 发一条消息。
 *
 * 与 `api-llm.ts` 分开只是因为它只管"对话"这一件事 —— 那边是区块与模板。
 * 一次 `sendChatMessage` = 后端一次 llmCalls（内部多轮 tool call 不另计）。
 */
import { request } from './api-core';
import type { LlmSuggestion } from './api-llm';
import type { LlmReasoning } from './api';

/** 一轮对话：用户说了什么、AI 回了什么、这一轮动了哪些块 */
export interface LlmTurn {
  at: number;
  instruction: string;
  reply: string;
  action: string;
  changed: string[];
  created: string[];
  deleted: string[];
  suggestions: LlmSuggestion[];
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

/** 列表里那份：不带 turns 正文，只给轮数（会话多了不该把全文都拖过来） */
export interface LlmChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

export interface LlmSendRequest {
  instruction: string;
  promptId?: string;
  blockIds?: string[];
  allowCreate?: boolean;
  /** 推理强度（D29）：单次请求的参数，缺省 off */
  reasoning?: LlmReasoning;
}

export async function fetchChats(): Promise<LlmChatSummary[]> {
  return (await request<{ chats: LlmChatSummary[] }>('/llm/chats')).chats;
}

export async function createChat(title?: string): Promise<LlmChat> {
  const body = title === undefined || title === '' ? {} : { title };
  return (await request<{ chat: LlmChat }>('/llm/chats', { method: 'POST', body: JSON.stringify(body) })).chat;
}

export async function fetchChat(id: string): Promise<LlmChat> {
  return (await request<{ chat: LlmChat }>(`/llm/chats/${encodeURIComponent(id)}`)).chat;
}

export async function deleteChat(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/llm/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function sendChatMessage(
  id: string,
  message: LlmSendRequest,
): Promise<{ turn: LlmTurn; chat: LlmChatSummary }> {
  return await request<{ turn: LlmTurn; chat: LlmChatSummary }>(`/llm/chats/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify(message),
  });
}
