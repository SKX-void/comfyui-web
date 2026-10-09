/**
 * 区块库**分类**的路由：`/block-categories`。
 *
 * 分类**按 id 寻址、允许重名**（见 `blockstore.ts` 的头注），所以这里没有"撞名"分支：
 * 改名就是一个 `{ id, name }`，不会有"目标名字已存在"这回事。
 *
 * 端点路径是 `/block-categories` 而不是 `/block-presets/categories` —— 后者会跟
 * 既有的 `/block-presets/:id` 抢同一个位置（同层参数路由），命名上避开。
 */
import { randomUUID } from 'node:crypto';

import {
  BLOCK_PRESETS_FILE,
  LIMITS,
} from './constants.js';
import {
  categorySummaries,
  loadBlockLibrary,
  nextSort,
  reorderCategories,
  saveBlockLibrary,
  uncategorizedCount,
} from './blockstore.js';
import type { RouteHelpers } from './routes-translate.js';
import type { RouteReply } from './types.js';
import { asRecord } from './util.js';

export function registerBlockCategoryRoutes({ routes, space, badRequest, log }: RouteHelpers): void {
  const file = space.resolve(BLOCK_PRESETS_FILE);

  const notFound = (reply: RouteReply): unknown =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个分类' } });

  /** 拉名字：请求体里的名字一律 trim + 截断，空名字当场拒（左栏会出现点不中的空行） */
  const readName = (body: Record<string, unknown> | null): string =>
    typeof body?.name === 'string' ? body.name.slice(0, LIMITS.category).trim() : '';
  const readId = (body: Record<string, unknown> | null): string =>
    typeof body?.id === 'string' ? body.id.trim() : '';

  const readLibrary = () => loadBlockLibrary(file);

  /** 左栏要的东西：分类 + 计数，另外单给一个"未分类"的数（它不是一个分类） */
  routes.get('/block-categories', async () => {
    const library = readLibrary();
    return { categories: categorySummaries(library), uncategorized: uncategorizedCount(library) };
  });

  /** 新建：只加一个名字，**一块都不动**（"先建分类、再往里放块"要走得通） */
  routes.post('/block-categories', async (request, reply) => {
    const name = readName(asRecord(request.body));
    if (name === '') return badRequest(reply, '请求体必须是 { name }');
    const library = readLibrary();
    if (library.categories.length >= LIMITS.blockCategories) {
      return badRequest(reply, `分类已达上限 ${LIMITS.blockCategories} 个，先删掉一些再建`);
    }
    const category = { id: randomUUID(), name, sort: nextSort(library) };
    library.categories.push(category);
    saveBlockLibrary(file, library);
    log(`新增区块分类「${name}」（共 ${library.categories.length} 个）`);
    return reply.code(201).send({ category });
  });

  /** 改名（允许重名，所以没有"不合并 / 报错"这一档） */
  routes.put('/block-categories', async (request, reply) => {
    const body = asRecord(request.body);
    const id = readId(body);
    const name = readName(body);
    if (id === '') return badRequest(reply, '请求体必须是 { id, name }');
    if (name === '') return badRequest(reply, '分类名不能为空');
    const library = readLibrary();
    const index = library.categories.findIndex((one) => one.id === id);
    const current = library.categories[index];
    if (current === undefined) return notFound(reply);
    const next = { ...current, name };
    library.categories[index] = next;
    saveBlockLibrary(file, library);
    return { category: next };
  });

  /**
   * 删一个分类：**里面的块一条都不删**，只是 `categoryId` 清空 = 变未分类。
   * 返回 `cleared`（影响了几块），让面板先把范围摆给人看再确认。
   */
  routes.delete('/block-categories', async (request, reply) => {
    const id = readId(asRecord(request.body));
    if (id === '') return badRequest(reply, '请求体必须是 { id }');
    const library = readLibrary();
    const remaining = library.categories.filter((one) => one.id !== id);
    if (remaining.length === library.categories.length) return { removed: false, cleared: 0 };
    let cleared = 0;
    for (const preset of library.presets) {
      if (preset.categoryId !== id) continue;
      preset.categoryId = '';
      cleared += 1;
    }
    saveBlockLibrary(file, { categories: remaining, presets: library.presets });
    log(`删除区块分类（${cleared} 块变未分类）`);
    return { removed: true, cleared };
  });

  /** 左栏拖完的新顺序。整列重排（见 `reorderCategories`），所以直接回新的左栏数据 */
  routes.put('/block-categories/order', async (request, reply) => {
    const ids = asRecord(request.body)?.ids;
    if (!Array.isArray(ids) || ids.length === 0) return badRequest(reply, '请求体必须是 { ids: [...] }（左栏的新顺序）');
    if (ids.length > LIMITS.blockCategories) return badRequest(reply, `一次最多排 ${LIMITS.blockCategories} 个分类`);
    const clean = ids.filter((one): one is string => typeof one === 'string' && one.trim() !== '');
    if (clean.length !== ids.length) return badRequest(reply, 'ids 里只能是非空字符串');
    const library = readLibrary();
    reorderCategories(library, clean);
    saveBlockLibrary(file, library);
    return { categories: categorySummaries(library) };
  });
}
