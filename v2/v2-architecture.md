# v2 架构设计：工作流插件化

> 状态：**讨论稿**（待用户确认）
> 上游文档：[v1-architecture](../v1/v1-architecture.md)
> 参照工程：`/workspace/bbs`（全栈插件契约）、`/app/deepseek-harness`（cordis 微内核 + 插件安装机制）
> 本文件第 2 节即决策清单，每轮讨论追加。

---

## 0. 一句话

把 v1 的「单体应用 + 模板数据」改成「**宿主框架 + 工作流插件**」：

**插件是各自独立构建、独立安装的 npm 包；宿主构建一次即冻结；加一个工作流 = 加一个包 + 重启一次，宿主的构建产物零改动。**

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 |
|---|---|
| G1 | 一个工作流 = 一个插件包，前后端同框（一个目录里既有 `src/server` 也有 `src/client`） |
| G2 | 宿主提供挂载点与句柄，不提供业务：前端 tab 挂载点、管理设置、后端路由挂载点、缓冲文件夹句柄、数据库句柄 |
| G3 | **加插件不重新混合编译宿主**（这是本轮的原始诉求） |
| G4 | 高度隔离：能力（weilin / ComfyUI / 任务 / 配额）做成**插件依赖**，不做框架内置 |
| G5 | 保住 v1 的运行期资产：不需要 node_modules 的后端单文件产物、SQLite 零运维、Node 24 内置模块 |

### 1.2 非目标（明确不做，避免范围蔓延）

| # | 非目标 | 理由 |
|---|---|---|
| N1 | 前端热更新（HMR / 运行期热插拔） | 原始诉求只是「不重新混合编译」；dsh 安装插件后同样建议重启。运行期装载 + 重启生效已足够 |
| N2 | 共享 UI 组件包（`ui-kit`） | 用户裁定：最基础的工作流可能没有这些组件。插件自带组件 |
| N3 | 前端 SDK（fetch / SSE 封装） | 用户裁定：插件自己写 `fetch` / `EventSource` |
| N4 | 第三方插件生态 / 公共 registry 分发 | 自用工具；分发走 `link:` 与 `.tgz` |
| N5 | 进程级隔离（每插件一个进程 / 容器） | 单进程内靠约定与装配期校验，不做物理隔离（与 bbs 的结论一致） |
| N6 | 跨插件联表与业务数据共享 | 见 §9 隔离规则 |

### 1.3 N1 + N3 带来的两个必须显式接受的后果

- **后果 A：tab 栏不做全局任务指示。** 没有统一进度协议，tab 上的「运行中」角标、跨工作流的任务列表都做不了，每个 tab 完全自包含。
- **后果 B：设置页逼出一个框架组件。** 不建 `ui-kit`，但「设置功能」若要插件零成本，框架必须内置一个 **schema → 表单**渲染器。它没有领域语义（不含 LoRA / 标签这类概念），是框架唯一的前端 UI 资产，不计入 N2。

---

## 2. 决策清单（已锁定）

| # | 决策项 | 结论 | 依据 |
|---|---|---|---|
| D1 | 前端栈 | **继续 Vue 3** | v1 组件（`TemplateForm` / `LoraSelector` / `PresetPicker` …）全复用；不引入 React |
| D2 | 插件内核 | **cordis** + `@cordisjs/plugin-loader` + `@cordisjs/plugin-include` + `schemastery` | 微内核 DI + 可逆注册 + 文件清单托管，正是「可插拔」的最小完整集 |
| D3 | 内核版本 | **锁死确切版本，不用 `^`** | 上游停在 `4.0.0-rc.7`（RC 期），小版本漂移会咬人。dsh 的做法是 vendor + pin，我们至少 pin |
| D4 | 插件来源与安装 | **npm 包 + profile 目录 + `plugin add`（转发 pnpm）** | 对齐 dsh：插件是包，profile 是清单，安装即改清单 |
| D5 | 前端装载机制 | **导入映射（import map）共享 Vue** | 宿主构建期固定输出 import map，插件 `external` 掉 `vue` / `vue-router`；宿主完全不需要知道插件是谁 |
| D6 | 元数据归属 | **包级静态事实在 `package.json`，部署事实在 `plugins.yml`** | 见 §4.2 / §6：随包发布的东西与随部署变化的东西必须分开 |
| D7 | 清单唯一真源 | **后端 Loader**，前端启动拉 `GET /api/plugins` | 避免前后端两份清单漂移（v1 已踩过 `VITE_API_TARGET` 双真源的坑） |
| D8 | 数据库 | **共享一个 SQLite + 框架强制表前缀**；废弃 `PRAGMA user_version` | 用户裁定；单库零运维，且工作流之间本就不该有数据耦合 |
| D9 | 能力归属 | `weilin` / `comfy` / `jobs` / `quota` 全是**能力插件**，框架不含业务 | 用户裁定「高度隔离，让 weilin 成为插件依赖而不是项目」 |
| D10 | 设置渲染 | **框架按 schemastery schema 自动渲染 + 插件可注册自定义组件覆盖** | 插件零成本、体验统一，同时保留逃生舱 |
| D11 | 交付顺序 | ① 框架本体（tab 栏 + 后端挂载点 + 设置）→ ② 极简工作流插件化安装验证 → ③ 改造 txt2img | 用户裁定 |

---

## 3. 总体架构

```
┌─────────────────────────── 浏览器 ───────────────────────────┐
│  宿主前端（Vue 3，构建一次冻结）                              │
│    index.html + import map  ──┐                              │
│    tab 栏（清单驱动）          │ 共享 Vue 实例                │
│    设置页（schema→表单）       │                              │
│    /w/<pluginId>/*  ──────────┼──▶ defineAsyncComponent(     │
│                               │      /plugins/<id>/client.js)│
└───────────────────────────────┼──────────────────────────────┘
                                │ HTTP / SSE
┌───────────────────────────────▼──────────────────────────────┐
│  宿主后端（Node 24 + cordis Loader，构建一次冻结）             │
│                                                              │
│  Loader + Include ◀── plugins.yml（清单，读写回文件）          │
│       │                                                      │
│       ├─ 句柄服务：ctx.db / ctx.buffer / ctx.routes            │
│       ├─ 清单端点：GET /api/plugins（= loader.entries() ⊕ 包 manifest）│
│       └─ 静态托管：/plugins/<id>/*（从 profile node_modules 真实路径送）│
│                                                              │
│  插件（各自独立构建，各自 npm 包）                              │
│    @wfp/txt2img   @wfp/weilin   @wfp/comfy   @wfp/jobs …       │
│                                                              │
│  共享 SQLite（一库，框架强制表前缀）+ data/buffers/<id>/{tmp,cache,files} │
└──────────────────────────────────────────────────────────────┘
```

三块职责边界：

| 块 | 有什么 | 没有什么 |
|---|---|---|
| 宿主后端 | Loader、句柄、清单端点、产物托管 | 任何业务逻辑；任何具体工作流的代码 |
| 宿主前端 | import map、tab 栏、设置页、路由前缀 | 任何业务组件；任何插件的代码 |
| 插件 | 自己的路由、job、表、文件夹、组件 | 对宿主的编译期依赖（只依赖契约与 peerDeps） |

---

## 4. 插件契约

### 4.1 包结构

```
@wfp/txt2img/
├── package.json           # 含 wfp manifest（§4.2）
├── src/
│   ├── server/index.ts    # cordis 插件：name / inject / Config / apply
│   ├── client/index.ts    # 前端入口：默认导出 { tabs, routes, settings? }
│   └── shared/            # 前后端共享的纯类型
├── migrations/            # 版本化 SQL（框架执行，见 §9）
├── lib/                   # 构建产物（server.js / client.js / client.css）
└── index.html?            # 不需要；前端只有入口，无独立壳
```

### 4.2 包 manifest（`package.json` 的 `wfp` 段）

**随包发布的静态事实**放这里：

```jsonc
{
  "name": "@wfp/txt2img",
  "version": "0.1.0",
  "peerDependencies": {
    "cordis": "4.0.0-rc.7",     // 与宿主完全一致，不用 ^
    "vue": "^3.5.0"             // 宿主启动校验一致性
  },
  "wfp": {
    "contract": 1,                                   // 契约版本闸门
    "server": "./lib/server.js",                     // 后端入口
    "client": "./lib/client.js",                     // 前端入口
    "tab": { "id": "txt2img", "title": "文生图", "icon": "brush", "order": 10 }
  }
}
```

### 4.3 后端入口（cordis 插件形状）

形状与 dsh 的插件完全一致（取自 `packages/acp/acp/src/index.ts`）：

```ts
export const name = 'txt2img'
export const inject = ['routes', 'db', 'buffer']   // 必需依赖；缺一个就 PENDING
export const Config = Schema.object({
  steps: Schema.number().default(20).description('采样步数'),
  defaultModel: Schema.string().default('sd_xl_base_1.0.safetensors'),
})
export function apply(ctx: Context, config: Config) {
  const db = ctx.db.for('txt2img')          // 前缀已注入，插件只写裸表名
  const dir = ctx.buffer.for('txt2img')     // { tmp, cache, files }
  ctx.routes.mount(router)                  // 框架加前缀 /api/p/txt2img
}
```

**可选依赖**（例如「装了 weilin 就用」）——注意本版本 cordis 的 `inject` **只有必需依赖**，没有 `optional` 语法（已核对 `vendor/cordis/src/registry.ts`）：

```ts
const weilin = ctx.get('weilin', false)   // strict=false → 缺失返回 undefined
```

### 4.4 前端入口

**默认导出**一个纯数据对象，宿主负责挂载：

```ts
export default {
  tabs: [{ id: 'txt2img', title: '文生图', order: 10 }],
  routes: [{ path: '', component: MainView }, { path: 'history', component: HistoryView }],
  settings: { default: SettingsView },   // 可选：覆盖框架的 schema→表单 默认渲染
}
```

契约要点：

- 插件**不创建 Vue app**、不碰 `createRouter`、不渲染 tab 栏——宿主是唯一 app 所有者。
- `import { ref } from 'vue'` 由 **import map** 解析到宿主那一份实例（§7.1）。
- CSS 用 `cssInjectedByJsPlugin` 让 JS 自注入，宿主不需要知道插件有几个样式文件。

### 4.5 契约版本闸门

- 插件声明 `wfp.contract: 1`；宿主不认识就**拒绝加载并在清单里报出原因**，不做兼容猜测。
- 启动校验 `peerDependencies.vue` 与宿主副本一致；不一致直接拒绝，别让它跑到运行期才炸。
- 演进策略待定（§12）。

---

## 5. 框架提供的句柄

### 5.1 `ctx.db` —— 数据库句柄

```ts
ctx.db.for(pluginId) → {
  exec(sql, params?),                    // 只许写裸表名 'presets'，框架落成 'txt2img__presets'
  migrate([{ version, name, sql }]),     // 框架写 _plugin_migrations，见 §9
  tx(fn),                                // 同库事务；契约禁止跨插件读写
}
```

- 句柄**不是裸 `DatabaseSync`**：包一层薄接口，将来换 PG 不用改插件。
- `exec` 里的表名由框架注入前缀；插件裸写 `txt2img__` 前缀视为违规（review 脚本拦截）。

### 5.2 `ctx.buffer` —— 缓冲文件夹句柄

```ts
ctx.buffer.for(pluginId) → {
  tmp, cache, files,     // 三条绝对路径，框架创建
  tmpFile(ext?),         // 受管临时文件（登记，便于清扫）
  resolve(rel),          // 越界校验后的绝对路径（realpath 前缀检查）
}
```

三档语义**必须分开**，否则清理逻辑互相误伤：

| 档 | 生命周期 | 谁清 |
|---|---|---|
| `tmp` | 短命 | **框架**：TTL 清扫 + 启动清孤儿 |
| `cache` | 可再生 | **插件自管**（如 v1 的 `data/cache/loras-thumbs`） |
| `files` | 用户资产 | **谁都不许自动清** |

物理位置：`data/buffers/<pluginId>/{tmp,cache,files}`。

### 5.3 `ctx.routes` + 静态托管

- `ctx.routes.mount(router)` → 框架统一加前缀 `/api/p/<pluginId>`，插件内部只写相对路径（避免打架，也便于卸载）。
- 插件前端产物由宿主托管在 `/plugins/<id>/*`，**从 profile 的 `node_modules` 解析真实路径后受控送出，不复制进 `dist/`**。

> ⚠️ **这条是「加插件不重编宿主」的后端那一半。**
> 如果做成「构建时把插件产物拷进 dist」，整个方案就退化成混合编译了。

### 5.4 清单端点 `GET /api/plugins`

唯一真源。由框架内置的 core 插件提供，把 `loader.entries()` 与各包 `wfp` manifest 合成：

```jsonc
[
  { "id": "txt2img", "title": "文生图", "icon": "brush", "order": 10,
    "clientUrl": "/plugins/txt2img/client.js", "enabled": true, "phase": "active" }
]
```

`phase` 暴露 Loader 的 fiber 状态（`pending` / `active` / `failed` …），失败的插件要在清单里能看见原因——照抄 dsh `plugin-inventory` 的「只读投影」思路：**每次调用现场读 Loader，不缓存**。

### 5.5 设置

- **默认渲染**：框架读插件的 `Config` schema，生成表单（含 secret 脱敏）。
- **覆盖**：插件在 `wfp.settings` / 前端入口里注册自定义组件，替换指定路径的渲染。
- 写入落在**用户覆盖层**（§6），不是 `plugins.yml`。

---

## 6. 清单与配置分层

```
plugins.yml（profile 内，Include 托管，读写回文件）      ← 部署/管理员层，人工可维护
  → 插件包 Config 默认值（schemastery schema）           ← 随包发布
    → 用户覆盖层（管理设置页写入）                        ← 用户层
```

```yaml
# profiles/default/plugins.yml
- id: txt2img
  name: '@wfp/txt2img'
  config:            # 部署层默认值（可省）
    steps: 30
- id: weilin
  name: '@wfp/weilin'
```

- 后层按 **row id** 覆盖前行，且**替换整段 config、不深合并**（cordis patch 语义，与 dsh 一致）。
- 用户覆盖层独立存储，**升级 / 重装插件不丢用户设置**；`plugins.yml` 保持人工可读可改。
- `disable` / `enable` 走 `loader.update`，**运行期即生效，不用重启**；`add` / `remove` 需要重启后端 + 刷新浏览器。这层差别要在 CLI 里说清楚。

---

## 7. 前端装载

### 7.1 共享 Vue：import map

宿主 `index.html` 构建期固定输出，**永不因插件变化**：

```html
<script type="importmap">
{ "imports": {
    "vue": "/vendor/vue.esm-browser.prod.js",
    "vue-router": "/vendor/vue-router.esm-browser.js"
} }
</script>
```

插件 bundle 里 `import { ref } from 'vue'` 被**浏览器**解析到宿主那一份实例。这是「宿主不需要知道插件是谁」的关键：

- 两个 Vue 副本 → `ref` / `provide` / `inject` / 组件树全部失效，所以 `external: ['vue', 'vue-router']` 是**硬要求**，不是优化。
- 备选方案是 dsh 的 module table 工厂格式（`(require) => module`），依赖闸门更严但需要自定义构建预设 + 宿主 runtime，本方案不采用（N1）。

### 7.2 启动时序

```
1. 浏览器加载宿主壳（Vue + vue-router + import map）
2. GET /api/plugins            ← 唯一真源
3. 对每个 enabled 插件：
     defineAsyncComponent(() => import(plugin.clientUrl))
4. 合并 tabs → 渲染 tab 栏；addRoute('/w/<id>', 插件的 routes)
5. 失败的插件：tab 位显示错误态（含 Loader 报的原因），不影响其它 tab
```

### 7.3 路由前缀

框架只管 `/w/<id>` 前缀与 tab 渲染位置；**插件内部子路由自管**（`routes` 数组相对挂载）。

### 7.4 开发态

主机稳定、插件各自 HMR——**这才是真正的「不重新混合编译」**：

- 插件前端自己 `vite dev` 起端口；开发态清单里 `clientUrl` 指向该 dev server。
- 插件后端改代码：`tsx watch` 重启插件进程段，或接 `@cordisjs/plugin-hmr`（可选，不进第一轮）。

---

## 8. 能力插件

**框架本体不含业务**，下列能力全部是普通插件，工作流插件按需依赖：

| 能力插件 | 提供 | 工作流插件怎么用 |
|---|---|---|
| `@wfp/weilin` | 标签库 / LoRA 浏览 / 缩略图（v1 `weilin/` 升格） | `inject: ['weilin']`（必需）或 `ctx.get('weilin', false)`（可选） |
| `@wfp/comfy` | ComfyUI 连接 + **全局并发闸门** + input/output 胶水（v1 `comfy/` 升格） | `inject: ['comfy']` |
| `@wfp/jobs` | 任务状态机 + 进度事件（后端） | `inject: ['jobs']`；**前端协议由插件自己消费**（N3） |
| `@wfp/quota` | 跨插件共享配额与护栏（v1 `safety/quota.ts` 升格） | `inject: ['quota']` |

### 为什么并发与配额必须共享

隔离做到底会撞上硬事实：**共享的是一块 GPU + 一个 ComfyUI 实例**。

| 冲突点 | 各自为政的后果 |
|---|---|
| WS 连接数 / 队列深度 | 每插件一条 → ComfyUI 侧连接爆炸、队列不可观测 |
| 并发提交 | 两个 tab 同时提交 → GPU OOM（v1 `safety/quota.ts` 就是为此存在） |
| ComfyUI `input`/`output` 目录 | 每插件各写一套上传/取图胶水 |

做成能力插件而非框架内置，既满足 G4 的隔离诉求，又不必重造这些轮子。

---

## 9. 共享 SQLite：迁移与隔离规则

### 9.1 `PRAGMA user_version` 必须废弃

v1（`apps/server/src/store/db.ts`）用 `PRAGMA user_version` 记迁移版本——它是**单库一个整数**。多插件共库时这个机制直接崩：A 插件跑到 version 5，B 插件会以为自己也到 5 了。

改为框架表：

```sql
CREATE TABLE _plugin_migrations (
  plugin_id  TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  name       TEXT,
  applied_at TEXT    NOT NULL,
  PRIMARY KEY (plugin_id, version)
);
```

框架负责：按插件执行其 `migrate([...])` 列表、每条单事务、失败整体回滚、**只追加不回改**。

### 9.2 三条强制规则

1. **表名前缀由框架强制注入**：插件只声明裸名 `presets`，框架落成 `txt2img__presets`；插件不许裸写 SQL 表名。做不到这条，卸载时无法按前缀清理。
2. **禁止跨插件 JOIN / 写入**：同库同连接，本方案**没有** bbs 那种 PG 角色的物理边界，只能靠约定 + 一个 review 脚本（类比 bbs 的 `scripts/check-plugin-deps.mjs`）。
3. **卸载语义**：删表 / 留表 / 询问用户——见 §12 待定项，须在写代码前定。

---

## 10. 目录结构

```
comfyui-server/
├── apps/
│   ├── server/              宿主后端（cordis Loader + 句柄 + 清单端点）
│   │   └── src/
│   │       ├── kernel/      Loader 引导、Include 装配
│   │       ├── handles/     db / buffer / routes
│   │       └── core-plugin/ 内置 core 插件（提供 /api/plugins、/plugins/* 托管）
│   └── web/                 宿主前端（Vue 壳 + tab 栏 + 设置页 + import map）
├── packages/
│   └── contract/            插件契约的类型包（纯类型，供插件 peerDep）
├── profiles/
│   └── default/
│       ├── package.json     插件依赖（pnpm 管理）+ profile manifest
│       ├── pnpm-workspace.yaml  含 storeDir（防 HOME 只读，见下）
│       └── plugins.yml      清单（Include 托管）
├── plugins/                 ← 开发态的插件源码（构建/发布后进 profile 的 node_modules）
├── data/
│   ├── comfyui-server.db    共享 SQLite
│   └── buffers/<pluginId>/{tmp,cache,files}
├── dist/                    宿主构建产物：server.mjs + web/（**不含任何插件**）
├── v1/                      v1 历史文档
└── v2/                      本目录
```

> **环境坑（提前记下）**：仓库 `pnpm-workspace.yaml` 已有 `storeDir: .pnpm-store`，原因是本环境 HOME 只读。**profile 目录里跑 pnpm 会用到默认 store，同样会炸**——profile 侧也必须显式指 `storeDir`。

---

## 11. 交付计划

### 第 1 步：框架本体（**零业务插件**）

产物：

- `apps/server`：Loader + Include 吃 `plugins.yml`、四个句柄、core 插件提供 `GET /api/plugins` 与 `/plugins/*` 托管
- `apps/web`：Vue 壳 + import map + tab 栏（纯清单驱动）+ 设置页（schema→表单）
- 插件 CLI：`plugin add / remove / list / enable / disable`

**验收标准**：把一个插件目录 `plugin add` 进来、重启，tab 就出现了——而宿主的构建产物**一个字节都没变**（可用构建前后 `sha256` 对比证明）。

### 第 2 步：极简工作流插件化安装

用户提供一个极简工作流，把它做成 `@wfp/<name>` 插件，验证：`plugin add` → 重启 → tab 出现 → 路由通 → 一张表建起来 → 一个临时文件落进 `tmp`。

### 第 3 步：改造 txt2img

把 v1 的 txt2img（模板渲染 + 预设 + 进度 + 图库 + weilin 依赖）整体迁成 `@wfp/txt2img` + `@wfp/weilin`。

---

## 12. 待定项与风险

| # | 项 | 现状 / 建议 |
|---|---|---|
| T1 | profile 位置 | 建议 `profiles/`（与 `data/` 并列，语义清晰）；放 `data/profiles/` 可复用现有容器挂载点但要接受「代码进数据卷」 |
| T2 | 用户覆盖层存储 | 建议 `data/settings.json`（单文档 + 原子写）：设置是配置不是业务数据，便于运维直接看/备份/回滚，且插件 DB 迁移未就绪时也能读 |
| T3 | secret 落盘形式 | 建议明文 + 文件权限 0600 + API 返回脱敏；不做加密（自用内网，加密的密钥管理成本更高） |
| T4 | 卸载语义 | 删表 / 留表 / 询问用户——**必须在写代码前定** |
| T5 | 契约版本演进策略 | 仅 `contract: 1` 闸门；破坏性变更时是「拒绝加载」还是「加载但降级」待定 |
| T6 | jobs 的前端进度协议 | N3 决定无统一 SDK；若将来要做全局任务指示，需要重新引入协议约定（后果 A） |
| R1 | cordis 上游是 RC | 锁死版本；必要时参照 dsh 做法 vendor 进来（可审计、可打补丁） |
| R2 | 前端装载的调试链路 | 插件 bundle 运行期加载，报错栈跨包；第一轮就要把「插件加载失败」的错误呈现做扎实 |
| R3 | 单文件产物的退化 | 后端仍可单文件；前端从「一个 web/ 目录」变成「web/ + /plugins/* 运行期托管」，部署说明需更新 |

---

## 13. 与 v1 的迁移映射

| v1 资产 | v2 归属 |
|---|---|
| `apps/server/src/comfy/` | 能力插件 `@wfp/comfy` |
| `apps/server/src/weilin/` | 能力插件 `@wfp/weilin` |
| `apps/server/src/jobs/manager.ts` | 能力插件 `@wfp/jobs` |
| `apps/server/src/safety/quota.ts` | 能力插件 `@wfp/quota` |
| `apps/server/src/store/db.ts` | 宿主 `ctx.db` 句柄（迁移机制重写，见 §9） |
| `apps/server/src/store/presets.ts` | 进 `@wfp/txt2img`（插件私有表） |
| `apps/server/src/templates/` | 进各插件（模板是插件私有资产，不再是全局数据目录） |
| `apps/server/src/http/routes.ts` | 拆到各插件；宿主只留清单端点与托管 |
| `apps/web/src/components/` | 进各插件；宿主只留壳 + tab 栏 + 设置页 |
| `config.json` | 拆成：宿主段（端口/路径/日志）+ `plugins.yml`（部署）+ 用户覆盖层 |

---

## 附：参照工程的关键坐标

| 事实 | 位置 |
|---|---|
| cordis 五概念 / 分发模式 / waterfall 语义 | `/app/deepseek-harness/docs/cordis-primer.zh.md` |
| Loader EntryTree API | `/app/deepseek-harness/vendor/loader/README.md` |
| Include：YAML ↔ Loader entries（含写回） | `/app/deepseek-harness/vendor/include/README.md` |
| 插件包 / profile / `dsh plugin add` / 层序 | `/app/deepseek-harness/docs/user/develop/basic/publish.zh.md` |
| 上游包名与版本对照表 | `/app/deepseek-harness/vendor/README.md` |
| `inject` 只有必需依赖（无 optional） | `/app/deepseek-harness/vendor/cordis/src/registry.ts` |
| 全栈插件契约（slots / capabilities / config / db 角色） | `/workspace/bbs/core/src/plugin.ts` |
| 装配分 Pass 校验（fail-fast 模型） | `/workspace/bbs/core/src/createServer.ts` |
