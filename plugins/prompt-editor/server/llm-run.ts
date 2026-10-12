/**
 * 一次生成的公共内核（D27/D28）：总闸 → 配额 → 可写范围 → 模板 → agent loop。
 *
 * `/llm/generate`（一次性）与 `/llm/chats/:id/messages`（多轮）共用它 —— 权限、计数、
 * 落盘语义只写一遍，两处不会漂移。失败用 `{ ok: false, status, code }` 表达：
 * HTTP 只有路由层认识，内核不碰 reply。
 */
import { DRAFT_FILE, LIMITS, SETTINGS_FILE, USAGE_FILE } from './constants.js';
import { rawFromStored, storedFromRaw, text, type BlockMeta, type Stored } from './doc.js';
import { runLlmAgent } from './llm.js';
import type { LlmMessage } from './llm-providers.js';
import { composePrompt, loadLlmPrompts } from './llm-prompts.js';
import { buildItems, describeWorkspace, makeToolkit, type LlmStats } from './llm-toolkit.js';
import { isLlmReasoning, sanitizeSettings, sanitizeUsage, type Settings } from './settings.js';
import { readJson, writeJson } from './store.js';
import type { TagLookup } from './tags.js';
import type { PluginSpace } from './types.js';
import { asRecord } from './util.js';

/** 条目拼回一段文本：tag 用 ", "、text 用 " "（与前端 renderOutput 同规则） */
const CONTENT_SEPARATOR: Record<string, string> = { tag: ', ', text: ' ' };

export function joinBlockContent(stored: Stored, meta: BlockMeta): string {
  const items = (stored.items[meta.id] ?? []).filter((item) => item.enabled && item.text.trim() !== '');
  return items.map((item) => item.text.trim()).join(CONTENT_SEPARATOR[meta.mode] ?? ', ');
}

export interface LlmRunOutcome {
  changed: string[];
  created: string[];
  deleted: string[];
  suggestions: { blockId: string; content: string }[];
  summary: string;
  toolCalls: number;
  aborted: boolean;
  error?: { code: string; message: string };
}

export type LlmRunResult =
  | { ok: true; outcome: LlmRunOutcome }
  | { ok: false; status: number; code: string; message: string };

export interface LlmRunner {
  /** `body` 是原始请求体：校验（含总闸）都在这里，路由层只转发；`history` 是多轮对话的回放 */
  run(body: unknown, history?: LlmMessage[]): Promise<LlmRunResult>;
  enabled(): boolean;
  /** 新建 AI 块用的颜色（settings.llm.newBlockColor）：手工建块的路由也要跟设置一致 */
  color(): string;
  loadDraft(): Stored;
}

export function createLlmRunner(deps: {
  space: PluginSpace;
  log: (message: string) => void;
  tags: () => TagLookup;
}): LlmRunner {
  const { space, log, tags } = deps;
  const settingsFile = space.resolve(SETTINGS_FILE);
  const usageFile = space.resolve(USAGE_FILE);
  const draftFile = space.resolve(DRAFT_FILE);

  const today = (): string => new Date().toISOString().slice(0, 10);
  const loadSettings = (): Settings => sanitizeSettings(readJson(settingsFile, null));
  const loadUsage = () => sanitizeUsage(readJson(usageFile, null), today());
  const loadDraft = (): Stored => storedFromRaw(readJson(draftFile, null)) ?? { structure: [], items: {} };
  const saveDraft = (stored: Stored): void => writeJson(draftFile, rawFromStored(stored));

  const fail = (status: number, code: string, message: string): LlmRunResult => ({ ok: false, status, code, message });

  async function run(body: unknown, history?: LlmMessage[]): Promise<LlmRunResult> {
    const settings = loadSettings();
    if (!settings.llm.enabled) {
      return fail(403, 'LLM_DISABLED', 'LLM 功能未启用（settings.json 的 llm.enabled = false）');
    }

    const raw = asRecord(body);
    if (raw === null) return fail(400, 'BAD_REQUEST', '请求体必须是 { instruction, ... }');
    const instruction = text(raw.instruction, LIMITS.itemText);
    if (instruction === '') return fail(400, 'BAD_REQUEST', 'instruction 不能为空');

    // 一次提交 = 1 次用量（内部多轮 tool call 不另计）；先扣再跑，跑挂了也不退
    const usage = loadUsage();
    if (usage.llmCalls >= settings.llm.maxCallsPerDay) {
      return fail(429, 'LLM_QUOTA', '今日 LLM 调用次数已用完，明天自动恢复');
    }
    usage.llmCalls += 1;
    writeJson(usageFile, usage);

    const blockIds = Array.isArray(raw.blockIds)
      ? raw.blockIds.filter((one): one is string => typeof one === 'string')
      : [];
    const allowCreate = raw.allowCreate !== false;
    // 推理强度是单次请求的参数（D29）：认不出的值（含没传）一律 off
    const reasoning = isLlmReasoning(raw.reasoning) ? raw.reasoning : 'off';
    const stored = loadDraft();
    const writableIds = new Set(
      stored.structure.filter((meta) => meta.ai === true && blockIds.includes(meta.id)).map((meta) => meta.id),
    );
    if (writableIds.size === 0 && !allowCreate) {
      return fail(400, 'BAD_REQUEST', '没有可写的 AI 区块（blockIds 里没有 ai 标记的块），且 allowCreate = false');
    }

    const prompts = loadLlmPrompts(space);
    const promptId = typeof raw.promptId === 'string' ? raw.promptId : '';
    const prompt = (promptId === '' ? prompts[0] : prompts.find((one) => one.id === promptId)) ?? null;
    if (prompt === null) return fail(400, 'BAD_REQUEST', '没有这个初始提示词模板（promptId）');

    const stats: LlmStats = { changed: [], created: [], deleted: [], suggestions: [] };
    const toolkit = makeToolkit({
      settings,
      stored,
      writableIds,
      allowCreate,
      stats,
      saveDraft,
      buildItems: (content, mode) => buildItems(content, mode, tags),
    });

    const composition = composePrompt(
      prompt,
      { workspace: describeWorkspace(stored, writableIds, joinBlockContent), instruction },
      log,
    );
    const outcome = await runLlmAgent({
      llm: settings.llm,
      reasoning,
      system: composition.system,
      extras: composition.extras,
      user: instruction,
      toolkit,
      history,
    });

    return {
      ok: true,
      outcome: {
        changed: stats.changed,
        created: stats.created,
        deleted: stats.deleted,
        suggestions: stats.suggestions,
        summary: outcome.summary,
        toolCalls: outcome.toolCalls,
        aborted: outcome.aborted,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
    };
  }

  return { run, enabled: () => loadSettings().llm.enabled, color: () => loadSettings().llm.newBlockColor, loadDraft };
}
