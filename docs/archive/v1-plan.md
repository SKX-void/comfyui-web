# 项目计划

> ⚠️ **历史文档（v1 单体时代）**：描述的是已被取代的单体服务与当时的规划，只作来龙去脉参考，**不要照着实现**。现行文档索引见 [`docs/README.md`](../README.md)。
> 相关文档：[单体架构](./v1-architecture.md) · [API](./v1-api.md) · [模板](./v1-templates.md) · [WeiLin](../../plugins/anima-plus/docs/weilin.md) · [路线图](./v1-roadmap.md)

---

## 1. 项目目标

ComfyUI 自带前端（节点图编辑器）对一个"只想出图"的用户来说太重：需要理解节点、连线、模型枚举。
本项目做**一个轻前端**，用「网页表单 → 调用 ComfyUI API」的方式出图。

**核心一句话**：用户填表 → 服务器把表单映射进预置的 API 格式工作流 JSON → POST 给 ComfyUI → 通过 WebSocket 回传进度 → 取回图片。

### 非目标（v1 明确不做）

- ❌ 不做节点图编辑器
- ❌ 不改动、不 fork ComfyUI 与 WeiLin 插件
- ❌ v1 不做账号体系（但数据模型与接口按多用户预留）
- ❌ 不做 ComfyUI 多实例调度

---

## 2. 已确认的架构决策

| # | 决策项 | 结论 | 备注 |
|---|--------|------|------|
| D1 | 服务器定位 | **轻前端 BFF**，独立进程，独立仓库 | 代理 ComfyUI，不集成其代码 |
| D2 | 后端栈 | **Node.js + TypeScript** | 与前端同语言，类型可共享 |
| D3 | 前端栈 | **Vue 3**（已定） | WeiLin 前端本身即 Vue 3.5，**可直接复用其组件**，见 §3.3 |
| D4 | 部署形态 | **先本机自用，架构预留多用户** | 单用户实现 + 多用户数据模型 |
| D5 | 与工作流关系 | **高度定制化绑定** | 模板化，见 v1-templates.md |
| D6 | 与 WeiLin 关系 | **强依赖**：复用其 REST API + 复用其 Vue 组件 | 用户明确接受强依赖，见 §3.3 / plugins/anima-plus/docs/weilin.md |
| D7 | 触发词注入 | **沿用节点原生注入**（Q15 方案 A，零代码） | 不自行实现；原生体验已足够好 |
| D8 | 实施节奏 | **先搭框架跑通链路 → 再改进 WeiLin 组件的前端呈现** | 分两阶段，避免一开始陷入组件细节 |
| D9 | 无 ComfyUI 时的开发 | 内置 **mock 模式**（`COMFY_MODE=mock`） | `/workspace/ComfyUI` 无 venv/torch，本地跑不起来 |

---

## 3. 关键调研结论（已验证）

### 3.1 ComfyUI 侧（`/workspace/ComfyUI`，v0.36.0）

服务为 aiohttp，默认 `127.0.0.1:8188`。已确认存在的关键端点（源码 `server.py`）：

| 端点 | 方法 | 作用 |
|------|------|------|
| `/prompt` | POST | 提交工作流（核心） |
| `/ws?clientId=` | WS | 执行进度推送（核心） |
| `/queue` | GET/POST | 查询队列 / 清空 |
| `/interrupt` | POST | 中断当前执行 |
| `/history/{prompt_id}` | GET | 取执行历史（含产出文件名） |
| `/view?filename=&subfolder=&type=output` | GET | 取图片 |
| `/upload/image` | POST | 上传图片（img2img / 参考图） |
| `/object_info` | GET | 全部节点定义（用于校验与动态表单） |
| `/system_stats` | GET | 显存 / 队列状态 |
| `/api/jobs` | GET | 新版任务接口 |

> 注意：`/prompt` 请求体为 `{"prompt": <graph>, "client_id": "<uuid>"}`。
> **ComfyUI 只有 WebSocket，没有 SSE**（全仓库无 `event-stream`）。详见 §3.2。

### 3.2 ComfyUI 进度机制（已从源码确认）

**结论：进度走 WebSocket，且有两套并行事件。**

| 事件 | 发送点 | 载荷 | 用途 |
|------|--------|------|------|
| `progress` | `main.py:436` | `{value, max, prompt_id, node}` | **采样器 step 进度——进度条的数据源** |
| `progress_state` | `comfy_execution/progress.py:184` | `{prompt_id, nodes:{<id>:{value,max,state,node_id,display_node_id,parent_node_id,real_node_id}}}` | 新版全节点状态（含 `pending/running/finished/error`） |

`progress` 由 `comfy.utils.ProgressBar` 的全局 hook 触发，**带节流**：
`PROGRESS_THROTTLE_MIN_INTERVAL = 0.1s`、`PROGRESS_THROTTLE_MIN_PERCENT = 0.5%`；
首帧、末帧、带预览图时**立即发送**。

> ⚠️ **关键陷阱（易踩坑）**：进度事件通过
> `send_sync(..., server_instance.client_id)` 发送，
> 即**只投递给"提交该任务的 client_id"**，而非广播。
> 因此服务器连接 `/ws` 时**必须使用提交 `/prompt` 时的同一个 `client_id`**，
> 否则永远收不到进度。

**本项目架构选择**：
`ComfyUI --WS--> server --SSE--> 浏览器`。
服务器侧用 WS（因为上游只有 WS），浏览器侧用 SSE（单向、自动重连、实现简单）。

### 3.3 WeiLin 前端可搬运性（重要发现）

WeiLin 的**前端本身就是 Vue 3 应用**（`src/`，60+ 个 `.vue` 组件，pinia + vue-i18n + axios），
且**与 ComfyUI 零耦合**：

| 检查项 | 结果 |
|--------|------|
| 依赖 `window.app` / `app.graph` / `LiteGraph` / `ComfyApp` | ❌ **完全没有**（全仓库 grep 无命中） |
| 如何拿数据 | `axios` → `baseURL = '/weilin/prompt_ui/api'`（`src/api/request.js`） |
| 如何与宿主通信 | `window.postMessage({type:'weilin_prompt_ui_*'})` |
| 构建形态 | Vite `lib` 模式，UMD 产物 `dist/javascript/main.entry.js` |

**结论**：WeiLin 的前端已经是「通过 HTTP + postMessage 驱动的独立应用」，
**搬运到我们的前端是可行的**——只需把 postMessage 适配层换成我们自己的状态绑定。
这是 D3 选 Vue 3 的决定性理由。详见 [plugins/anima-plus/docs/weilin.md](../../plugins/anima-plus/docs/weilin.md) §6。

### 3.4 WeiLin 插件侧（`/workspace/WeiLin-Comfyui-Tools`）

**这是本项目最重要的调研结论**：WeiLin **已经在 ComfyUI 的 aiohttp 上注册了大量 REST 路由**，
前缀 `/weilin/prompt_ui/api/`（源码 `app/server/prompt_server.py:37`）。

已确认的路由族：

| 族 | 代表端点 | 能力 |
|----|----------|------|
| LoRA 列表 | `get_lora_list`、`get_lora_list_by_range`、`get_lora_list_by_search`、`get_lora_folder_list` | 枚举本地 LoRA |
| LoRA 元数据 | `lorainfo/api/loras/info`(GET/POST)、`.../refresh`、`.../img`、`.../set/img` | 预览图、触发词、自定义字段 |
| 标签库 | `prompt/get_group_tags_paginated`、`prompt/search_tags`、`prompt/fast/autocomplete` | 标签检索/补全 |
| 标签增删改 | `prompt/new_tags`、`prompt/edit_tags`、`prompt/delete_tags`、`prompt/move_tag` | 标签 CRUD |
| 翻译 | `prompt/local/translate` | 本地中英翻译 |
| 随机模板 | `random_template/get_template_list`、`.../go_random_template`、`.../save_template` | 随机提示词模板 |
| 历史 | `prompt/history/*`、`prompt/collect_history/*` | 提示词历史 |
| 设置 | `get/setting/get_auto_limit_setting` 等 | 插件设置 |

**数据落盘位置**（源码 `app/server/dao/dao.py:46-58`）：
SQLite 位于 `WeiLin-Comfyui-Tools/../../../user_data/`，即 **`/workspace/user_data/*.db`**
（`*_tags.db` 标签库、`*_history.db` 历史、`*_danbooru.db` Danbooru 数据）。

### 3.5 示例工作流（`api.example.json`）的完整节点链路

实测该文件共 18 个节点。关键的是**两个 WeiLin 节点串联**：

| 节点 | class_type | 角色（用户刻意拆分，单一职责） |
|------|-----------|------|
| `43` | **`WeiLinPromptUI`**（全能组件） | **纯 LoRA 加载 + 触发词注入**；`positive` 里**只有 `<wlr:>` 标签、无正文** |
| `19` | `WeiLinPromptUIWithoutLora` | **主提示词**（数据库选词）；`opt_text`/`opt_clip` 取自 `43` |
| `33` | `CLIPTextEncode` | 质量**负向**词（`clip` 取自 `["43", 2]`） |
| `28` | `CR Text` | 质量**正向**词 |
| 其它 | `UNETLoader`/`CLIPLoader`/`KSampler`/`VAEDecode`/`SaveImage` 等 | 常规链路 |

> **拆分意图（用户说明）**：不用 WeiLin 的 `WeiLinPromptUIOnlyLoraStack`（它**不注入触发词**），
> 而用全能组件 `WeiLinPromptUI` 承担 LoRA 加载，**因为只有它会自动注入触发词**；
> 同时把 `positive` 清空成只有标签，使该节点不产出任何正文，
> 从而与主提示词节点彻底解耦。源码已确认此判断成立（见 [plugins/anima-plus/docs/weilin.md](../../plugins/anima-plus/docs/weilin.md) §5.3）。

**节点 `43` 的真实载荷**（这是对接的核心）：

```jsonc
// 43.inputs.positive —— LoRA 以 <wlr:...> 标签内嵌在提示词文本里
"<wlr:Anima\\Anima Turbo LoRA-v0.2:0.9:1:1>, <wlr:Anima\\画师\\taffy-style:0.9:1:1>"

// 43.inputs.lora_str —— UI 产出的富格式 JSON 数组
[{
  "name": "Anima\\Anima Turbo LoRA-v0.2",
  "weight": 0.9, "text_encoder_weight": 1, "trigger_weight": 1,
  "display_name": "Anima Turbo LoRA - v0.2",
  "lora": "Anima\\Anima Turbo LoRA-v0.2.safetensors",
  "loraWorks": "", "hidden": false
}, {
  "name": "Anima\\画师\\taffy-style",
  "weight": 0.9, "text_encoder_weight": 1, "trigger_weight": 1,
  "display_name": "taffy-style - v1.0",
  "lora": "Anima\\画师\\taffy-style.safetensors",
  "loraWorks": "@bantan",          // ← 用户编辑的触发词
  "hidden": false
}]
```

`<wlr:...>` 标签格式（源码 `lora_stack.vue:302`）：

```
新格式(4参数)： <wlr:名字:模型权重:CLIP权重:触发词权重>
旧格式(3参数)： <wlr:名字:模型权重:CLIP权重>
```

> **结论（回答了"能不能只改 API JSON"）**：**能**。
> 只要往 `43.inputs.positive`（内嵌 `<wlr:...>`）或 `43.inputs.lora_str`（富 JSON）写值，
> 节点执行期会自动完成 **LoRA 加载 + 触发词提取 + 触发词注入**。
> 服务器**不需要**实现 LoRA 加载逻辑。完整机制见 [plugins/anima-plus/docs/weilin.md](../../plugins/anima-plus/docs/weilin.md) §4–5。
>
> ⚠️ **一个例外**：触发词用的是 **Civitai/元数据/文件名**，节点**不读**你编辑的 `loraWorks`。
> 即"自动注入"生效，但注入的未必是你编辑的词。这需要按 **Q15** 决策，
> 见 [plugins/anima-plus/docs/weilin.md](../../plugins/anima-plus/docs/weilin.md) §5.3。

---

## 4. 核心调用链路与假设验证

```
[浏览器 SPA]
    │  1. 拉取表单定义   GET  /api/templates/:id
    │  2. 拉标签/LoRA    GET  /api/tags, /api/loras    ──(代理)──> WeiLin /weilin/prompt_ui/api/*
    │  3. 提交任务       POST /api/jobs  {templateId, values}
    ▼
[Node-TS 轻前端服务器 :8080]
    │  4. 渲染：把 values 注入模板 graph（含 WeiLin 节点字段）
    │  5. 提交       POST http://127.0.0.1:8188/prompt  {prompt, client_id}
    │  6. 建 WS      ws://127.0.0.1:8188/ws?clientId=xxx
    │  7. 推送进度    SSE /api/jobs/:id/events  ──────────────> 浏览器
    │  8. 完成后取   GET /history/:prompt_id → /view?filename=...
    │  9. 落库        SQLite: jobs / assets / templates
    ▼
[ComfyUI :8188] ──> [WeiLin 节点] ──> 出图
```

### 假设验证状态（源码级结论）

| # | 假设 | 状态 | 结论 |
|---|------|------|------|
| H1 | Node 用 `ws` 连 `/ws` 可用，按 `client_id` 收发 | ✅ **真机验证通过** | 2026-09-18 在 `10.2.3.22:8188` 实测：`progress 2/6→6/6` 正常收到。**坑：`ws` 库文本帧也是 Buffer**，必须显式转字符串（见 README） |
| H2 | `positive` 传 JSON 时能解析 `{"prompt":...}` | ✅ **源码确认** | `is_json(positive)` → `json_object.get("prompt")`（`__init__.py:711`） |
| H3 | `opt_clip` 是连线输入，服务器不能直接注入 | ✅ **源码确认 + 真机验证** | 模板保留完整 CLIP 链路，真机出图成功 |
| H4 | WeiLin REST 接口就绪 | ✅ **真机验证通过** | `get_lora_load_status` 返回 288 个 LoRA；`get_lora_list` **41MB**（需用分页端点） |
| H5 | `opt_text` 可传字面量字符串 | ⬜ 未验证 | 不影响当前设计（模板走连线，未用字面量） |
| H6 | 触发词注入由节点自动完成 | ✅ **源码确认** | 见 [plugins/anima-plus/docs/weilin.md](../../plugins/anima-plus/docs/weilin.md) §5 |
| H7 | WeiLin 前端组件与 ComfyUI 解耦 | ✅ **源码确认** | 无 `LiteGraph`/`window.app` 依赖（§3.3） |

> **真机环境基线**（2026-09-18 实测）：
> ComfyUI **0.33.0** @ `10.2.3.22:8188`（Windows / 32GB RAM），2608 个节点，
> 三个 WeiLin 节点均已加载；diffusion_models 32 个。
> `/workspace/ComfyUI` 仅作源码参考（**无 venv/torch，本地跑不起来**），
> 因此框架内置 mock 模式用于离线开发。

> **H3 仍是最大约束**：决定了模板必须保留完整 CLIP/MODEL 链路，
> 服务器只能改「文本与参数」类字段，不能凭空造 conditioning。

---

## 5. 仓库结构规划

```
comfyui-web/               # 本仓库（monorepo）
├── api.example.json          # 现有示例工作流（保留，作为模板素材）
├── v1/                       # 规划文档（本目录）
├── apps/
│   ├── server/               # Node-TS BFF
│   │   └── src/
│   │       ├── config/       # 环境变量、ComfyUI 地址
│   │       ├── comfy/        # ComfyUI 客户端（REST + WS）
│   │       ├── weilin/       # WeiLin 代理与适配
│   │       ├── templates/    # 模板加载 / 渲染 / 校验
│   │       ├── jobs/         # 任务编排、状态机、事件总线
│   │       ├── store/        # SQLite（Drizzle/Prisma）
│   │       └── http/         # 路由层
│   └── web/                  # 前端 SPA
├── packages/
│   └── shared/               # 前后端共享 TS 类型（模板 schema、DTO）
└── templates/                # 工作流模板 JSON（版本化）
```

---

## 6. 待决事项

### 已决

| # | 问题 | 结论 |
|---|------|------|
| Q1 | 前端 Vue3 还是 React？ | ✅ **Vue 3** —— WeiLin 前端即 Vue 3.5 且与 ComfyUI 解耦，可复用组件（§3.3） |
| Q4 | 是否强依赖 WeiLin？ | ✅ **强依赖**（用户决定）。WeiLin 的 LoRA/触发词/标签能力值得该代价 |
| Q15 | 触发词注入来源 | ✅ **方案 A：沿用节点原生注入**（Civitai/元数据/文件名），不自行实现 |

> Q15 说明：节点自动注入的体验已足够好，投入产出比不高。
> 若日后需要「用户编辑的触发词生效」，再切到方案 B（`OnlyLoraStack` + 自注入），
> 届时只需改模板 `bindings` 与一处 transform，不动架构。

### 待决

| # | 问题 | 影响 |
|---|------|------|
| Q2 | 模板格式：**自定义 DSL** vs **ComfyUI graph 子集 + 占位符**？ | 影响 v1-templates.md 设计 |
| Q3 | LoRA 应用方式：**写 `lora_str`/`positive`** vs **服务器改图插节点**？ | 见 plugins/anima-plus/docs/weilin.md §4 |
| Q5 | 任务历史落库用 **SQLite** 还是只读 ComfyUI `/history`？ | 影响持久化复杂度 |
| Q6 | 是否需要图片/资源的**长期归档**（ComfyUI output 会被清理）？ | 影响存储设计 |
| **Q15** | **触发词来源**：沿用节点自动注入（Civitai/元数据）vs 我们按 `loraWorks` 注入？ | **新增，见 plugins/anima-plus/docs/weilin.md §5.3** |
| **Q16** | 前端组件策略：**直接搬 WeiLin 的 `.vue` 源码** vs **嵌入 UMD 产物** vs **照着重写**？ | **新增，见 plugins/anima-plus/docs/weilin.md §6** |

---

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|------|------|------|
| WeiLin 字段契约随插件更新变化 | 高 | 启动探针 + 契约快照测试 + 记录 WeiLin commit |
| CLIP 链路无法绕过（H3） | 高 | 模板保留完整链路，仅替换文本/参数节点 |
| 触发词注入的**词不对**（元数据回退到文件名） | 高 | 先看 M0 注入日志；必要时改用 `OnlyLoraStack` + 自注入（Q15 方案 B） |
| 用户编辑的触发词（`loraWorks`）**不参与**注入 | 中 | 同上；若"编辑触发词"是必需功能则必须选方案 B |
| 进度收不到（client_id 不匹配） | 中 | 提交与 WS 共用同一 client_id，§3.2 |
| WS 断线导致任务状态丢失 | 中 | 状态真相源是 `/history`，WS 仅用于进度 |
| ComfyUI 单队列串行，排队体验差 | 中 | 暴露队列位置，前端展示排队进度 |
| WeiLin 数据库未初始化 | 中 | 启动自检 + 降级（当前 `/workspace/user_data/` 确实为空） |
| 搬 WeiLin 组件带入大量依赖（pinia/vue-i18n/interactjs/pako） | 中 | 评估按需剥离，见 Q16 |

---

## 8. 下一步

1. **你确认 §6 的待决事项**（尤其 Q3 / Q15 / Q16）
2. 我写一个**最小冒烟脚本**，运行时验证 H1 / H4 / H5（其余已由源码确认）
3. 冒烟通过后，按 [v1-roadmap.md](./v1-roadmap.md) 的 M1 开始实现

---

## 附录：文档索引

| 文档 | 内容 |
|------|------|
| [v1-architecture.md](./v1-architecture.md) | 分层架构、组件职责、调用链路、时序图 |
| [v1-api.md](./v1-api.md) | 服务器对外 REST/SSE 契约 + 对 ComfyUI 的调用规范 |
| [v1-templates.md](./v1-templates.md) | 工作流模板格式、输入映射、校验规则 |
| [plugins/anima-plus/docs/weilin.md](../../plugins/anima-plus/docs/weilin.md) | WeiLin 对接方案、LoRA/标签/翻译/随机提示词 |
| [v1-roadmap.md](./v1-roadmap.md) | 里程碑、任务拆解、验收标准 |
