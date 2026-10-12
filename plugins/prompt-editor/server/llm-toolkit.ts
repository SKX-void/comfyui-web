/**
 * LLM 写工具的落盘实现（D27）：set_block / suggest + 工作区快照描述。
 *
 * 拆出来的原因：路由文件只做"接口形状与装配"，这里做"工具怎么改草稿"，
 * 两边都压进一个文件会超过 300 行上限。
 */
import { randomUUID } from 'node:crypto';

import { LIMITS } from './constants.js';
import { sanitizeItems, text, type BlockMeta, type Item, type Stored } from './doc.js';
import { splitByMode } from './split.js';
import type { LlmToolKit, LlmToolOutcome } from './llm.js';
import type { Settings } from './settings.js';
import type { TagLookup } from './tags.js';

export interface LlmStats {
  changed: string[];
  created: string[];
  deleted: string[];
  suggestions: { blockId: string; content: string }[];
}

/** 把一块内容按模式切成条目；译文即时查词库（命中填 dict/import，未命中留空由前端刷新后自动译补齐） */
export function buildItems(content: string, mode: string, tags: () => TagLookup): Item[] {
  const lookup = tags();
  const parts = splitByMode(content, mode === 'text' ? 'text' : 'tag').slice(0, LIMITS.items);
  return sanitizeItems(
    parts.map((part) => {
      const hit = lookup.lookup(part);
      return {
        id: randomUUID(),
        text: part,
        enabled: true,
        translation: hit === null ? '' : hit.zh,
        source: hit === null ? '' : hit.source === 'import' ? 'import' : 'dict',
      };
    }),
  );
}

export function makeToolkit(args: {
  settings: Settings;
  stored: Stored;
  writableIds: Set<string>;
  allowCreate: boolean;
  stats: LlmStats;
  saveDraft: (stored: Stored) => void;
  buildItems: (content: string, mode: string) => Item[];
}): LlmToolKit {
  return {
    async setBlock(input): Promise<LlmToolOutcome> {
      const content = text(input.content, LIMITS.itemText);
      if (content === '') return { content: JSON.stringify({ ok: false, error: 'content 不能为空' }) };

      const stored = args.stored;
      const id = text(input.id, 64);
      if (id === '') {
        if (!args.allowCreate) {
          return { content: JSON.stringify({ ok: false, error: '本次请求不允许新建区块（allowCreate = false）' }) };
        }
        const title = text(input.title, LIMITS.title);
        if (title === '') return { content: JSON.stringify({ ok: false, error: '新建区块 title 必填' }) };
        if (stored.structure.length >= LIMITS.blocks) {
          return { content: JSON.stringify({ ok: false, error: `区块数量已达上限 ${LIMITS.blocks} 个` }) };
        }
        const mode = input.mode === 'text' ? 'text' : 'tag';
        const meta: BlockMeta = {
          id: randomUUID(),
          title,
          color: args.settings.llm.newBlockColor,
          mode,
          collapsed: false,
          enabled: true,
          ai: true,
        };
        stored.structure.push(meta);
        stored.items[meta.id] = args.buildItems(content, mode);
        args.saveDraft(stored);
        args.stats.created.push(meta.id);
        return { content: JSON.stringify({ ok: true, created: meta.id, title, mode }) };
      }

      const meta = stored.structure.find((one) => one.id === id);
      if (meta === undefined) return { content: JSON.stringify({ ok: false, error: `区块 ${id} 不存在` }) };
      if (!meta.ai || !args.writableIds.has(id)) {
        return { content: JSON.stringify({ ok: false, error: `区块 ${id} 不在本次可写范围，改用 suggest` }) };
      }
      const mode = input.mode === 'text' || input.mode === 'tag' ? input.mode : meta.mode;
      const title = text(input.title, LIMITS.title);
      if (title !== '') meta.title = title;
      meta.mode = mode;
      meta.enabled = true;
      stored.items[id] = [...args.buildItems(content, mode), ...(stored.items[id] ?? []).filter((item) => !item.enabled)];
      args.saveDraft(stored);
      args.stats.changed.push(id);
      return { content: JSON.stringify({ ok: true, changed: id }) };
    },

    async suggest(input): Promise<LlmToolOutcome> {
      const blockId = text(input.blockId, 64);
      const content = text(input.content, LIMITS.itemText);
      const exists = args.stored.structure.some((meta) => meta.id === blockId);
      if (!exists) return { content: JSON.stringify({ ok: false, error: `区块 ${blockId} 不存在` }) };
      if (content === '') return { content: JSON.stringify({ ok: false, error: 'content 不能为空' }) };
      args.stats.suggestions.push({ blockId, content });
      return { content: JSON.stringify({ ok: true, suggested: blockId }) };
    },
  };
}

export function describeWorkspace(
  stored: Stored,
  writableIds: Set<string>,
  joinContent: (stored: Stored, meta: BlockMeta) => string,
): string {
  if (stored.structure.length === 0) return '工作区是空的。';
  return stored.structure
    .map((meta, index) => {
      const content = joinContent(stored, meta);
      const state = meta.ai && writableIds.has(meta.id) ? '可写' : '只读';
      return `${index + 1}. id=${meta.id} title=${JSON.stringify(meta.title)} mode=${meta.mode} ${state} content=${JSON.stringify(content)}`;
    })
    .join('\n');
}
