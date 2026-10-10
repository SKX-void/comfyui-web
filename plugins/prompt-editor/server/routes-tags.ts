/**
 * 词库的路由：`/tags*`（面板那一摊 —— 搜索 / 分类树 / 手动排序 / 导入产物自带的表）。
 *
 * 从 `routes-translate.ts` 拆出来（那里原本 300 行，塞不下导入那一段了）。**连接不归这里管**：
 * `tags()` 是 `registerTranslateRoutes` 里那个长持句柄的访问器，由它统一开、统一在收尾里关
 * （见 `routes.ts` 的 `ctx.effect`）—— 两处各开一个 `DatabaseSync` 就是两份 WAL 写入者。
 *
 * 这一层只管"请求长什么样 → 调哪几个存储方法"，判定规则全在 `tagdb.ts` / `tagcsv.ts` 里，
 * 命令行（`scripts/import-tags.ts`）与面板共用同一份解析。
 */
import fs from 'node:fs';

import { LIMITS } from './constants.js';
import {
  BUNDLED_BUILTIN,
  BUNDLED_COOC,
  BUNDLED_CSV,
  looksLikeLfsPointer,
  parseCooccurTsv,
  parseTagCsv,
  type TagCsvStats,
} from './tagcsv.js';
import type { ImportGuard, TagDb } from './tagdb.js';
import type { TagSource } from './tags.js';
import type { RouteHelpers } from './routes-translate.js';
import { asRecord } from './util.js';

export function registerTagRoutes({
  routes,
  badRequest,
  log,
  tags,
}: RouteHelpers & { tags: () => TagDb }): void {
  /** 一次写多少条让出一次事件循环（见 `POST /tags/import`） */
  const IMPORT_CHUNK = 20000;
  /** 导入进行中：连点两次按钮 / 两个页面同时点，第二次直接回 409（写是幂等的，但报数会互相骗） */
  let importing = false;

  /** 产物里的一层词库表：文件 + 它算什么来源 + 导入守卫（见 `tagdb.ts` 的 `ImportGuard`） */
  interface LayerSpec {
    file: URL;
    name: string;
    source: TagSource;
    guard: ImportGuard;
    keepPlaceholders: boolean;
  }
  /** 一层导完的报数：面板 / 日志都拿它说话 */
  interface ImportedLayer {
    name: string;
    rows: number;
    written: number;
    stats: TagCsvStats;
  }

  /** 读一层词库表并落库（分批让出事件循环）。读不了 / 是 lfs 指针时抛出去，由路由回 400 */
  const importLayer = async (db: TagDb, spec: LayerSpec): Promise<ImportedLayer> => {
    const text = fs.readFileSync(spec.file, 'utf8');
    // 源码里这两份 CSV 走 git-lfs：没装 lfs / 跳了 smudge 时这里躺着的是 130 字节的指针，
    // 不当心的话就是"导入成功，入库 0 条"——那比报错难查得多
    if (looksLikeLfsPointer(text)) {
      throw new Error(`${spec.file.pathname.split('/').pop() ?? spec.name} 是 git-lfs 指针（不是真文件）：先 git lfs pull 再重新构建`);
    }
    const { rows, stats, parents } = parseTagCsv(text, {
      keepPlaceholders: spec.keepPlaceholders,
      defaultSource: spec.source,
    });
    let written = 0;
    for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
      written += db.importEntries(rows.slice(i, i + IMPORT_CHUNK), parents, spec.guard);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { name: spec.name, rows: rows.length, written, stats };
  };

  /**
   * 词库列表：面板用（搜索 / 按分类筛 / 分类计数）。
   * 一张表两用 —— 这里只管"管理"那一半，"用"那一半是翻译时按 en/别名命中。
   */
  routes.get('/tags', async (request) => {
    const query = request.query ?? {};
    return tags().query({
      q: typeof query.q === 'string' ? query.q : '',
      category: typeof query.category === 'string' ? query.category : '',
      limit: query.limit,
    });
  });

  /**
   * 一个词的共现邻居（"常跟它一起出现的词"）。**按需查、不进列表查询**：面板一页 200 条，
   * 每条都带一份邻居就是 200 次 JOIN —— 只有当前展开/编辑的那一条需要它。
   */
  routes.get('/tags/neighbors', async (request) => {
    const query = request.query ?? {};
    const en = typeof query.en === 'string' ? query.en : '';
    return { tags: tags().cooccur(en, Number(query.limit) || 20) };
  });

  /**
   * 写一条 / 改一条：手改译文、点「机」存进词库、面板里改分类或别名，都走这里。
   * 默认 `source:'user'`（= 人认可的）；将来做导入时显式传 `import` / `builtin`。
   */
  routes.put('/tags/entry', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object') return badRequest(reply, '请求体必须是 { en, zh, categories?, aliases? }');
    const entry = tags().upsert(asRecord(body) ?? {});
    if (entry === null) return badRequest(reply, '需要 en 和 zh（译文不能是空的）');
    return { ok: true, entry };
  });

  /**
   * 手动排序：面板里把一行拖到别的位置之后，把**当前这一页的新顺序**（`keys`）和
   * **被拖的那一条**（`moved`）发过来。服务端取左右邻居的中点，只写 1 行（见 `TagDb.setOrder`）。
   *
   * 为什么要发整页：顺序是相对一整页说的，而"这一页"带着搜索 / 分类筛选，服务端自己猜不出来。
   * `moved` 告诉它"哪一条动了"，不然它没法从一串 key 里看出该改哪一行。
   */
  routes.put('/tags/order', async (request, reply) => {
    const body = asRecord(request.body);
    const keys = body?.keys;
    const moved = body?.moved;
    if (!Array.isArray(keys) || keys.length === 0) return badRequest(reply, '请求体必须是 { keys: [...] }（当前这一页的新顺序）');
    if (keys.length > LIMITS.orderKeys) return badRequest(reply, `一次最多排 ${LIMITS.orderKeys} 条`);
    if (moved !== undefined && moved !== null && typeof moved !== 'string') return badRequest(reply, 'moved 必须是正名字符串');
    const clean = keys.filter((one): one is string => typeof one === 'string' && one.trim() !== '');
    if (clean.length !== keys.length) return badRequest(reply, 'keys 里只能是正名字符串');
    return { ok: true, ...tags().setOrder(clean, typeof moved === 'string' ? moved : null) };
  });

  /**
   * 分类树的手动顺序。跟 `/tags/order` 同一套（`names` = 这一列的新顺序，`moved` = 被拖的那个），
   * 区别是**第一次拖就整树铺序号** —— 分类只有几个，不用"手动的是前缀"那套。
   *
   * 面板发上来的 `names` **只有顶级分类**：小类的位置由它的 `parent` 决定（两级树按 parent 分组
   * 渲染），拖它没有视觉结果，所以面板不给手柄、也不进这个名单。
   */
  routes.put('/tags/categories/order', async (request, reply) => {
    const body = asRecord(request.body);
    const names = body?.names;
    const moved = body?.moved;
    if (!Array.isArray(names) || names.length === 0) return badRequest(reply, '请求体必须是 { names: [...] }（分类树的新顺序）');
    if (names.length > LIMITS.orderKeys) return badRequest(reply, `一次最多排 ${LIMITS.orderKeys} 个分类`);
    if (moved !== undefined && moved !== null && typeof moved !== 'string') return badRequest(reply, 'moved 必须是分类名字符串');
    const clean = names.filter((one): one is string => typeof one === 'string' && one.trim() !== '');
    if (clean.length !== names.length) return badRequest(reply, 'names 里只能是分类名字符串');
    return { ok: true, ...tags().setCategoryOrder(clean, typeof moved === 'string' ? moved : null) };
  });

  /**
   * **批量删除**一个分类下的词条（`tags` 行真删），分类留着。面板上唯一的批量删除入口。
   * 手改过的（`source = 'user'`）一样删 —— 返回值里带上其中几条是手改的，面板会说出来。
   */
  routes.delete('/tags/categories/entries', async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return badRequest(reply, '请求体必须是 { name }');
    return { ok: true, ...tags().deleteCategoryEntries(name) };
  });

  /**
   * 新建一个分类：**只加名字，一条词都不动**（"先建分类、再往里放词"要走得通）。
   * 重名不算错：`created:false` 让面板说"已经有一个同名的了"。
   */
  routes.post('/tags/categories', async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return badRequest(reply, '请求体必须是 { name }');
    if (name.length > LIMITS.category) return badRequest(reply, `分类名最多 ${LIMITS.category} 个字符`);
    return { ok: true, created: tags().createCategory(name) };
  });

  /**
   * 删掉一个分类：**连它下面的归属一起删**，所以是批量破坏性操作 —— 面板会先把影响多少条
   * 摆给人看再确认。词条本身一条都不删，它们只是变回未分类。
   */
  routes.delete('/tags/categories', async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return badRequest(reply, '请求体必须是 { name }');
    return { ok: true, removed: tags().removeCategory(name) };
  });

  /** 重命名分类（`categories` + `tag_categories` 两张表一起改，小类的 parent 跟着走）；目标名字已存在时 409（不合并） */
  routes.put('/tags/categories', async (request, reply) => {
    const body = asRecord(request.body);
    const from = typeof body?.from === 'string' ? body.from.trim() : '';
    const to = typeof body?.to === 'string' ? body.to.trim() : '';
    if (from === '' || to === '') return badRequest(reply, '请求体必须是 { from, to }');
    if (to.length > LIMITS.category) return badRequest(reply, `分类名最多 ${LIMITS.category} 个字符`);
    const moved = tags().renameCategory(from, to);
    if (moved < 0) {
      reply.code(409);
      return { ok: false, error: { message: `已经有一个叫「${to}」的分类了（不自动合并）` } };
    }
    return { ok: true, moved };
  });

  /** 删一条。传 en（正名） */
  routes.delete('/tags/entry', async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const en = typeof body.en === 'string' ? body.en : (typeof request.query?.en === 'string' ? request.query.en : '');
    if (en.trim() === '') return badRequest(reply, '请求体必须是 { en }');
    return { ok: true, deleted: tags().remove(en) };
  });

  /**
   * 产物里那份内置词库表在不在、多大 —— 面板靠它决定要不要画「导入」按钮、按钮上写多少 MB。
   * 只 stat 不解析：12.6MB / 32 万行读一遍要几百毫秒，而这里只需要回答"按钮点不点得动"。
   */
  const assetInfo = (file: URL): { available: boolean; bytes: number } => {
    try {
      const stat = fs.statSync(file);
      return { available: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
    } catch {
      return { available: false, bytes: 0 };
    }
  };

  /** 产物里那两份词库表：机翻（`danbooru-zh.csv`）+ 人工（`weilin-zh.csv`） */
  routes.get('/tags/import', async () => ({
    bundled: { ...assetInfo(BUNDLED_CSV), builtin: assetInfo(BUNDLED_BUILTIN) },
  }));

  /**
   * 导入**产物自带**的词库表，两层按信任级别依次落库（`assets/danbooru-zh.csv` 机翻、
   * `assets/weilin-zh.csv` 人工；构建时由 pack.mjs 的 extras 拷进来）。
   *
   * 为什么不是浏览器上传：32 万行 / 12.6MB 没必要过一遍 HTTP 和宿主内存，而且解析规则已经在
   * `tagcsv.ts` 里了 —— 上传那条路等于再实现一遍，还容易和命令行导出来的库不是一个结果。
   *
   * 分批 + `setImmediate`：宿主是单进程单事件循环，一个事务写完 32 万行要几秒，这几秒里
   * 所有 tab 的请求都得排队。切成小块、块间让出事件循环，把停顿打散。
   *
   * 幂等：重导只是按 `hot` 更新，守卫挡下的行一律不动（见 `tagdb.ts` 的 `ImportGuard`）——
   * 机翻那层只许盖机翻，于是「重导内置词库」不会把人工译文 / 你手改过的冲回去。
   *
   * 邻居表跟着一起灌：它和词库是同一份产物里的两层，分开导会留下"面板能用、邻居是空的"中间态。
   */
  routes.post('/tags/import', async (request, reply) => {
    if (importing) return reply.code(409).send({ error: { code: 'BUSY', message: '上一次导入还没写完，稍等一下' } });
    if (!assetInfo(BUNDLED_CSV).available) {
      return badRequest(reply, '产物里没有内置词库表（assets/danbooru-zh.csv）—— 先 pnpm build:plugins');
    }
    const started = performance.now();
    const db = tags();
    const before = db.count();
    importing = true;
    const layers: ImportedLayer[] = [];
    try {
      // 机翻表先进（`source='import'`，只许盖机翻那层）
      layers.push(await importLayer(db, { file: BUNDLED_CSV, name: '机翻表', source: 'import', guard: 'import', keepPlaceholders: true }));
      // 人工表后进（`source='builtin'`，只不许盖手改的）—— 同一批词里人工译文压过机翻。
      // 人工表这边 `keepPlaceholders: false`：那份表里"译文 == 正名"意思是"这词不用翻"，
      // 真写进去反而会把机翻那层的中文（`hololive` → `Hololive`）盖成英文，跳过才是对的。
      if (assetInfo(BUNDLED_BUILTIN).available) {
        layers.push(await importLayer(db, { file: BUNDLED_BUILTIN, name: '人工词表', source: 'builtin', guard: 'user', keepPlaceholders: false }));
      }
    } catch (err) {
      return badRequest(reply, `导入失败：${(err as Error).message}`);
    } finally {
      importing = false;
    }
    // 邻居表读不到（老产物里没有这份文件）不该让整次导入失败：词库本身是能用的
    let cooccur = { available: false, kept: 0, written: 0 };
    try {
      const parsed = parseCooccurTsv(fs.readFileSync(BUNDLED_COOC, 'utf8'));
      cooccur = { available: true, ...parsed.stats, written: db.importCooccur(parsed.rows) };
    } catch (err) {
      log(`共现邻居表没导进去（词库已入库）：${(err as Error).message}`);
    }
    const after = db.count();
    const rows = layers.reduce((sum, one) => sum + one.rows, 0);
    const written = layers.reduce((sum, one) => sum + one.written, 0);
    log(
      layers.map((one) => `${one.name} ${one.written}/${one.rows}`).join(' · ') +
        ` · 库内 ${before} → ${after} 条 · 邻居 ${cooccur.written} 对`,
    );
    return {
      ok: true,
      rows,
      written,
      skipped: rows - written,
      before,
      after,
      layers,
      cooccur,
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}
