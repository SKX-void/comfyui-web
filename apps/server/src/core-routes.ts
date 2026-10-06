import { describeRow, listRows } from './core-rows.js';
import type { CoreHost } from './core-host.js';
import { readHostSettings, settingsView, writeHostSettings } from './host-settings.js';
import { findEntry } from './loader-entries.js';
import { SUPPORTED_CONTRACT } from './plugin-package.js';
import { message } from './util.js';

/**
 * 宿主级端点（都在 `/api/*` 下）。
 *
 * 它们是**宿主级**路径（`/api/plugins`），不属于 `/api/p/<pluginId>` 的插件前缀约定，
 * 所以由宿主自己 mount 的 core 插件注册，而不是 `/tabs` 里的某个插件。
 */
export function registerCoreRoutes(host: CoreHost): void {
  const { app, ctx, config, settingsFile } = host;

  // ---- 宿主信息 ----------------------------------------------------------

  app.get('/api/host', async () => ({
    dataDir: config.dataDir,
    tabsDir: config.tabsDir,
    contract: SUPPORTED_CONTRACT,
  }));

  // ---- 目录型 tab（`/tabs/<id>/`）----------------------------------------

  /**
   * 重扫 `/tabs` —— **唯一会改动装载状态的入口**（D20：宿主不监听目录，壳里给了按钮）。
   *
   * 增量：新目录挂上、指纹变了的带 `?v=` 重挂、目录没了的卸掉。返回这四个列表，
   * 前端据此说清"到底发生了什么"（而不是只说一句"刷新成功"）。
   */
  app.post('/api/tabs/rescan', async () => config.tabs.rescan());

  /**
   * 强制重挂一个目录型 tab（指纹没变也重挂）。
   *
   * 目录型插件的配置归它自己（`ctx.space` 里的文件），改完设置要重新 `apply()` 才生效：
   * 宿主不碰它的配置，只提供"重新走一遍装载"这一个动作（决策 D15）。
   */
  app.post<{ Params: { id: string } }>('/api/tabs/:id/reload', async (request, reply) => {
    const id = request.params.id;
    const tab = config.tabs.get(id);
    if (tab === undefined || !config.tabs.owns(id)) {
      return reply.code(404).send({ error: `不是目录型 tab：${id}` });
    }
    const ok = await config.tabs.reload(id);
    if (!ok) {
      return reply.code(409).send({ error: `重挂 ${id} 失败：目录已变化或入口不可用（看设置页的 reasons）` });
    }
    return { reloaded: id, plugin: await describeRow(ctx, tab, config.tabs.enabledOf(id)) };
  });

  // ---- 插件清单（唯一真源）------------------------------------------------

  app.get('/api/plugins', async () => ({ plugins: await listRows(ctx, config.tabs) }));

  // ---- 运行期启停 --------------------------------------------------------

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/plugins/:id/enabled',
    async (request, reply) => {
      const id = request.params.id;
      const tab = config.tabs.get(id);
      const entry = findEntry(ctx, id);
      if (tab === undefined || entry === undefined) {
        return reply.code(404).send({ error: `未知插件 ${id}` });
      }
      // 没通过检查的 tab（契约不符 / 入口缺失）本来就以 disabled 挂着，启用它没有意义
      if (tab.problem !== undefined) {
        return reply.code(409).send({ error: `tab ${id} 未通过检查，无法启用：${tab.problem}` });
      }
      const enabled = request.body?.enabled !== false;
      // 落盘（D21）：`disabled` 是宿主自己的启停状态，写在 data/host.json 里 ——
      // 它是**部署事实**，跟 tab 的顺序/首页一样属于"宿主管的东西"，而不属于插件自己。
      try {
        const current = readHostSettings(settingsFile);
        const next = enabled
          ? current.disabled.filter((item) => item !== id)
          : [...new Set([...current.disabled, id])];
        writeHostSettings(settingsFile, { ...current, disabled: next });
      } catch (err) {
        // 写不进去（只读卷）就别假装成功：否则"停用"只在本次运行期成立，用户却以为存住了
        return reply.code(500).send({
          error: `写启停状态失败（${settingsFile}）：${message(err)}`,
        });
      }
      // 停用走 loader.update（不需要重挂）；启用走 reload（插件可能是在停用状态下挂上来的，
      // 要重新 apply 一遍才算真的启用）。两条路都以**盘上的值**为准。
      if (!enabled) {
        await ctx.loader.update(entry.id, { disabled: true });
        await ctx.loader.await();
      } else {
        const ok = await config.tabs.reload(id);
        if (!ok) {
          return reply.code(409).send({
            error: `启用 ${id} 失败：目录已变化或入口不可用（设置页里能看原因）`,
          });
        }
      }
      // 用**已落地**的状态回报（loader.await() 之后 entry.disabled 已是事实），
      // 而不是我们请求的那个值：写盘成功、行也更新了，这三者才是同一个事实
      return { plugin: await describeRow(ctx, tab, config.tabs.enabledOf(id)), persisted: true };
    },
  );

  // ---- 外壳偏好 + 宿主全局设置 -------------------------------------------
  // 存 <dataDir>/host.json（与部署段同处一个文件）。后端只保证「读得到、写得进、坏文件不炸」：
  // 未知插件 id 的过滤与默认首页的回退都在前端做（它才看得到实时清单）。
  //
  // globals.comfyuiBaseUrl（统一 ComfyUI 地址）只是宿主给的一个**只读默认值**：
  // 宿主不再把它写进任何插件，插件要么自己配、要么把它当兜底（D16）。

  app.get('/api/ui', async () => ({ prefs: settingsView(readHostSettings(settingsFile)) }));

  app.put<{
    Body: {
      tabOrder?: unknown;
      home?: unknown;
      tabAliases?: unknown;
      homeLabel?: unknown;
      globals?: unknown;
    };
  }>('/api/ui', async (request, reply) => {
    try {
      const body: Record<string, unknown> = { ...(request.body ?? {}) };
      // 这一层只认偏好段这几个键：data/host.json 里还住着部署段（端口等），
      // 设置页不该靠这次提交改掉它们。
      const patch: Record<string, unknown> = {
        tabOrder: body.tabOrder,
        home: body.home,
        tabAliases: body.tabAliases,
        homeLabel: body.homeLabel,
        globals: body.globals,
      };
      for (const key of Object.keys(patch)) {
        if (patch[key] === undefined) delete patch[key];
      }
      const current = readHostSettings(settingsFile);
      const prefs = writeHostSettings(settingsFile, { ...current, ...patch });
      return { prefs: settingsView(prefs) };
    } catch (err) {
      // 写不进去（只读挂载 / 磁盘满）必须给出可读原因，而不是静默不保存
      return reply.code(500).send({ error: `写外壳偏好失败：${message(err)}` });
    }
  });
}
