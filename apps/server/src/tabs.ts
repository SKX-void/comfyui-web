/**
 * `/tabs` —— **目录型工作流插件**（决策 D14，已落地）。
 *
 * 每个子目录就是一个插件，**目录名即 id**：
 *
 * ```
 * tabs/<id>/package.json   { "name": "@comfyui-web/tab-<id>", "main": "server.js",
 *                            "plugin": { "contract": 1, "title": "…", "client": "client.js" } }
 * tabs/<id>/server.js      cordis 插件（export name / inject / apply）
 * tabs/<id>/client.js      ESM 前端入口（export default { tabs, routes }）；vue 走页面 import map
 * ```
 *
 * 它是宿主**唯一**的插件来源（D16/D19）：契约检查、失败隔离、`GET /api/plugins`、
 * 设置页说明、前端 tab 装载全部走这一条路，不新增第二套生命周期。
 *
 * ## 什么时候扫（D20）
 *
 * **只在两个时刻**：宿主启动时装配一次，以及 `POST /api/tabs/rescan`（设置页/欢迎页的
 * 「重新扫描插件目录」按钮）。宿主不监听目录、不轮询：改完 `tabs/` 是人知道自己改了什么，
 * 由人决定什么时候生效 —— 顺带把"容器挂载 / 网络盘上 fs.watch 静默失聪"这类坑一起消掉。
 *
 * ## 为什么要求"自包含"
 *
 * 插件产物本来就自带依赖（esbuild 把 deps inline 进 `server.js`），所以 tabs 目录下
 * **没有** node_modules：插件只 import node 内置模块 + 宿主给的句柄。要第三方库就先 bundle。
 * 只有这样，"丢一个目录进去就是一个 tab"才成立（也免掉 N 份 node_modules 与不可复现的安装）。
 *
 * ## 状态归插件自己
 *
 * `/tabs` 只回答"有哪几个 tab"，**不持有它们的配置**：插件用 `ctx.space` 在自己的
 * `data/plugins/<包名>/` 里自持数据库 / 配置文件（决策 D15）。宿主只提供
 * `POST /api/tabs/:id/reload` 让它把新设置生效，免得出现"改完没落盘、重启就丢"的假象。
 *
 * ## 代码在哪
 *
 * `tabs-scan.ts` 扫目录（纯 fs，无 cordis）、`tabs-loader.ts` 与 Loader/routes 打交道、
 * `tabs-service.ts` 是持有装载状态的那台状态机；这个文件只做出口。
 */

export { scanTabs, type ScannedTab } from './tabs-scan.js';
export { TabsService, type RescanResult } from './tabs-service.js';
