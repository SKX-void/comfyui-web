/**
 * 区块库（**预设单块**）的路由与存储：`/block-presets`。
 *
 * 跟 `presets.json`（整份文档）不是一回事：这里是"一块内容"的库 —— 写提示词时看到某一块好用，
 * 存下来，下次插到别的工作区里。存的东西 = 区块的**属性 + 条目文本**：
 *
 * - **不存译文**：译文对应的是当时的词库状态，插进来时按现在的词库重新查才对（存旧的 = 悄悄给错答案）。
 * - **不存条目 id**：插入时新生成（id 只需要在本机文档内唯一，跨文档复用没有意义）。
 *
 * 上限与字段长度都走 `LIMITS`：自用工具也要防"一个坏请求 / 手改坏的文件"把 UI 撑爆。
 */
import { randomUUID } from 'node:crypto';

import { BLOCK_PRESETS_FILE, DEFAULT_COLOR, LIMITS, isMode, type Mode } from './constants.js';
import { text } from './doc.js';
import type { RouteHelpers } from './routes-translate.js';
import { readJson, writeJson } from './store.js';
import type { RouteReply } from './types.js';
import { asRecord } from './util.js';

export interface BlockPreset {
  id: string;
  name: string;
  updatedAt: number;
  /** 区块属性：标题 / 颜色 / 风格，插进来长得跟存的时候一样 */
  title: string;
  color: string;
  mode: Mode;
  /** 条目**文本**（顺序即插入顺序），译文与 id 都不存 */
  items: string[];
}

/** 列表只给摘要：条目可能几百条，面板只需要"这是哪一块、大概什么内容" */
export interface BlockPresetSummary {
  id: string;
  name: string;
  updatedAt: number;
  title: string;
  color: string;
  mode: Mode;
  itemCount: number;
  /** 前几条文本，够认出是哪一块 */
  preview: string[];
}

const PREVIEW = 3;

export function summarize(preset: BlockPreset): BlockPresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    title: preset.title,
    color: preset.color,
    mode: preset.mode,
    itemCount: preset.items.length,
    preview: preset.items.slice(0, PREVIEW),
  };
}

function sanitizeItems(input: unknown): string[] {
  const list = Array.isArray(input) ? input.slice(0, LIMITS.items) : [];
  return list
    .map((item) => text(item, LIMITS.itemText).trim())
    .filter((item) => item !== '')
    .slice(0, LIMITS.items);
}

/** 盘上的数据 / 请求体 → 合法的预设块；形状不对返回 null（调用方给 400 或跳过） */
export function sanitizeBlockPreset(input: unknown): BlockPreset | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  // 名字要 trim：只敲了空格的名字 = 没名字（不然库里会出现一行点不中的空行）
  const name = text(raw.name, LIMITS.name).trim();
  if (name === '') return null;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : randomUUID();
  return {
    id,
    name,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    title: text(raw.title, LIMITS.title),
    color: text(raw.color, LIMITS.color) || DEFAULT_COLOR,
    // 风格认不出来就当 tag：跟 `sanitizeBlockMeta` 同一个兜底
    mode: isMode(raw.mode) ? raw.mode : 'tag',
    items: sanitizeItems(raw.items),
  };
}

export function registerBlockPresetRoutes({ routes, space, badRequest, log }: RouteHelpers): void {
  const file = space.resolve(BLOCK_PRESETS_FILE);

  const load = (): BlockPreset[] => {
    const raw = asRecord(readJson(file, null));
    const list = raw !== null && Array.isArray(raw.presets) ? raw.presets : [];
    return list.map(sanitizeBlockPreset).filter((preset) => preset !== null);
  };
  const save = (list: BlockPreset[]): void => writeJson(file, { version: 1, presets: list });

  const notFound = (reply: RouteReply): unknown =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个预设区块' } });

  routes.get('/block-presets', async () => ({ presets: load().map(summarize) }));

  routes.get('/block-presets/:id', async (request, reply) => {
    const preset = load().find((one) => one.id === request.params.id) ?? null;
    return preset === null ? notFound(reply) : { preset };
  });

  routes.post('/block-presets', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { name, title, color, mode, items }');
    const list = load();
    if (list.length >= LIMITS.blockPresets) {
      return badRequest(reply, `区块库已达上限 ${LIMITS.blockPresets} 条，先删掉一些再存`);
    }
    const preset = sanitizeBlockPreset({ ...body, id: randomUUID(), updatedAt: Date.now() });
    if (preset === null) return badRequest(reply, 'name 不能为空');
    list.push(preset);
    save(list);
    log(`新增预设区块「${preset.name}」（${preset.items.length} 条，共 ${list.length} 条）`);
    return reply.code(201).send({ preset });
  });

  /** 改名（内容不在这里改：想改内容就重新存一块 —— 覆盖保存会让"库里那份到底是什么"变得含糊） */
  routes.put('/block-presets/:id', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { name }');
    const list = load();
    const index = list.findIndex((one) => one.id === request.params.id);
    const current = list[index];
    if (current === undefined) return notFound(reply);
    const name = text(body.name, LIMITS.name).trim();
    if (name === '') return badRequest(reply, 'name 不能为空');
    const next: BlockPreset = { ...current, name, updatedAt: Date.now() };
    list[index] = next;
    save(list);
    return { preset: next };
  });

  routes.delete('/block-presets/:id', async (request) => {
    const list = load();
    const next = list.filter((one) => one.id !== request.params.id);
    if (next.length !== list.length) save(next);
    return { removed: next.length !== list.length };
  });
}
