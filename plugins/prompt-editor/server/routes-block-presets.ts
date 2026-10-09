/**
 * 区块库（**预设单块**）的路由：`/block-presets`。
 *
 * 跟 `presets.json`（整份文档）不是一回事：这里是"一块内容"的库 —— 写提示词时看到某一块好用，
 * 存下来，下次插到别的工作区里。存的东西 = 区块的**属性 + 条目文本**：
 *
 * - **不存译文**：译文对应的是当时的词库状态，插进来时按现在的词库重新查才对（存旧的 = 悄悄给错答案）。
 * - **不存条目 id**：插入时新生成（id 只需要在本机文档内唯一，跨文档复用没有意义）。
 *
 * 落盘的形状与读写都在 `blockstore.ts`（分类路由在 `routes-block-categories.ts`），
 * 这里只管"这一块"的增删改查。
 *
 * 分类（`categoryId`）是**库这一侧**的属性：插进工作区时不带走 —— 所以区块表头送来的快照里
 * 没有它，归类只能在面板里发生（存的时候选一个，或者事后把行拖到左栏的分类上）。顺序同理，
 * 只属于这份库（`PUT /order`）。
 *
 * 上限与字段长度都走 `LIMITS`：自用工具也要防"一个坏请求 / 手改坏的文件"把 UI 撑爆。
 */
import { randomUUID } from 'node:crypto';

import { BLOCK_PRESETS_FILE, LIMITS } from './constants.js';
import {
  knownCategoryId,
  loadBlockLibrary,
  reorderBlockPresets,
  sanitizeBlockPreset,
  saveBlockLibrary,
  summarize,
  type BlockPreset,
} from './blockstore.js';
import type { RouteHelpers } from './routes-translate.js';
import type { RouteReply } from './types.js';
import { asRecord } from './util.js';

export function registerBlockPresetRoutes({ routes, space, badRequest, log }: RouteHelpers): void {
  const file = space.resolve(BLOCK_PRESETS_FILE);

  const notFound = (reply: RouteReply): unknown =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个预设区块' } });

  routes.get('/block-presets', async () => {
    const library = loadBlockLibrary(file);
    return { presets: library.presets.map(summarize) };
  });

  routes.get('/block-presets/:id', async (request, reply) => {
    const preset = loadBlockLibrary(file).presets.find((one) => one.id === request.params.id) ?? null;
    return preset === null ? notFound(reply) : { preset };
  });

  routes.post('/block-presets', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { name, title, color, mode, items }');
    const library = loadBlockLibrary(file);
    if (library.presets.length >= LIMITS.blockPresets) {
      return badRequest(reply, `区块库已达上限 ${LIMITS.blockPresets} 条，先删掉一些再存`);
    }
    const preset = sanitizeBlockPreset({ ...body, id: randomUUID(), updatedAt: Date.now() });
    if (preset === null) return badRequest(reply, 'name 不能为空');
    // 分类认不出就当未分类：面板只会送已存在的 id，送来的认不出通常是分类刚被另一个页面删了，
    // 存一块不该因为分类没了而失败
    preset.categoryId = knownCategoryId(library, preset.categoryId);
    library.presets.push(preset);
    saveBlockLibrary(file, library);
    log(`新增预设区块「${preset.name}」（${preset.items.length} 条，共 ${library.presets.length} 条）`);
    return reply.code(201).send({ preset });
  });

  /**
   * 列表拖完的新顺序。整列重排（`ids` = 全量，见 `reorderBlockPresets`），回新列表。
   *
   * 注册在 `/:id` **之前**：`order` 是个合法 id 的样子，靠注册顺序兜底（不指望路由器
   * 会优先匹配静态段）。
   */
  routes.put('/block-presets/order', async (request, reply) => {
    const ids = asRecord(request.body)?.ids;
    if (!Array.isArray(ids) || ids.length === 0) return badRequest(reply, '请求体必须是 { ids: [...] }（列表的新顺序）');
    if (ids.length > LIMITS.blockPresets) return badRequest(reply, `一次最多排 ${LIMITS.blockPresets} 条`);
    const clean = ids.filter((one): one is string => typeof one === 'string' && one.trim() !== '');
    if (clean.length !== ids.length) return badRequest(reply, 'ids 里只能是非空字符串');
    const library = loadBlockLibrary(file);
    reorderBlockPresets(library, clean);
    saveBlockLibrary(file, library);
    return { presets: library.presets.map(summarize) };
  });

  /**
   * 改名 / 改归类。**条目内容不在这里改**（想改内容就重新存一块 —— 覆盖保存会让"库里那份到底是什么"
   * 变得含糊）；分类是库这一侧的属性，所以它跟名字一样允许事后改。
   */
  routes.put('/block-presets/:id', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return badRequest(reply, '请求体必须是 { name?, categoryId? }');
    const library = loadBlockLibrary(file);
    const index = library.presets.findIndex((one) => one.id === request.params.id);
    const current = library.presets[index];
    if (current === undefined) return notFound(reply);

    const next: BlockPreset = { ...current };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') return badRequest(reply, 'name 不能为空');
      next.name = body.name.slice(0, LIMITS.name).trim();
    }
    // `categoryId: ''` 是"移到未分类"的**正常**请求，所以这里判的是 `!== undefined` 而不是真值
    if (body.categoryId !== undefined) {
      const wanted = typeof body.categoryId === 'string' ? body.categoryId.slice(0, 64) : '';
      next.categoryId = knownCategoryId(library, wanted);
    }
    next.updatedAt = Date.now();
    library.presets[index] = next;
    saveBlockLibrary(file, library);
    return { preset: next };
  });

  routes.delete('/block-presets/:id', async (request) => {
    const library = loadBlockLibrary(file);
    const remaining = library.presets.filter((one) => one.id !== request.params.id);
    const removed = remaining.length !== library.presets.length;
    if (removed) saveBlockLibrary(file, { categories: library.categories, presets: remaining });
    return { removed };
  });
}
