/**
 * LLM 写工具的落盘实现（D27）：set_block / suggest + 工作区快照描述；查库工具 search_tags（D32）。
 *
 * 拆出来的原因：路由文件只做"接口形状与装配"，这里做"工具怎么改草稿"，
 * 两边都压进一个文件会超过 300 行上限。
 */
import { randomUUID } from 'node:crypto';

import { LIMITS } from './constants.js';
import { freeBlockId, sanitizeItems, text, type BlockMeta, type Item, type Stored } from './doc.js';
import { splitByMode } from './split.js';
import type { LlmToolKit, LlmToolOutcome } from './llm.js';
import type { Settings } from './settings.js';
import type { TagEntry, TagLookup, TagSearch } from './tags.js';

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
  tagSearch: TagSearch;
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
          id: freeBlockId(stored.structure),
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

    async searchTags(input): Promise<LlmToolOutcome> {
      const query = text(input.query, LIMITS.name);
      if (query === '') return { content: JSON.stringify({ ok: false, error: 'query 不能为空' }) };
      const found = args.tagSearch.query({ q: query, limit: SEARCH_MATCHES });
      const matches = found.tags.map(tagBrief);
      // 共现邻居取第一条命中：搜索是模糊的，"最像想查的那个"就排在第一（面板同一套排序）
      const best = found.tags[0];
      const related =
        input.includeRelated === true && best !== undefined
          ? args.tagSearch.cooccur(best.en, SEARCH_RELATED).map((one) => one.en)
          : [];
      return {
        content: JSON.stringify({
          ok: true,
          matches,
          more: found.total > matches.length,
          related,
          // 一条都没命中时得把"库外不是禁区"再说一遍：这正是模型最容易改成保守写法的一刻
          ...(matches.length === 0
            ? { note: '库内没有匹配：换个更常见的说法再查，或者直接照你的判断写（词库只是参考，不是白名单）' }
            : {}),
        }),
      };
    },
  };
}

/** 一次查询回给模型的最大条数：工具结果直接进上下文，条数就是 token 预算 */
const SEARCH_MATCHES = 8;
const SEARCH_RELATED = 10;

/** 一条命中压成模型真正用得上的几项：正名（要照抄的写法）、中文、首个分类、头几个别名 */
function tagBrief(entry: TagEntry): Record<string, unknown> {
  return { tag: entry.en, zh: entry.zh, category: entry.categories[0] ?? '', aliases: entry.aliases.slice(0, 3) };
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
