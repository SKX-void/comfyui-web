/**
 * anima-example —— **第一个「真」插件**。
 *
 * 和 anima-plus 的区别就一句话：它不反代任何旧服务，自己把活干完：
 *
 *   表单 → 改工作流图 → POST ComfyUI /prompt → 订阅 ComfyUI /ws 收进度
 *        → 拉 /history → 下载 /view 的图 → 落到自己空间里的 images/
 *        → SSE 推给浏览器 → 作业记录写进自己的表
 *
 * 它演示插件契约里除了「反代」以外的每一条：
 *   - `inject = ['routes','space']` —— 核只给一个句柄：文件空间
 *   - 存储**完全自管**：`node:sqlite` 开在自己的空间里，版本用 `PRAGMA user_version`
 *   - 产出图落进自己的空间（谁都不许自动清）
 *   - 设置项来自 `package.json` 的 `plugin.settings[]`，值由**本插件自己持有**
 *     （空间里的 `settings.json`，见 settings.ts）
 *
 * 只 import node 内置模块，**不 import cordis**：宿主已经把 cordis 打进自己的产物，
 * 插件再引一份就是两个实例。
 *
 * ## 服务端源码分文件，交付物是单文件
 *
 * 本文件只做装配：meta / util / safety / workflow / comfy / store / settings / jobs /
 * params / routes 各管一段（每个文件都在 300 行以内）。宿主加载的是**打包产物**
 * `tabs/anima-example/server.js`（scripts/build-server.mjs）—— 为什么必须打成单文件
 * 见那个脚本的头注释（入口说明符才带 `?v=`，兄弟模块不带）。
 */
import { ComfyClient } from './comfy.js';
import { createJobs } from './jobs.js';
import { ID, PACKAGE } from './meta.js';
import { createParams } from './params.js';
import { registerRoutes } from './routes.js';
import { resolveSettings } from './settings.js';
import { JobStore } from './store.js';
import { WORKFLOW_FILE, loadWorkflow, resolveBindings } from './workflow.js';
import type { PluginContext } from './types.js';
import type { Graph, WorkflowBindings } from './model.js';

export const name = ID;

// 核只给两个句柄：文件空间（按**包名**分配）+ 路由挂载点
export const inject = ['routes', 'space'];

/** 护栏对外可见：契约测试直接 import 它（`scripts/contract-test.mjs`） */
export { SAFETY, assertGraphSafe } from './safety.js';

export function apply(ctx: PluginContext, legacySettings: unknown): void {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const log = (msg: string): void => {
    ctx.logger?.info?.(`[${ID}] ${msg}`);
  };

  // ---- 3.1 存储：全在插件自己的空间里，核不参与（库文件 + 产出图）----
  const store = new JobStore(space);

  // ---- 3.2 工作流与绑定（启动时解析一次，失败就在清单里报出来）----
  let workflow: Graph;
  let bindings: WorkflowBindings;
  try {
    workflow = loadWorkflow();
    bindings = resolveBindings(workflow);
  } catch (err) {
    // 解析不了就抛出：宿主会把本插件标成 broken 并显示原因，比带着坏绑定跑出废图强
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`工作流解析失败（${WORKFLOW_FILE.pathname}）：${detail}`);
  }
  log(`工作流已载入：${Object.keys(workflow).length} 个节点，绑定 ${JSON.stringify(Object.keys(bindings.current))}`);

  // ---- 3.3 设置：值由插件自己持有（空间里的 settings.json），清单行的 config 只在首次装载时采信一次 ----
  const settings = resolveSettings(space, legacySettings, bindings.current, log);
  const comfy = new ComfyClient(settings.values.comfyuiBaseUrl, log);

  // ---- 3.4/3.5 作业：内存状态 + SSE 订阅者 + ComfyUI 事件 ----
  const jobs = createJobs({ comfy, store, log });
  const unsubscribeComfy = jobs.attachComfyEvents();

  // ---- 3.6 参数：上游选项 / 校验 / 建图 ----
  const params = createParams({ comfy, settings, bindings, workflow, log });

  // ---- 3.7 路由：框架统一加前缀 → /api/p/anima-example/* ----
  registerRoutes({ routes, settings, store, jobs, params, comfy, bindings, log });

  // ---- 3.8 生命周期：一切注册挂 ctx，卸载时 cordis 自动撤销 ----
  comfy.start();
  log(`已就绪，ComfyUI = ${comfy.baseUrl}`);

  ctx.effect(() => () => {
    unsubscribeComfy();
    comfy.stop();
    jobs.dispose();
    store.close();
    log('已卸载');
  });
}
