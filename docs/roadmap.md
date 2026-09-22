# 路线图与验收标准

> 状态：**讨论稿**（待用户确认）
> 上游文档：[计划](./plan.md) · [单体架构](./archive/monolith-architecture.md)

---

## 0. 里程碑总览

```
M0 冒烟验证 ──▶ M1 骨架走通 ──▶ M2 模板层 ──▶ M3 WeiLin 集成 ──▶ M4 前端完善 ──▶ M5 打磨
   (0.5d)          (1d)            (1.5d)          (1.5d)            (2d)          (1d)
                     └────────── 最简可用：M0–M2 ──────────┘
```

**关键原则**：M0 是**阻断式**里程碑 —— 假设未验证前不写生产代码。

---

## 实施进展（2026-09-18 更新）

**已完成：M0 + M1 + M2，并在真实 ComfyUI 上端到端验证通过。**

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M0 冒烟 | ✅ **完成** | 真机验证 H1/H4；源码确认 H2/H3/H6/H7 |
| M1 骨架走通 | ✅ 完成 | 见下 |
| M2 模板层 | ✅ 完成（骨架） | 见下 |
| M3 WeiLin 集成 | 🟡 **后端完成 + 前端呈现已改进** | 见下；剩余：触发词编辑 UI（Q17）、标签写操作（Q12） |
| M4 前端完善 | 🟡 部分完成 | 表单/进度/出图/LoRA/标签均可用；持久化未做 |
| M5 打磨 | ⬜ 未开始 | |

### 真机环境基线

| 项 | 值 |
|----|-----|
| ComfyUI | **0.33.0** @ `10.2.3.22:8188`（Windows，32GB RAM） |
| 节点总数 | 2608 |
| WeiLin 节点 | `WeiLinPromptUI` / `WithoutLora` / `OnlyLoraStack` 均已加载 |
| WeiLin LoRA 索引 | **288 个**（`get_lora_load_status`） |
| diffusion_models | 32 个 |

### 已交付

```
apps/server/src/
  config.ts                     # 配置文件加载（JSONC + 优先级链 + 地址归一化）
  comfy/{types,real,mock}.ts    # 客户端抽象 + 真实(HTTP/WS) + 内置模拟器
  weilin/client.ts              # WeiLin 适配层（缓存 + 体积约束 + 降级 + 探活）
  templates/{loader,render,transforms}.ts   # 模板加载/静态校验/渲染/变换器
  jobs/manager.ts               # 任务状态机 + 事件映射 + 对账扫描
  http/routes.ts                # REST + SSE + WeiLin 数据源
  index.ts                      # 装配（含前端静态托管）
apps/web/src/
  components/TagSelector.vue    # 标签选择器：补全 + 中文释义 + 分组浏览 + chips
  components/LoraSelector.vue   # LoRA 选择器：搜索 + 目录 + 权重 + 预览图 + 触发词
  components/TemplateForm.vue   # 动态表单
  App.vue                       # 表单 + SSE 进度 + 出图 + 任务历史
packages/shared/                # 前后端共享类型
templates/txt2img-basic/        # 由 api.example.json 转成的首个模板
config.json                     # 配置文件（默认指向 10.2.3.22:8188）
```

### 验证结果

- `pnpm smoke` —— **50 项断言全绿**（配置解析/模板校验/渲染/变换器/校验拒绝/全链路/取图/API 形状透传）
- `tsc --noEmit` + `vue-tsc --noEmit` 全绿；`vite build` 通过（CSS 10KB / JS 89KB）
- **真机端到端**（`10.2.3.22:8188`，ComfyUI 0.33.0）：完整闭环
  `WeiLin 适配层取 LoRA → 前端形状提交 → 模板渲染 → 真实出图 → 取图`，
  512×768 出图（LoRA 权重 0.85 生效），SSE 收到真实 `progress`
- **WeiLin 端点到我们的 API 的体积压缩**：
  `41MB → 1.3KB`（LoRA 分页）、`848KB → 12KB`（标签分组）、
  `71KB/条 → 7.5KB`（LoRA 详情，且只在选中时拉）

### 真机验证暴露并修复的缺陷

| 缺陷 | 影响 | 修复 |
|------|------|------|
| `ws` 库文本帧是 **Buffer** 而非 string | **所有进度事件被静默丢弃**（HTTP 成功、出图成功，前端永远无进度） | 显式转字符串 + `isBinary` 区分预览帧 |
| 上游请求无超时 | 不可达的 ComfyUI 会让健康检查永久挂起 | `AbortSignal.timeout`（常规 30s / 探测 3s） |
| 丢事件后任务永久卡 `queued` | 状态永远不收敛 | 新增 10s 周期**对账扫描** `sweep()` |
| WeiLin 原始接口体积过大 | 前端会卡死（41MB / 848KB） | 适配层缓存 + 分页 + 按需查详情 |

### 关键实现决策（与文档的差异）

| 项 | 决策 | 原因 |
|----|------|------|
| client_id | **所有任务共用一个** | 进度只投递给提交者；共用后按 `prompt_id` 分流（§B.2） |
| 终态判定 | `/history` 为准 + 短重试 + 周期对账 | `executing node=null` 与 history 落盘有竞态；WS 还会丢事件 |
| LoRA 载体 | `lora_str` + `positive` **都写** | 与 WeiLin 前端产出一致；节点内部会去重合并 |
| mock 模式 | 内置模拟器 + 真实 PNG 生成 | `/workspace/ComfyUI` 无 venv/torch，本地跑不起来 |
| 配置来源 | **配置文件优先**，环境变量可覆盖 | 便于用户直接改文件；`configFiles` 在健康检查回显 |

---

## M0 · 冒烟验证（阻断式）

**目标**：验证 [v1-plan.md](./plan.md) §4 中**尚未由源码确认**的假设。

> 进度：H2 / H3 / H6 / H7 已由源码确认；本阶段聚焦 **H1 / H4 / H5** 与运行时行为。

### 任务

- [ ] 启动 ComfyUI（`:8188`），确认版本 0.36.0
- [ ] `GET /object_info` 确认三个节点均已加载：
      `WeiLinPromptUI`、`WeiLinPromptUIWithoutLora`、`WeiLinPromptUIOnlyLoraStack`
- [ ] **H1（关键）**：用 `ws` 连 `/ws?clientId=X`，
      POST `/prompt` 时**带同一个 `client_id=X`**，
      确认收到 `progress` 事件（不是只收到广播类事件）
- [ ] **H4**：`curl` 实测 WeiLin 接口
  - `get_lora_load_status`
  - `get_lora_list`
  - `prompt/get_groups_list`
  - `prompt/fast/autocomplete?q=blue`
  - `lorainfo/api/loras/info`（确认 `trainedWords` / `loraWorks` 结构）
- [ ] 用 `api.example.json` **原样** POST `/prompt` → 确认出图
- [ ] **H2**：把 `43.inputs.positive` 换成纯文本 `"a cat"` → 确认提示词生效
- [ ] **H5**：`opt_text` 传**字面量字符串**（不改连线）是否可行
- [ ] **H6 实证（决定 Q15）**：观察 ComfyUI 控制台日志 `添加触发词到提示词开头: ...`
      → **记录实际注入的词**，判断它是
      (a) 元数据/Civitai 的正确词 → 可选方案 A（零代码）
      (b) 回退成文件名（如 `taffy-style`）→ 必须选方案 B
- [ ] **LoRA 生效验证**：改 `43.inputs.lora_str` 的 `weight` → 确认出图变化
- [ ] 测试 `auto_random=true`，观察 WS `executed.ui.positive` 回传
- [ ] **前端可行性**：`cd WeiLin-Comfyui-Tools/src && npm i && npm run build`
      → 确认其 Vue 应用可独立构建（Q16 策略 A 的前提）

### 验收标准

- [ ] 每个待验假设有**明确的"是/否"结论**，记录到本文档
- [ ] 有一份可复现的 `scripts/smoke.ts`（或 shell）
- [ ] `H1` 通过 → 确认"同 client_id"策略正确（§3.2）
- [ ] `H6` 通过 → 确认触发词注入确实由节点完成，据此定 Q15

### 产出

`v1/smoke-report.md` —— 假设验证结果 + 实测的接口样例（请求/响应原文）

---

## M1 · 骨架走通（最简闭环）

**目标**：硬编码一份 graph，从 HTTP 提交到拿到图片，**端到端跑通**。

### 任务

- [ ] 初始化 pnpm monorepo（`apps/server`、`apps/web`、`packages/shared`）
- [ ] `apps/server`：Fastify + TypeScript + tsx watch
- [ ] `comfy/rest.ts`：`submitPrompt`、`getHistory`、`getView`、`getObjectInfo`
- [ ] `comfy/ws.ts`：单例连接 + **按任务的 `client_id` 提交** + 按 `prompt_id` 分发 + 自动重连
- [ ] `jobs/`：内存态任务状态机（**不落库**）
- [ ] `GET /api/jobs/:id/events`（SSE）推送进度
- [ ] 极简前端：一个 textarea + 生成按钮 + 进度条 + 结果图

### 验收标准

- [ ] 浏览器输入提示词 → 出图 → 展示，全程 < 1 屏代码
- [ ] 进度条随 WS `progress` 事件更新
- [ ] 执行失败时前端展示可读错误
- [ ] **ComfyUI 重启后**，server 能自动重连 WS（不崩）

### 风险

- SSE 与 WS 的事件映射边界（`executing` 的 `node=null` 语义）

---

## M2 · 模板层

**目标**：把 M1 的硬编码 graph 变成数据驱动的模板。

### 任务

- [ ] 定义 `template.schema.json`（依据 [templates.md](./templates.md) §2）
- [ ] `templates/` 加载器 + 静态校验（启动时快速失败）
- [ ] `render()`：bindings 应用 + transform 变换器
- [ ] 动态校验：渲染后对 `/object_info` 校验
- [ ] `GET /api/templates` / `GET /api/templates/:id`
- [ ] 把 `api.example.json` 转成第一个正式模板 `txt2img-basic`
- [ ] CLI：`template:validate`、`template:preview`
- [ ]（可选）`template:init` 从 api.json 生成骨架

### 验收标准

- [ ] `GET /api/templates/txt2img-basic` 返回正确 inputs
- [ ] 表单值正确注入 graph（`template:preview` 的 diff 符合预期）
- [ ] 非法值（如 `seed: "abc"`）返回 `422` 且错误定位到字段
- [ ] 模板静态校验失败时**服务器拒绝启动**并输出清晰原因
- [ ] 新增一个模板**不需要改服务器代码**（纯加文件）

### 风险

- binding 路径表达式的健壮性（节点 ID 含特殊字符）
- `/object_info` 的 COMBO enum 校验可能过严（如动态模型列表）

---

## M3 · WeiLin 集成

**目标**：标签选择 + LoRA 选择 + **触发词注入**全部可用。

> 定位变更：WeiLin 是**强依赖**（Q4 已决），因此不再要求"WeiLin 禁用仍可出图"，
> 而是要求**不可用时给出明确可操作的错误**。
>
> **落地情况（2026-09-18）**：后端适配层已完成并真机验证；
> 前端先采用 **Q16 方案 C（自建组件）** 落地了一版数据驱动的
> `TagSelector` / `LoraSelector`，交互与 WeiLin 原生对齐
> （补全、中文释义、分组浏览、权重、预览图、触发词展示）。
> 是否进一步改为「搬 WeiLin 源码组件」仍待决策。

### 任务（已完成部分）

- [x] `weilin/client.ts`：适配 `/weilin/prompt_ui/api/*` + 缓存 + 体积约束
- [x] 能力探测（`get_lora_load_status`）+ 降级（前端隐藏/禁用面板）
- [x] `GET /api/loras`、`/api/loras/folders`、`/api/loras/meta`、`/api/loras/preview`
- [x] `GET /api/tags`、`/api/tags/autocomplete`、`/api/tags/groups`
- [x] `POST /api/tags/translate`
- [x] transform：`weilinTokens`、`weilinLora`、`weilinLoraTags`
- [x] 模板接入 WeiLin 节点（`lora_str` + `positive` 标签）
- [x] 触发词写入：**沿用节点原生注入**（Q15 方案 A，不自行实现）
- [x] 前端 `TagSelector.vue` / `LoraSelector.vue`（数据驱动）
- [x] 转义正确性单测：含 `\` 的 LoRA 名往返
- [ ] 解析 WS `executed.ui.positive` → 记录"实际使用的提示词"（Q14）
- [ ] 标签管理写操作（Q12）
- [ ] `random_template` 前端选择器

### 验收标准

- [ ] 前端能搜索标签，选中后进入提示词（带中文翻译显示）
- [ ] 前端能搜索 LoRA、设权重，生成时**确实生效**（对比出图差异）
- [ ] **触发词注入生效且不重复**（对比 Q15 方案 A/B 的实测结果）
- [ ] 用户编辑的触发词（若选方案 B）在生成中体现
- [ ] `auto_random` 开启后，任务详情能看到本次实际随机到的提示词
- [ ] **WeiLin 不可用时**：返回明确错误（非静默失败），且健康检查可诊断
- [ ] LoRA 名含 `\` 与非 ASCII 时，`lora_str` 往返无损

### 风险

- WeiLin 接口参数名与预期不符（M0 已部分消除）
- 标签数据量大时的分页/性能
- 触发词方案选择错误导致重复注入（**需 M0 的 H6 证据**）

---

## M4 · 前端完善 + 持久化

**目标**：从"能用"到"日常可用"，并**搬入 WeiLin 的 Vue 组件**（Q16 策略 A）。

### 任务

**后端 / 持久化**
- [ ] SQLite 落库（`jobs`/`job_events`/`assets`），Drizzle 迁移
- [ ] 任务崩溃恢复：重启后对账 `/queue` + `/history`
- [ ] 图片代理 + 缩略图缓存（`/api/assets/:id/raw?thumb=1`）
- [ ] 上传图片（img2img 模板）
- [ ] 设置页后端：ComfyUI 地址、默认模型
- [ ] 生产模式：server 托管 SPA 静态产物

**前端 / 搬运 WeiLin 组件**（按 Q16 决策展开）
- [ ] 建立 `apps/web`（Vue 3 + Vite + Pinia + vue-i18n）
- [ ] 搬运 `prompt_box/prompt_index.vue`（提示词编辑器）→ 去除 postMessage
- [ ] 搬运 `prompt_box/components/lora_stack.vue`（LoRA 选择器）
- [ ] 搬运 `lora_manager/*`（LoRA 卡片/预览图）
- [ ] （可选）搬运 `tag_manager/*`（标签库）
- [ ] `api/request.js` 改指向我们的 `/api/*`
- [ ] 复用 `i18n/locales/zh_CN.js`
- [ ] 图库页：历史产出、按任务浏览、复用参数
- [ ] 队列页：队列位置、取消
- [ ] 表单控件完善：`slider`、`seed`、`visibleIf` 条件显示

### 验收标准

- [ ] server 重启后，历史任务与图片仍可浏览
- [ ] server 重启时正在执行的任务，状态能正确对账为 `succeeded`/`failed`
- [ ] 图库缩略图加载 < 200ms（缓存命中）
- [ ] 单进程启动即可用（生产模式无需单独跑 Vite）
- [ ] **提示词编辑器可独立使用**（不依赖 ComfyUI 节点/iframe）
- [ ] 标签着色、翻译、LoRA 权重/触发词 UI 与 WeiLin 原生体验一致
- [ ] 无遗留 `window.parent.postMessage` 调用

---

## M5 · 打磨

- [ ] 错误信息中文化、可操作（"模型 X 不存在，请检查 ComfyUI"）
- [ ] 结构化日志（pino）+ 请求 ID 贯穿
- [ ] `GET /api/system/health` 完整实现
- [ ] 出图完成通知（浏览器 Notification）
- [ ] 移动端适配（至少不破版）
- [ ] README + 部署文档
- [ ] 多用户预留检查：所有表有 `user_id`，接口鉴权中间件留桩

### 验收标准

- [ ] 从零（新机器）按 README 能在 10 分钟内跑起来
- [ ] 无 TypeScript 错误（`tsc --noEmit` 全绿）
- [ ] 关键路径有测试：模板渲染、weilin transform、任务状态机

---

## 测试策略

| 层级 | 范围 | 工具 |
|------|------|------|
| 单元 | transform、render、状态机、DTO 映射 | vitest |
| 契约 | WeiLin 接口响应形状快照 | vitest + 录制回放 |
| 集成 | 对真实 ComfyUI 提交任务（**可选，慢**） | vitest + 标记 |
| 冒烟 | M0 脚本，随时可跑 | tsx script |
| 手工 | 前端交互、出图效果 | — |

> **建议**：WeiLin 契约测试用**录制回放**（把真实响应存成 fixture），
> 这样 CI 不依赖 ComfyUI 在线，又能捕获上游变更。

**当前入口是 `pnpm verify`**（`scripts/verify.mjs`）：按 `typecheck → smoke → build → contract`
顺序跑，每步只输出一行结论；完整输出落 `.cache/verify/<step>.log`，失败时才摘出
失败行回显。冒烟脚本本身默认也只打结论（`--verbose` 出全量明细，`--log=` 落盘），
避免 150+ 行断言明细淹没终端 / agent 上下文。`contract` 这一步跑各插件自己的前端产物
契约测试（`pnpm -r --filter "./plugins/*" test:contract`，示例见
`plugins/anima-example/scripts/contract-test.mjs`），必须排在 `build` 之后 ——
它要 `import()` 构建产物。等 vitest 落地后，把 unit 作为新步骤接进 `verify.mjs` 的
`STEPS` 即可。

---

## 工作量估算（粗）

| 里程碑 | 估算 | 说明 |
|--------|------|------|
| M0 | 0.5d | 阻断式，必须先做 |
| M1 | 1d | 骨架+最简闭环 |
| M2 | 1.5d | 模板层是核心复杂度 |
| M3 | 1.5d | 依赖 M0 的实测结果 |
| M4 | **3–4d** | 持久化 + **搬运 WeiLin Vue 组件**（不确定性最大） |
| M5 | 1d | 打磨 |
| **合计** | **~9–10d** | 不含出图调参/审美迭代 |

> **估算说明**：
> - M4 的浮动来自 **Q16**：策略 B（嵌 UMD）可能 1d 搞定，策略 A（搬源码）要 3–4d 但更可控。
> - **未计入**：Q15 若选方案 B 的触发词自实现（+0.5d）、Q12 标签管理写操作（+1d）。

---

## 立即可做的下一步

1. **你确认**剩余待决项（优先 **Q15 触发词方案** / **Q16 组件搬运策略** / **Q18 LoRA 载体**）
2. 我执行 **M0 冒烟脚本**（这是解锁一切的前提）
3. 冒烟结论回填 `v1/smoke-report.md`，然后进入 M1

---

## 待决项汇总（跨文档）

### 已决

| # | 问题 | 结论 | 文档 |
|---|------|------|------|
| Q1 | 前端 Vue3 还是 React？ | ✅ **Vue 3** | plan §6 |
| Q4 | 是否强依赖 WeiLin？ | ✅ **强依赖** | plan §6 |
| Q15 | 触发词注入来源 | ✅ **方案 A：沿用节点原生注入** | plan §6 |

### 待决（按优先级）

| # | 问题 | 文档 | 优先级 |
|---|------|------|--------|
| **Q16** | **前端搬运策略**：A 搬 `.vue` 源码 / B 嵌 UMD / C 自建 | weilin §6.2 | 🟡 中（已先落地 C 方案，见下） |
| Q2 | 模板格式是否采用 `inputs`+`bindings`+`graph`？ | template §10 | 🟡 中（已按此实现，待确认） |
| Q5 | 任务持久化 SQLite 还是只读 ComfyUI history？ | plan §6 | 🟡 中 |
| Q6 | 图片是否长期归档？ | plan §6 | 🟡 中 |
| Q9 | `positive` 走纯文本还是 JSON 富文本？ | template §10 | 🟡 中 |
| Q17 | 是否需要触发词编辑 UI？ | weilin §9 | 🟢 低 |
| Q7 | 是否回填 `extra_pnginfo.workflow`？ | api §B.8 | 🟢 低 |
| Q8 | `/view` 图片是否本地缓存归档？ | api §B.8 | 🟢 低 |
| Q10 | 是否需要 `template:init` 自动生成工具？ | template §10 | 🟢 低 |
| Q11 | 是否需要模板预设（preset）？ | template §10 | 🟢 低 |
| Q12 | 标签管理是否做写操作？ | weilin §9 | 🟢 低 |
| Q13 | 是否接入 WeiLin 提示词历史？ | weilin §9 | 🟢 低 |
| Q14 | 是否做随机结果预览？ | weilin §9 | 🟢 低 |
| Q12 | 标签管理是否做写操作？ | weilin §8 |
| Q13 | 是否接入 WeiLin 提示词历史？ | weilin §8 |
| Q14 | 是否做随机结果预览？ | weilin §8 |
