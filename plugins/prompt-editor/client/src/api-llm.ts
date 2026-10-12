/**
 * LLM 辅助接口（D27）：/llm/* 都在这里，调用方从 './api' 取（api.ts 转出）。
 */
import { request } from './api-core';
import type { Mode } from './model';

/** GET /llm/blocks 的摘要：不带条目，只够画"AI 能改哪些块"的多选清单 */
export interface LlmBlockSummary {
  id: string;
  title: string;
  mode: Mode;
  ai: boolean;
  itemCount: number;
}

export interface LlmBlockDetail {
  id: string;
  title: string;
  mode: Mode;
  ai: boolean;
  /** 启用的非空条目按块模式拼成的一份内容 */
  content: string;
}

export interface LlmPrompt {
  id: string;
  name: string;
  template: string;
  updatedAt: number;
}

export interface LlmSuggestion {
  blockId: string;
  content: string;
}

export interface LlmToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface LlmGenerateOutcome {
  changed: string[];
  created: string[];
  deleted: string[];
  suggestions: LlmSuggestion[];
  summary: string;
  toolCalls: LlmToolCall[];
  aborted?: boolean;
  error?: { code: string; message: string };
}

export async function fetchLlmBlocks(): Promise<LlmBlockSummary[]> {
  return (await request<{ blocks: LlmBlockSummary[] }>('/llm/blocks')).blocks;
}

export async function fetchLlmBlock(idOrName: string): Promise<LlmBlockDetail> {
  return (await request<{ block: LlmBlockDetail }>(`/llm/blocks/${encodeURIComponent(idOrName)}`)).block;
}

export async function updateLlmBlock(
  idOrName: string,
  patch: { title?: string; mode?: Mode; content?: string },
): Promise<LlmBlockDetail> {
  return (
    await request<{ block: LlmBlockDetail }>(`/llm/blocks/${encodeURIComponent(idOrName)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  ).block;
}

export async function createLlmBlocks(blocks: { title: string; mode?: Mode; content: string }[]): Promise<string[]> {
  return (await request<{ created: string[] }>('/llm/blocks', {
    method: 'POST',
    body: JSON.stringify({ blocks }),
  })).created;
}

export async function deleteLlmBlock(idOrName: string): Promise<void> {
  await request<{ ok: boolean }>(`/llm/blocks/${encodeURIComponent(idOrName)}`, { method: 'DELETE' });
}

export async function fetchLlmPrompts(): Promise<LlmPrompt[]> {
  return (await request<{ prompts: LlmPrompt[] }>('/llm/prompts')).prompts;
}

export async function saveLlmPrompts(prompts: { id?: string; name: string; template: string }[]): Promise<LlmPrompt[]> {
  return (
    await request<{ prompts: LlmPrompt[] }>('/llm/prompts', {
      method: 'PUT',
      body: JSON.stringify({ prompts }),
    })
  ).prompts;
}

export interface LlmGenerateRequest {
  instruction: string;
  promptId?: string;
  blockIds?: string[];
  allowCreate?: boolean;
}

/** 一次提交 = 1 次 llmCalls（服务端配额）；中途失败不回滚已落盘的块 */
export async function generateLlm(req: LlmGenerateRequest): Promise<LlmGenerateOutcome> {
  return request<LlmGenerateOutcome>('/llm/generate', { method: 'POST', body: JSON.stringify(req) });
}
