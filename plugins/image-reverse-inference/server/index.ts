/**
 * image-reverse-inference —— 图片反推插件。
 *
 *   浏览器（canvas 压成 webp，≤1MB）→ base64 JSON → 本插件
 *     → POST ComfyUI /upload/image（multipart，服务端自己组）
 *     → POST /prompt（LoadImage.image = `subfolder/name`，tagger 参数来自设置）
 *     → 轮询 /history → outputs[<tagger>].tags[0] → 返回文本
 *
 * ## 为什么图片不能从浏览器直传 ComfyUI
 *
 * 实测 ComfyUI（0.33.0）不带任何 CORS 响应头（`OPTIONS /upload/image` 只有 200 + 空 body），
 * 浏览器跨源上传必被预检挡下。所以上传只能由插件后端代理。
 *
 * ## 为什么后端收的是 base64 JSON 而不是 multipart
 *
 * 宿主 fastify 只注册了 `application/json` 与 `text/plain` 两个 content-type 解析器，
 * 其余（`multipart/form-data` / `image/png` / `application/octet-stream`）在**进 handler 之前**
 * 就被 415 挡掉 —— 插件拿不到原始流，所以前端只能把图编码进 JSON。
 * 代价是 base64 膨胀 4/3，而宿主 bodyLimit 是 4MB：前端压到 1MB、服务端兜底 2MB（meta.ts）。
 *
 * ## 服务端源码分文件，交付物是单文件
 *
 * 本文件只做装配：meta / settings / workflow / comfy / routes 各管一段（都在 300 行以内）。
 * 宿主加载的是打包产物 `tabs/image-reverse-inference/server.js`（scripts/build-server.mjs）。
 */
import { ComfyClient } from './comfy.js';
import { ID, PACKAGE } from './meta.js';
import { registerRoutes } from './routes.js';
import { resolveSettings } from './settings.js';
import { WORKFLOW_FILE, loadWorkflow, resolveBindings } from './workflow.js';
import type { Graph, WorkflowBindings } from './model.js';
import type { PluginContext } from './types.js';

export const name = ID;

// 核只给两个句柄：文件空间（按**包名**分配）+ 路由挂载点
export const inject = ['routes', 'space'];

export function apply(ctx: PluginContext, legacySettings: unknown): void {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const log = (msg: string): void => {
    ctx.logger?.info?.(`[${ID}] ${msg}`);
  };

  // 工作流与绑定在启动时解析一次：解析不了就抛出，宿主会把本插件标成 broken 并显示原因
  let workflow: Graph;
  let bindings: WorkflowBindings;
  try {
    workflow = loadWorkflow();
    bindings = resolveBindings(workflow);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`工作流解析失败（${WORKFLOW_FILE.pathname}）：${detail}`);
  }

  const settings = resolveSettings(space, legacySettings, log);
  const comfy = new ComfyClient(settings.values.comfyuiBaseUrl, log);
  const state = { inFlight: 0 };

  registerRoutes({ routes, settings, comfy, workflow, bindings, log, state });
  log(
    `已就绪：ComfyUI = ${comfy.baseUrl}，${Object.keys(workflow).length} 个节点，` +
      `tagger=${bindings.taggerId}（model=${bindings.taggerModel || '工作流未指定'}）` +
      ` loadImage=${bindings.loadImageId}`,
  );

  // 本插件没有长命资源（不建 WS、不起定时器、不开文件句柄），所以收尾是空的 ——
  // 但契约要求注册一次（D20：重挂是新 fiber，任何要活下来的状态都该写进 space）。
  ctx.effect(() => () => {
    log('已卸载');
  });
}
