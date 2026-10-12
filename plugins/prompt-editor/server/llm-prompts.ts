/**
 * 初始提示词（LLM 系统提示词模板）的读写：默认值打包在产物 `assets/llm/llm-prompts.json`，
 * 第一次读的时候拷贝进 `ctx.space`，之后用户编辑的是空间里那份（多份机制保留，默认只给一份通用模板）。
 *
 * `{{变量}}` 插值：未知变量置空并记日志（不抛错 —— 模板是用户可编辑的，写错变量不该打断生成）。
 */
import { readFileSync } from 'node:fs';

import { randomUUID } from 'node:crypto';

import { LLM_PROMPTS_FILE, LIMITS } from './constants.js';
import { readJson, writeJson } from './store.js';
import type { PluginSpace } from './types.js';
import { asRecord, isRecord } from './util.js';

export interface LlmPrompt {
  id: string;
  name: string;
  template: string;
  updatedAt: number;
}

/** 产物里 server.js 在 tab 根，资产按相对它定位（与 tagcsv.ts 同款） */
const BUNDLED_URL = new URL('./assets/llm/llm-prompts.json', import.meta.url);

export function sanitizeLlmPrompt(input: unknown, fallbackId: string): LlmPrompt | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === 'string' && input.id !== '' ? input.id.slice(0, 64) : fallbackId;
  const name = typeof input.name === 'string' ? input.name.slice(0, LIMITS.name) : '';
  const template = typeof input.template === 'string' ? input.template.slice(0, LIMITS.translation) : '';
  if (template === '') return null;
  const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : 0;
  return { id, name, template, updatedAt };
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

/** 读用户空间里的模板；一份都没有时用打包默认值垫底并写盘，之后用户改的是空间那份 */
export function loadLlmPrompts(space: PluginSpace): LlmPrompt[] {
  const file = space.resolve(LLM_PROMPTS_FILE);
  const raw = asRecord(readJson(file, null));
  const list = raw !== null && Array.isArray(raw.prompts) ? raw.prompts : [];
  const prompts = list
    .map((one, index) => sanitizeLlmPrompt(one, `prompt-${index + 1}`))
    .filter((prompt) => prompt !== null);
  if (prompts.length > 0) return prompts;
  const defaults = bundledPrompts();
  if (defaults.length > 0) writeJson(file, { version: 1, prompts: defaults });
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

export function newPromptId(): string {
  return randomUUID();
}
