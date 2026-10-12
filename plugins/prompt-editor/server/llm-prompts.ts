/**
 * 初始提示词的读写：默认值打包在产物 `assets/llm/llm-prompts.json`，
 * 第一次读的时候拷贝进 `ctx.space`，之后用户编辑的是空间里那份。
 *
 * 一份预设 = **有序分段**（像 SillyTavern 的 prompt manager）：每段能单独开关、排序、选角色，
 * 生成时把启用的段按顺序拼起来 —— system 段拼成一条 system 消息，user / assistant 段各成一条消息。
 * 旧的「一份大字符串」（`template`）读到即当成单段 system（不写回；用户下次保存才落新格式）。
 *
 * `{{变量}}` 插值：未知变量置空并记日志（不抛错 —— 模板是用户可编辑的，写错变量不该打断生成）。
 */
import { readFileSync } from 'node:fs';

import { randomUUID } from 'node:crypto';

import { LLM_PROMPTS_FILE, LIMITS } from './constants.js';
import { readJson, writeJson } from './store.js';
import type { PluginSpace } from './types.js';
import { asRecord, isRecord } from './util.js';

export type LlmPromptRole = 'system' | 'user' | 'assistant';

export interface LlmPromptSegment {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  role: LlmPromptRole;
}

export interface LlmPrompt {
  id: string;
  name: string;
  segments: LlmPromptSegment[];
  updatedAt: number;
}

/** 组装结果：system 段拼成一条；user / assistant 段按顺序排在本次指令之前 */
export interface LlmPromptComposition {
  system: string;
  extras: { role: 'user' | 'assistant'; content: string }[];
}

export const LLM_PROMPTS_VERSION = 2;

/** 产物里 server.js 在 tab 根，资产按相对它定位（与 tagcsv.ts 同款） */
const BUNDLED_URL = new URL('./assets/llm/llm-prompts.json', import.meta.url);

export function isLlmPromptRole(value: unknown): value is LlmPromptRole {
  return value === 'system' || value === 'user' || value === 'assistant';
}

export function sanitizePromptSegment(input: unknown, fallbackId: string): LlmPromptSegment | null {
  if (!isRecord(input)) return null;
  const content = typeof input.content === 'string' ? input.content.slice(0, LIMITS.translation) : '';
  // 空段不留：留着只会在界面上碍事
  if (content.trim() === '') return null;
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id.slice(0, 64) : fallbackId,
    name: typeof input.name === 'string' ? input.name.slice(0, LIMITS.name) : '',
    content,
    enabled: input.enabled !== false,
    role: isLlmPromptRole(input.role) ? input.role : 'system',
  };
}

export function sanitizeLlmPrompt(input: unknown, fallbackId: string): LlmPrompt | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === 'string' && input.id !== '' ? input.id.slice(0, 64) : fallbackId;
  const name = typeof input.name === 'string' ? input.name.slice(0, LIMITS.name) : '';
  const raw = Array.isArray(input.segments)
    ? input.segments
    : // 旧格式（一份大字符串）当成单段 system
      typeof input.template === 'string' && input.template.trim() !== ''
      ? [{ name: '主体', content: input.template, role: 'system', enabled: true }]
      : [];
  const segments = raw
    .map((one, index) => sanitizePromptSegment(one, `${id}-seg-${index + 1}`))
    .filter((segment) => segment !== null);
  if (segments.length === 0) return null;
  const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : 0;
  return { id, name, segments, updatedAt };
}

function bundledPrompts(): LlmPrompt[] {
  try {
    const raw = JSON.parse(readFileSync(BUNDLED_URL, 'utf8')) as unknown;
    const record = asRecord(raw);
    const list = record !== null && Array.isArray(record.prompts) ? record.prompts : [];
    return list
      .map((one, index) => sanitizeLlmPrompt(one, `prompt-${index + 1}`))
      .filter((prompt) => prompt !== null);
  } catch {
    return [];
  }
}

/** 读用户空间里的预设；一份都没有时用打包默认值垫底并写盘，之后用户改的是空间那份 */
export function loadLlmPrompts(space: PluginSpace): LlmPrompt[] {
  const file = space.resolve(LLM_PROMPTS_FILE);
  const raw = asRecord(readJson(file, null));
  const list = raw !== null && Array.isArray(raw.prompts) ? raw.prompts : [];
  const prompts = list
    .map((one, index) => sanitizeLlmPrompt(one, `prompt-${index + 1}`))
    .filter((prompt) => prompt !== null);
  if (prompts.length > 0) return prompts;
  const defaults = bundledPrompts();
  if (defaults.length > 0) writeJson(file, { version: LLM_PROMPTS_VERSION, prompts: defaults });
  return defaults;
}

export function interpolatePrompt(
  template: string,
  vars: Record<string, string>,
  log: (message: string) => void,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      log(`模板变量 ${whole} 没有值，已置空`);
      return '';
    }
    return value;
  });
}

/** 把一份预设拼成真正要发的东西：启用的段按顺序拼，system 归一条、user / assistant 各成一条 */
export function composePrompt(
  prompt: LlmPrompt,
  vars: Record<string, string>,
  log: (message: string) => void,
): LlmPromptComposition {
  const parts: string[] = [];
  const extras: LlmPromptComposition['extras'] = [];
  for (const segment of prompt.segments) {
    if (!segment.enabled) continue;
    const content = interpolatePrompt(segment.content, vars, log).trim();
    if (content === '') continue;
    if (segment.role === 'system') parts.push(content);
    else extras.push({ role: segment.role, content });
  }
  return { system: parts.join('\n\n'), extras };
}

export function newPromptId(): string {
  return randomUUID();
}
