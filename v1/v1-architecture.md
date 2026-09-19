# v1 架构设计：ComfyUI 轻前端服务器

> 状态：**讨论稿**（待用户确认）
> 上游文档：[v1-plan](./v1-plan.md)

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        浏览器 (SPA)                          │
│  表单渲染 · 标签选择 · LoRA 选择 · 进度展示 · 图库           │
└───────────────┬──────────────────────────────┬───────────────┘
                │ HTTP (REST)                  │ SSE (进度)
                ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│              apps/server  (Node-TS, :8080)                   │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐   │
│  │ http/      │  │ templates/ │  │ jobs/                │   │
│  │ 路由层     │─▶│ 模板渲染   │─▶│ 状态机 + 事件总线    │   │
│  │ 校验/鉴权  │  │ 变量注入   │  │ 编排 ComfyUI 调用    │   │
│  └────────────┘  └────────────┘  └───────┬──────────────┘   │
│         │                                 │                  │
│         │        ┌────────────┐           │                  │
│         ├───────▶│ weilin/    │           │                  │
│         │        │ 适配+代理  │           │                  │
│         │        └─────┬──────┘           │                  │
│         │              │                  │                  │
│         │        ┌─────▼──────┐    ┌──────▼──────────────┐  │
│         │        │ store/     │    │ comfy/              │  │
│         │        │ SQLite     │    │ REST client + WS    │  │
│         │        └────────────┘    └──────┬──────────────┘  │
└─────────┼──────────────────────────────────┼─────────────────┘
          │                                  │
          │  (代理 /weilin/*)                │ /prompt · /ws · /history · /view
          ▼                                  ▼
┌──────────────────────────────────────────────────────────────┐
│              ComfyUI  (Python aiohttp, :8188)                │
│  原生路由  +  [WeiLin 插件路由 /weilin/prompt_ui/api/*]      │
│                                                              │
│  /workspace/ComfyUI                                          │
│  custom_nodes/WeiLin-Comfyui-Tools                           │
│  user_data/*.db  (标签库 / 历史 / danbooru)                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 分层与职责

### 2.1 `http/` — 路由层

- 定义对外 REST 契约（见 [v1-api.md](./v1-api.md)）
- 请求体校验（Zod / TypeBox）
- 统一错误映射：`ComfyUI 错误 → 领域错误 → HTTP 状态码`
- **不含业务逻辑**，只做编排调用

### 2.2 `templates/` — 模板引擎（本项目核心）

职责：把「用户表单值」渲染成「可直接 POST 给 ComfyUI 的完整 graph」。

```
template.json  +  values  ──render──▶  graph  ──validate──▶  graph'
```

- 加载：启动时扫描 `templates/`，缓存并计算 hash
- 渲染：按 `bindings` 把 value 写到 graph 的指定 node/input 路径
- 校验：
  - **静态**：模板自身 schema 合法（binding 指向的节点/字段存在）
  - **动态**：渲染后对 `/object_info` 校验类型与必填项
- 详见 [v1-template.md](./v1-template.md)

### 2.3 `jobs/` — 任务编排

任务状态机：

```
created ──▶ queued ──▶ running ──▶ succeeded
                 │         │
                 │         ├──▶ failed
                 │         └──▶ canceled
                 └──▶ rejected (校验失败/前置条件不满足)
```

职责：

- 生成 `client_id`（uuid），用于绑定 ComfyUI 的 WS
- 调用 `comfy/` 提交，维护与 `prompt_id` 的映射
- 订阅 WS 事件，转换为**领域事件**广播给 SSE 订阅者
- 终态时拉 `/history/{prompt_id}`，抽取输出文件名，落 `assets` 表
- 崩溃恢复：重启后以 ComfyUI `/queue` + `/history` 为准对账

**关键设计**：WS 只用于「进度」，**状态真相源是 ComfyUI 的 `/history` 与 `/queue`**。
即使服务器 WS 断线，也能通过对账恢复正确状态。

### 2.4 `comfy/` — ComfyUI 客户端

| 模块 | 职责 |
|------|------|
| `rest.ts` | 封装 `/prompt`、`/queue`、`/history`、`/view`、`/upload/image`、`/object_info`、`/system_stats`、`/interrupt` |
| `ws.ts` | 单例 WS 连接池；自动重连（指数退避）；按 `client_id` 分发消息 |
| `types.ts` | ComfyUI 消息与对象类型定义 |

WS 连接策略：**一个 ComfyUI 实例一条长连接**（ComfyUI 的 `/ws` 支持多 sid，
但为降低复杂度，服务器维护一条主连接，用 `client_id` 区分任务）。

### 2.5 `weilin/` — WeiLin 适配层

两种模式（见 [v1-weilin.md](./v1-weilin.md) §3）：

- **代理模式（v1 采用）**：`/api/tags/*` → `/weilin/prompt_ui/api/prompt/*`，只做转发 + 精简
- **直读模式（可选）**：直接读 `user_data/*.db`，绕过 HTTP

### 2.6 `store/` — 持久化

v1 表（SQLite）：

| 表 | 用途 |
|----|------|
| `jobs` | 任务记录（含 ComfyUI prompt_id、状态、模板、参数快照） |
| `job_events` | 事件日志（用于回放 SSE 与排障） |
| `assets` | 产出图片索引（filename/subfolder/type/尺寸/hash） |
| `templates` | 模板元数据（可选，也可纯文件系统） |
| `presets` | 预设（已实现，v1 第一张表） |

> 多用户预留：所有表带 `uid` 字段，v1 固定写 `"local"`（见 `store/presets.ts` 的 `LOCAL_UID`）。
> 迁移用 `PRAGMA user_version` 记录版本，只追加不回改。

---

## 3. 核心时序：一次出图

```
用户        SPA           server              ComfyUI        WeiLin
 │           │               │                    │             │
 │ 填表提交  │               │                    │             │
 ├──────────▶│ POST /api/jobs│                    │             │
 │           ├──────────────▶│                    │             │
 │           │               │ 1 取模板+校验      │             │
 │           │               │ 2 渲染 graph       │             │
 │           │               │ 3 GET /object_info │             │
 │           │               ├───────────────────▶│             │
 │           │               │◀───────────────────┤             │
 │           │               │ 4 POST /prompt     │             │
 │           │               ├───────────────────▶│             │
 │           │               │◀─ {prompt_id} ─────┤             │
 │           │◀─ {jobId} ────┤                    │             │
 │           │               │                    │             │
 │           │ GET /api/jobs/:id/events (SSE)     │             │
 │           ├──────────────▶│                    │             │
 │           │               │  WS /ws?clientId   │             │
 │           │               ├───────────────────▶│             │
 │           │               │◀─ executing 19 ────┤ (WeiLin 节点)│
 │           │               │                    ├────────────▶│
 │           │◀─ progress ───┤◀─ progress ────────┤             │
 │           │               │◀─ executed ────────┤             │
 │           │               │ 5 GET /history/:id │             │
 │           │               ├───────────────────▶│             │
 │           │               │◀─ outputs ─────────┤             │
 │           │◀─ completed ──┤ 6 落库 assets      │             │
 │ 看图      │               │                    │             │
 ├──────────▶│ GET /api/assets/:id/raw           │             │
 │           ├──────────────▶│ GET /view?...      │             │
 │           │               ├───────────────────▶│             │
```

---

## 4. 前端架构（SPA）

### 4.1 页面

| 页面 | 内容 |
|------|------|
| 生成页 | 动态表单（由模板生成）+ 标签选择器 + LoRA 选择器 + 生成按钮 |
| 队列页 | 当前任务进度、队列位置、取消按钮 |
| 图库页 | 历史产出、按任务/时间浏览、复用参数 |
| 设置页 | ComfyUI 地址、默认模型、主题 |

### 4.2 动态表单

模板 `inputs` 定义 → 前端渲染控件。控件类型（v1）：

`text` · `textarea` · `number` · `slider` · `select` · `switch` ·
`model-select` · `lora-select` · `tag-selector` · `image-upload` · `seed`

> `tag-selector` / `lora-select` 直接消费 `weilin/` 适配层的数据。

### 4.3 数据流

- 状态库：**Pinia**（Vue 3，已定）
- SSE 用 `EventSource`，封装成 composable
- 表单值 → `shared/` 的 `JobRequest` 类型（前后端同源）

### 4.4 复用 WeiLin 组件（**本项目的杠杆点**）

WeiLin 前端是 Vue 3.5 应用且与 ComfyUI 解耦，**直接搬运其组件**：

```
apps/web/src/
├── components/
│   ├── prompt-editor/     ← 搬自 WeiLin view/prompt_box/prompt_index.vue
│   ├── lora-selector/     ← 搬自 WeiLin view/prompt_box/components/lora_stack.vue
│   ├── lora-manager/      ← 搬自 WeiLin view/lora_manager/*
│   └── tag-manager/       ← 搬自 WeiLin view/tag_manager/*（可选）
├── stores/                ← 替换 WeiLin 的 postMessage 通信
└── api/                   ← 替换 WeiLin 的 axios baseURL
```

**改造要点**：删掉 `window.parent.postMessage`，改为 Pinia store 双向绑定。
详见 [v1-weilin.md](./v1-weilin.md) §6.3。

> 收益：提示词的标签着色、翻译、自动补全、LoRA 权重/触发词 UI 等
> **大量成熟交互细节无需重写**。

---

## 5. 部署形态

### v1（本机自用）

```
[ComfyUI :8188]  ←  [server :8080]  ←  [浏览器]
     ^                    ^
     └── 同一台机器，127.0.0.1 ──┘
```

- server 托管 SPA 静态产物（生产模式单进程）
- 开发模式：Vite dev server (5173) + server (8080)，Vite proxy 指向 server

### v2 预留（多用户）

- 前置反向代理终止 TLS + 鉴权
- server 无状态化（会话/任务转 Redis）
- ComfyUI 多实例 + 调度器

---

## 6. 关键技术选型

| 关注点 | 候选 | 结论 |
|--------|------|------|
| HTTP 框架 | Fastify / Hono / Express | **Fastify**（性能+生态+SSE 支持好） |
| WS 客户端 | `ws` / `undici` | **`ws`**（上游只有 WS，见 [v1-api](./v1-api.md) §B.2） |
| 校验 | Zod / TypeBox | **Zod**（DX 好）；若需 JSON Schema 复用则 TypeBox |
| 存储 | ~~SQLite + better-sqlite3~~ → **`node:sqlite`（Node 内置）** | 已落地：零依赖、零原生编译。better-sqlite3 是原生模块，与「纯 JS 构建」目标冲突（同 sharp） |
| 日志 | pino | **pino** |
| 前端 | Vue 3 + Vite + Pinia + vue-i18n | ✅ **已定**（Q1）——为复用 WeiLin 组件，见 [v1-weilin](./v1-weilin.md) §6 |
| 包管理 | pnpm workspace | **pnpm** |

> 前端选 Vue 3 的**决定性理由**：WeiLin 的前端就是 Vue 3.5 应用且与 ComfyUI 解耦，
> 可直接搬运其提示词编辑器与 LoRA 选择器（[v1-weilin](./v1-weilin.md) §6）。

---

## 7. 安全与边界（v1）

- server **仅监听 127.0.0.1**（默认）；如需局域网访问显式配置
- 不向浏览器暴露 ComfyUI 地址（全部经 server 代理）→ 避免 CORS 与地址泄漏
- 模板渲染**不接受任意 graph**，只接受服务端预置模板 + 受限变量注入
  → 防止任意节点执行（如 `--allow-dangerous` 类节点）
- 上传图片走 server 转发，限制大小与 MIME

---

## 8. 待办：需要验证的技术假设

见 [v1-plan.md](./v1-plan.md) §4 的假设表（H1–H7）。状态：

- ✅ 已由源码确认：**H2 / H3 / H6 / H7**
- ⚠️ 仍需运行时验证：**H1（WS + client_id）/ H4（WeiLin 接口）/ H5（opt_text 字面量）**

> **H3（CLIP 链路）** 仍是硬约束：模板必须保留完整 CLIP/MODEL 链路，
> 服务器只能改文本与参数字段，不能凭空造 conditioning。
