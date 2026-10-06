# 架构设计：工作流插件化

> 状态：**现行设计文档**。决策 D1–D21（§2 的表格），§14 记录落地现状，过程叙事在 [`docs/archive/`](./archive/README.md)。
> 新增决策追加到 §2，落地状态追加到 §14 —— **不要往回写过程叙事**，那正是文档开始拖慢开发的原因。

---

## 0. 一句话

把 v1 的「单体应用 + 模板数据」改成「**宿主框架 + 工作流插件**」：

**插件是 `tabs/<id>/` 里编译好的目录（源码在 `plugins/<id>/`）；宿主构建一次即冻结；加一个工作流 = 丢一个目录 + 点一次「重新扫描」，宿主的构建产物零改动。**

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 |
|---|---|
| G1 | 一个工作流 = 一个 tab（`tabs/<id>/`），前后端同框（源码工程里既有 `server/` 也有 `client/`） |
| G2 | 宿主提供挂载点与句柄，不提供业务：前端 tab 挂载点、管理设置、后端路由挂载点、插件文件空间句柄（**不含数据库**：存储形态由插件自定，见 D12） |
| G3 | **加插件不重新混合编译宿主**（这是本轮的原始诉求） |
| G4 | 高度隔离：能力（weilin / ComfyUI / 任务 / 配额）留在各插件里、只通过 HTTP 路由互相调用，不做框架内置（D19 后不存在"能力插件"这种被 import 的包） |
| G5 | 保住 v1 的运行期资产：不需要 node_modules 的后端单文件产物、SQLite 零运维、Node 24 内置模块 |

### 1.2 非目标（明确不做，避免范围蔓延）

| # | 非目标 | 理由 |
|---|---|---|
| N1 | 前端热更新（HMR） | 原始诉求只是「不重新混合编译」。后端已能做到重扫即重挂（D14/D20），前端仍是刷新浏览器 |
| N2 | 共享 UI 组件包（`ui-kit`） | 用户裁定：最基础的工作流可能没有这些组件。插件自带组件 |
| N3 | 前端 SDK（fetch / SSE 封装） | 用户裁定：插件自己写 `fetch` / `EventSource` |
| N4 | 第三方插件生态 / 公共 registry 分发 | 自用工具；分发的单位就是 `tabs/<id>/` 那个目录（D16/D19 之后没有安装步骤） |
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
| D2 | 插件内核 | **cordis** + `@cordisjs/plugin-loader`（~~`@cordisjs/plugin-include` + `schemastery`~~，已随 D19 删除） | 微内核 DI + 可逆注册，正是「可插拔」的最小集；清单托管随 profile 一起去掉了 |
| D3 | 内核版本 | **锁死确切版本，不用 `^`** | 上游停在 RC 期，小版本漂移会咬人。实际落地：`cordis@4.0.0-rc.10`、`@cordisjs/plugin-loader@1.0.0-rc.7` |
| D4 | 插件来源与安装 | ~~npm 包 + profile 目录 + `plugin add`（转发 pnpm）~~ —— **已随 D19 删除**（现状见 D14/D16） | 对齐 dsh 的初版设计；profile 退役后没有"安装"这一步了 |
| D5 | 前端装载机制 | **导入映射（import map）共享 Vue** | 宿主构建期固定输出 import map，插件 `external` 掉 `vue` / `vue-router`；宿主完全不需要知道插件是谁 |
| D6 | 元数据归属 | **包级静态事实在 `package.json`，部署事实在 `data/`** | 见 §4.2 / §6：随包发布的东西与随部署变化的东西必须分开（"部署事实在 `plugins.yml`"那半已随 D19 删除） |
| D7 | 清单唯一真源 | **后端 Loader**，前端启动拉 `GET /api/plugins` | 避免前后端两份清单漂移（v1 已踩过 `VITE_API_TARGET` 双真源的坑） |
| D8 | 数据库（**已被 D12 取代**） | ~~共享一个 SQLite + 框架强制表前缀~~ | 原裁定；后被 D12 取代 —— 既然不存在跨插件库操作，共享库剩下的只有耦合 |
| D9 | 能力归属 | `weilin` / `comfy` / `jobs` / `quota` 全是插件私有模块，框架不含业务（~~做成独立的能力插件~~ —— D19 后没有库形态插件，见 §8） | 用户裁定「高度隔离，让 weilin 成为插件依赖而不是项目」 |
| D10 | 设置渲染 | **插件 `package.json` 的 `plugin.settings[]` 自描述 JSON**，宿主按它渲染表单（**偏离**原计划） | 原计划用 schemastery 推断，但那要**执行插件代码**才能拿到 schema —— 插件导入失败时设置页就瞎了，而坏插件恰恰最需要改配置。JSON 元数据在导入失败时依然可读 |
| D11 | 交付顺序 | ① 框架本体（tab 栏 + 后端挂载点 + 设置）→ ② 极简工作流插件化安装验证 → ③ 改造 txt2img → anima-plus 插件 | 用户裁定 |
| D12 | 存储归属 | **核不提供数据库句柄**：只按**包名**在 `data/plugins/<包名>/` 下分一块唯一空间；建库、写 JSON、版本迁移、清理全是插件自己的事 | 用户裁定「不存在跨插件库操作」；落地见 §5、§9。代价：核里不再有迁移账本可查；改包名＝换空间 |
| D13 | 清单的入库形态 | ~~`plugins.yml` 不入库、入库模板 + profile 依赖~~ —— **已随 D19 删除**（没有清单了；本机状态只剩 `data/plugins/<包名>/`，本来就既不入库也不分发） | 当时的理由：清单里的 `config` 必然含本机值，提交它 = 待提交 diff + secret 泄漏面。见 §6.1 |
| D14 | 插件来源（唯一） | **`/tabs/<id>/` 目录即插件**：启动扫描一次 + 手动 `POST /api/tabs/rescan` 重扫（D20），目录名即 id，服务端入口按绝对路径交给 Loader；重挂时说明符带 `?v=` 绕开 ESM 缓存；自包含 bundle、配置自持 `data/plugins/<包名>/`， | 让"加一类工作流插件"退化成丢一个目录（零安装、零清单、零 `node_modules`）。代价：能写 `tabs/` = 能在宿主进程执行代码；重挂 = 新 fiber，插件必须用 `ctx.effect` 收尾且只能把状态放 `ctx.space`；宿主没有写它配置的端点（状态归插件）。见 §6.2 |
| D15 | tab 的配置归属 | **配置与设置界面都归插件自己**：值住在 `ctx.space`（如 `settings.json`），读写走插件自己的端点，界面在插件自己的页面里；宿主只提供 `POST /api/tabs/:id/reload`（强制重挂）让新值生效，清单行按 `configOwner` 标出归属，设置页对 `plugin` 的行只读 | 目录型 tab 没有"行配置"可写（D14 已定 `PUT config` 返回 400），而"宿主收下但只在内存里改"会造出假的生效 —— tab 重挂一次就丢（`tabs.ts` 装载时恒传 `config: {}`），设置页却还显示统一值。字段**形状**仍留在 `package.json` 的 `plugin.settings[]`（D10）由清单端点下发，插件不抄第二份。代价：每个插件要出一次自己的设置界面；|
| D16 | 配置的落点与 profile 的去留 | **宿主唯一配置文件 = `data/host.json`**（部署段 + 偏好段同处一个文件；不存在就写默认 —— 挂空 `data/` 卷即可启动；坏文件不覆盖）；**退役 profile**：npm 包形态、Include 装配、清单落盘一起删，插件只剩一种形态 —— `tabs/<id>/` 里**编译完的产物**，源码与构建留在 `plugins/*`；**不存在库形态插件**（没有被别的插件 import 的能力包），共享代码只在构建时 bundle 进产物 | 非 tab 插件没有规划，profile 的依赖解析 / 清单落盘 / 契约 patch 层全被 tabs 覆盖（tabs 自己的契约检查就在 `scanTabs()`）；统一地址只剩"作默认值只读下发"一条语义。见 §6.2、§14.5 |
| D17 | 产物的入库形态 | **`tabs/` 不入库**：它是 `plugins/*` 的构建产物（可复现：重建 16/16 文件字节一致），仓库只留 `tabs/README.md`（`.gitignore`: `/tabs/*/`）；`pnpm verify` 的 `tabs-sync` 步只做结构性检查（每个带 `scripts/pack.mjs` 的源码工程都有可装载的产物） | D16 之后 `plugins/*` 是唯一真源，产物入库换来的只有 788KB diff / 冲突 / 过期产物静默，而 `dist/`（宿主产物）本来就不入库；一致性由"构建可复现 + `tabs-sync`"保证。见 §4.1、§14.5 |
| D18 | 交付物的形状 | **`dist/` 是完整可跑的一包**：`app/`（`server.mjs` + `web/`）+ `tabs/`（`tabs/` 下每个子目录的**拷贝**）+ `data/`（空目录，首次启动写 `host.json`）；产物态 `repoRoot = dist/`（不再往上看 `pnpm-workspace.yaml`）；入口 `server.mjs`、**不出 sourcemap**；`docker-compose.yml` 把 `dist/` 的三段挂进容器（`app`/`tabs` 只读、`data` 可写） | 既然 `tabs/` 不入库（D17），交付物里必须有它，「把 `dist/` 拷到机器上就能跑」才成立；软链会让 dist 不可搬，所以用拷贝。副作用：仓库里跑产物与部署跑产物语义一致（都看 `dist/{tabs,data}`） |
| D21 | 启停落点 | **插件的启停写进 `data/host.json` 的 `disabled: []`**（宿主自己的部署事实）：`PUT /api/plugins/:id/enabled` 原子落盘后再改运行期状态；装载时（启动 / 重扫 / 重挂）一律**以盘上的值为准**，调用方不许把"这一行现在是停用的"再传下去；清单的 `enabled` 报当前事实（Loader 行优先，行还没落地才回落到盘） | "这个插件在这台装置上停用了"是**部署事实**，跟 tab 顺序/首页/统一地址同类 —— 归宿主；而插件的配置/库是**插件自己的数据**，归插件（D15）。两个真源各管各的，才不会出现"点了停用、重启又活了"。代价：多一个能写坏的状态位（清洗规则与其它偏好字段同款：非字符串丢弃、去重、限长）。见 §14.5 |
| D20 | 扫描时机 | **不监听、不轮询**：宿主只在**启动**与 `POST /api/tabs/rescan`（设置页/欢迎页的「重新扫描插件目录」按钮）时扫 `tabsDir`；重扫是**增量**的（只重挂指纹变了的），结果分项回报（`added`/`reloaded`/`removed`/`failed`），前端如实转述；`GET /api/plugins` 只列**已装载**的 tab（含没通过检查、已挂成 `rejected` 的）—— 不放"看得见但点不开"的条目 | 目录里什么时候有新东西，**改的人自己知道** —— 自动扫描换来的只有"改到一半被装成一份半成品"和一套没人看的 2s 心跳；顺带消掉"容器挂载 / 网络盘上 `fs.watch` 静默失聪"这个只有实测才会发现的坑（旧实现靠 2s 指纹轮询兜底，见 §14.5）。代价：放进去 / 改完必须点一下按钮（或 `curl -X POST /api/tabs/rescan`）才生效 |
| D22 | 工作流定义的形状 | **一个插件 = 一份工作流定义，不存在"模板"这层抽象**：图是插件根的 `workflow.json`（与 `package.json` 并列、`pack.mjs` 按名打包，跟 `anima-example` 一致），表单/绑定/产出/依赖声明在 `assets/form.json`；没有 `source.file` 指针（图不存第二份），没有多模板注册表 / 按 id 查 / id 唯一性校验（D16/D19 之后一个工作流 = 一个 tab，多模板能力从未被用过），HTTP 也随之去 `templateId`：`GET /api/template`（单数）、`POST /api/jobs` 只收 `values` | v1 的「模板数据」层是单体应用的产物（§0），v2 用「一个工作流 = 一个 tab」（G1）取代了它：一个插件里再分"模板"是重复抽象，而它唯一独有的能力（一格挂多套表单/图）没有任何使用者。旧形状还实际制造过事故：`workflow.json` 与 `graph.json` 两份图靠 `source.file` 指针连着，改一份忘另一份就悄悄跑偏。见 §10、§14 |
| D19 | profile 机制与示例 tab 的删除 | **`profiles/`、Include 装配、`apps/server/scripts/plugin.mjs`、清单落盘、契约 patch 层、`fallback`/`following` 全删**：插件唯一来源是 `tabs/<id>/`；统一地址只剩"只读默认值"（宿主不写进任何插件）；`tabs/hello/` 不再作为示例（写法见 `tabs/README.md`） | D16 已把落点定死（`data/host.json` + `tabs/`），留着 profile 只会多一条没人走的装配路径与一份"两个真源"的歧义；示例 tab 的内容已经并进 `tabs/README.md` 的三文件骨架。见 §6/§6.1/§14.5 |
| D23 | 插件页面崩了怎么办 | **前端渲染错误隔离**：`PluginBoundary` 包住 `<RouterView>`（`onErrorCaptured` → `return false`，且 **slot 永远渲染**），`app.config.errorHandler` 只记录、**不重抛** | dev 构建的 Vue 对**没人接住**的组件错误是 `throw err`（`logError` 的 `throwInDev`），而抛出点在调度器 `flushJobs` 里 —— 一个插件页面抛错就能让整个外壳停摆：插件区域空白、之后每次切 tab 再抛 `Cannot read properties of null (reading 'component')`，只能刷新浏览器（实测复现过）。`return false` 与"slot 永远渲染"缺一不可（前者防 re-throw，后者保证切走后 RouterView 还在树上）。见 §7.2、§14.2 |

```
┌─────────────────────────── 浏览器 ───────────────────────────┐
│  宿主前端（Vue 3，构建一次冻结）                              │
│    index.html + import map  ──┐                              │
│    tab 栏（清单驱动）          │ 共享 Vue 实例                │
│    设置页（清单 + 启停/偏好）  │                              │
│    /w/<pluginId>/*  ──────────┼──▶ defineAsyncComponent(     │
│                               │      /plugins/<id>/client.js)│
└───────────────────────────────┼──────────────────────────────┘
                                │ HTTP / SSE
┌───────────────────────────────▼──────────────────────────────┐
│  宿主后端（Node 24 + cordis Loader，构建一次冻结）             │
│                                                              │
│  Loader ◀── tabs/<id>/（目录即插件，D14/D16：唯一的插件来源）   │
│       │                                                      │
│       ├─ 句柄服务：ctx.space（按包名的文件空间）/ ctx.routes   │
│       ├─ 清单端点：GET /api/plugins（= loader.entries() ⊕ 包 manifest）│
│       └─ 静态托管：/plugins/<id>/*（从 tab 目录受控送出）      │
│                                                              │
│  交付物（各自独立构建、自包含）                                 │
│    tabs/anima-plus   tabs/anima-example   tabs/<你自己的> …    │
│                                                              │
│  插件私有空间：data/plugins/<包名>/（放 SQLite、JSON、图片…核不解释）      │
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

### 4.1 两处目录：源码工程 / 交付物

**宿主只读 `tabs/<id>/`**（D16）：那里全是编译完的文件，没有构建脚本、没有 `node_modules`。
源码工程与工具链留在 `plugins/<id>/`，构建把产物搬进 `tabs/`（`scripts/pack-tab.mjs`）。

```
plugins/<id>/                # 源码工程：devDependencies / vite / tsconfig 都在这
├── package.json             # 源码侧 manifest：plugin 段（§4.2）原样派生给 tab
├── server/**.ts|js          # 服务端源码（cordis 插件：name / inject / apply）
├── client/src/**.vue|ts     # 前端源码（入口 client/index.ts）
├── scripts/pack.mjs         # 构建：pnpm build:plugins → tabs/<id>/
└── vite.config.ts

tabs/<id>/                   # 交付物 = 宿主唯一装载的东西（目录名即 id，**不入库**）
├── package.json             # 派生 manifest：只留宿主会读的字段（name / main / plugin）
├── server.js                # 服务端入口（bundle 完，自包含）
├── client.js + client.css   # 前端入口（vue / vue-router 走页面 import map，不打进来）
└── assets/ readme.md …      # 插件自己声明的运行期资产
```

- 入口名固定 `server.js` / `client.js`，就在 tab 根；插件里 `new URL('./x', import.meta.url)` 按此写。
- **服务端多文件就必须打成单文件**（esbuild）：重挂只给**入口**说明符加 `?v=<token>`
  （`apps/server/src/tabs-loader.ts`），入口里 `import './x.js'` 解析出来的 URL 不带 query ——
  Node 的 ESM 缓存按 URL 记，于是"改完点重新扫描"看到的还是旧模块。
- `tabs/` **不入库**（构建产物、可复现）：仓库里只留 `tabs/README.md`（`.gitignore`：`/tabs/*/`）。
  `pnpm verify` 的 `tabs-sync` 步（`scripts/check-tabs-sync.mjs`）只做结构性检查：每个带
  `scripts/pack.mjs` 的 `plugins/<id>/` 都必须有能装载的 `tabs/<id>/`（`main` / `plugin.client`
  对得上、无 `node_modules`）。
- **手写 tab 不设源码目录**：直接把目录丢进 `tabs/`（纯 ESM、无工具链，骨架见 `tabs/README.md`）。
- **没有库形态插件**：插件之间不互相 import，共享代码只在构建时 bundle 进各自的产物。

### 4.2 包 manifest（`package.json` 的 `plugin` 段）

**随包发布的静态事实**放这里：

```jsonc
{
  "name": "@comfyui-web/anima-plus",
  "version": "0.1.0",
  "main": "./lib/server.js",          // 后端入口 = 包主入口（cordis 插件形状）
  "exports": {
    ".": "./lib/server.js",
    "./package.json": "./package.json" // 宿主读清单要用；exports 里必须显式导出
  },
  "plugin": {
    "contract": 1,                       // 契约版本闸门（§4.5）
    "title": "Anima Plus",
    "icon": "brush",
    "order": 10,
    "client": "lib/client.js",           // 前端入口，经 /plugins/<id>/<client> 送出
    "settings": [                        // 设置表单的自描述元数据（D10）
      {
        "key": "steps",
        "type": "number",                // string | number | boolean | select | textarea
        "label": "步数",
        "default": 30,
        "min": 1,
        "max": 150
      },
      {
        "key": "apiKey",
        "type": "string",
        "label": "API Key",
        "secret": true                   // 只写：API 回传脱敏，保存时占位符表示"不改"
      }
    ]
  }
}
```

**不需要 `peerDependencies`**：插件后端**只 import 类型、不 import cordis 运行时代码**
（宿主已把 cordis 打进自己的产物，插件再引一份就是两个实例）。前端同理 —— `vue` 由
import map 提供，插件 bundle 里 `external` 掉它即可。

### 4.3 后端入口（cordis 插件形状）

形状与 dsh 的插件完全一致（取自 dsh 仓的 `packages/acp/acp/src/index.ts`）：

```ts
export const name = 'anima-plus'
export const inject = ['routes', 'space']          // 必需依赖；缺一个就 PENDING
export const Config = Schema.object({
  steps: Schema.number().default(20).description('采样步数'),
  defaultModel: Schema.string().default('sd_xl_base_1.0.safetensors'),
})
export function apply(ctx: Context, config: Config) {
  const space = ctx.space.for('@comfyui-web/anima-plus')  // 按包名分一块目录
  const db = new DatabaseSync(space.resolve('anima-plus.sqlite'))  // 存储自管（node 内置）
  ctx.routes.mount(router)                  // 框架加前缀 /api/p/anima-plus
}
```

**可选依赖**：本版本 cordis 的 `inject` **只有必需依赖**（没有 `optional` 语法），
而宿主只 provide `space` / `routes` 两个句柄 —— 插件**没有**"注入另一个插件"这条路（D19）。
要用别人的能力就调它的 HTTP 路由。

### 4.4 前端入口

**默认导出**一个纯数据对象，宿主负责挂载：

```ts
export default {
  tabs: [{ id: 'anima-plus', title: 'Anima Plus', order: 10 }],
  routes: [{ path: '', component: MainView }, { path: 'history', component: HistoryView }],
}
```

契约要点：

- 插件**不创建 Vue app**、不碰 `createRouter`、不渲染 tab 栏——宿主是唯一 app 所有者。
- `import { ref } from 'vue'` 由 **import map** 解析到宿主那一份实例（§7.1）。
- CSS 用 `cssInjectedByJsPlugin` 让 JS 自注入，宿主不需要知道插件有几个样式文件。

### 4.5 契约版本闸门

- 插件声明 `plugin.contract: 1`；宿主不认识就**拒绝加载并在清单里报出原因**，不做兼容猜测。
- 启动校验 `peerDependencies.vue` 与宿主副本一致；不一致直接拒绝，别让它跑到运行期才炸。
- 演进策略：**拒绝加载**（§12 的 T5）。

---

## 5. 核提供的句柄

只有两个，都是挂载点级别的：**文件空间** + **路由**。核不知道也不关心插件怎么存数据。

### 5.1 `ctx.space` —— 文件空间句柄（D12）

```ts
ctx.space.for(packageName) → {
  packageName,           // 归属的包名
  root,                  // 绝对路径：data/plugins/<包名转义>/
  resolve(rel),          // 空间内相对路径 → 绝对路径，越界抛错
}
```

- **按包名分配**（`tabs/<id>/package.json` 的 `name`），不按目录名：空间跟着**代码**走；
  同一个包装两次＝同一块空间。
- 名字转义：`@comfyui-web/anima-example` → `data/plugins/@comfyui-web+anima-example/`
  （只替换作用域那一个斜杠，pnpm 在同名目录上的写法一致）。
- **只给一个目录，不预置任何子目录**：`tmp`/`cache`/`files` 那套三档语义取消了 ——
  路径怎么安排是插件的事，核一个字节都不清（没有 TTL 清扫，也没有启动清扫）。
- 空间里放什么由插件决定：SQLite 库文件、JSON 配置、图片、缩略图……核从不解析。
- `resolve()` 做越界校验（挡手滑，**不挡恶意**：同进程代码本来就能自己开文件）。

### 5.2 存储：插件自管（核不参与）

没有数据库句柄、没有表前缀、没有迁移账本。推荐（也是本仓库两个插件的做法）：

```js
const db = new DatabaseSync(space.resolve('anima-example.sqlite'))  // node 内置，零依赖
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
migrate(db)   // 自己实现：PRAGMA user_version + 只追加的迁移数组，见 §9
```

自己管库还换来一个额外好处：**可以用真外键**（`REFERENCES jobs(id) ON DELETE CASCADE`）——
那是"单所有者"才有的待遇，共用库时做不到。

### 5.3 `ctx.routes` + 静态托管

- `ctx.routes.mount(router)` → 框架统一加前缀 `/api/p/<pluginId>`，插件内部只写相对路径（避免打架，也便于卸载）。
- 插件前端产物由宿主托管在 `/plugins/<id>/*`，**从 tab 目录（`tabs/<id>/`）受控送出**：宿主只发它自己的那几个文件，插件目录不进宿主的 bundle。

> ⚠️ **这条是「加插件不重编宿主」的后端那一半。**
> 如果做成「构建时把插件产物拷进 dist」，整个方案就退化成混合编译了。

### 5.4 清单端点 `GET /api/plugins`

唯一真源。由框架内置的 core 插件提供，把 `loader.entries()` 与各包 `plugin` manifest 合成：

```jsonc
[
  { "id": "anima-plus", "title": "Anima Plus", "icon": "brush", "order": 10,
    "clientUrl": "/plugins/anima-plus/client.js", "enabled": true, "phase": "active" }
]
```

`phase` 暴露 Loader 的 fiber 状态（`pending` / `active` / `failed` …），失败的插件要在清单里能看见原因——照抄 dsh `plugin-inventory` 的「只读投影」思路：**每次调用现场读 Loader，不缓存**。

`settings` 是包 manifest 的 `plugin.settings[]` 原样带出 —— **只是字段形状**，给设置页做只读说明用；
行的**值**不住在宿主里（配置归插件自己，D15/D19）：设置页不渲染表单，也不再有任何 `config` /
`sources` 回传。错误原因分两类字段：`error`（装载或激活失败）与 `phase: "rejected"`（目录检查没过）。

### 5.5 外壳偏好：标签栏顺序 + 默认首页 + 显示别名

设置页负责这几件事，偏好存 `<dataDir>/host.json` 的偏好段：

```jsonc
{
  "tabOrder": ["anima-example", "anima-plus"],
  "home": "anima-plus",
  "tabAliases": { "anima-plus": "画图" },
  "homeLabel": "我的工作台",
  "globals": { "comfyuiBaseUrl": "" },
  "disabled": ["anima-example"]
}
```

同一个文件里还住着**宿主全局设置**（`globals`）与**启停名单**（`disabled`）——见 §5.7 / D21；
它们必须能在运行期改，理由和上面完全一样。

- **为什么不放仓库根**：这些值（连端口也是）都得能在运行期改，而仓库根在容器里是只读挂载；
  `data/` 才是「本装置自己的可写状态」。所以它们与部署段同住 `data/host.json`（D16，见 §1）。
- **端点**：`GET /api/ui` / `PUT /api/ui`（宿主 core 插件提供，只负责存取与清洗）。
- **回退链在外壳**（只有它看得到实时清单）：
  - 顺序 = **过滤 + 补齐**：偏好里点过名的按偏好排在前面，其余保持清单顺序跟在后面。
    所以偏好里留着已卸载插件的 id、或漏列了几个插件，都不会让 tab 栏缺项。
  - 默认首页 = 偏好里的 id（且当前真有这个 tab、且它没坏）→ 第一个没坏的 tab →
    第一个 tab（哪怕坏了：至少把失败原因摆出来，比白屏强）→ 一个 tab 都没有就留在欢迎页。
  - 根路径 `/` 按这条链重定向；偏好不可用时，设置页会把「已回退到谁」显式写出来。
- **显示别名是纯外壳的**：`tabAliases`（插件 id → 顶栏上的名字）与 `homeLabel`（顶栏品牌链接 =
  首页 `/home` 的显示名）只改**渲染出来的文字**，插件自己声明的 `title` 一个字都不动 ——
  所以改别名不用重挂插件、也不用插件配合。缺键 / 空值 = 回落到插件 title / 内置品牌名
  （`comfyui-web`），回退在外壳（`apps/web/src/store.ts` 的 `tabLabel` / `homeLabel`）。
- **后端只保证三件事**：读得到、写得进、坏文件不炸。文件缺失 / 不是 JSON / 类型不对
  一律退化成默认值；写入先写 `.tmp` 再 `rename`（原子替换）；清洗规则 = 去重、丢非字符串、
  限长限条数。测试口径见 §14.1e。

### 5.6 设置
### 5.6 设置（归插件自己，D15/D19）

- 插件在 `package.json` 的 `plugin.settings[]` 里声明字段（`type`/`label`/`default`/`options`…），
  宿主读包元数据后由 `GET /api/plugins` 原样带出。**这只是形状**：设置页不渲染表单、不写值，
  只把它当作「这个插件有哪些设置项」的只读说明（D15：目录型 tab 没有行配置可写）。
- 值由插件自己存：`ctx.space` 下自己的文件（`data/plugins/<包名>/`），读写走插件自己的端点，
  界面在插件自己的页面里；存完请求 `POST /api/tabs/<id>/reload` 让运行中的实例读到新值。
- **解析原则是「填错不许炸」**：非法值回默认、越界收敛进范围，并把结论（这次的值从哪儿来）
  由插件自己的端点露出来（`anima-plus` 的 `/config` 就是范例）。

**没有的**：宿主侧的 schema 表单渲染（`SchemaForm.vue` 随 D19 删除）、`PUT /api/plugins/:id/config`。
**不做**：插件设置进宿主配置 —— 插件设置是**每台部署一份**（地址、并发、缓存），用户偏好
（tab 排序、默认首页、统一地址）才走 `data/host.json`（§5.5）。

### 5.7 宿主全局设置：统一 ComfyUI 地址（只读默认值，D16/D19）

一台装置上多个插件连的往往是同一个 ComfyUI，所以设置页留了**一个统一地址**做备忘录，
写在 `data/host.json` 的偏好段：

```jsonc
{
  "tabOrder": ["anima-example", "anima-plus"],
  "home": "anima-plus",
  "tabAliases": { "anima-plus": "画图" },
  "homeLabel": "我的工作台",
  "globals": { "comfyuiBaseUrl": "http://10.2.3.22:8188" }
}
```

**它是「默认值」，不是「下发值」**：宿主**不会**把它写进任何插件。
**今天也没有任何插件消费它** —— 两个示例插件的地址都只来自它们自己的 `settings.json`；
将来某个插件想跟随，就自己 `GET /api/ui` 取它当兜底（只读），采用与否是插件的事。
D19 删掉的正是「宿主写进插件行配置 + `following` 名单 + `fallback` 声明」那套机制：备份与生效
都要落盘到别人的文件里，而「谁在跟随」是一个只有宿主知道的状态，两处很容易对不上。

- 语义只有一条：**设置页改它 = 改一份可读的全局默认值**；插件用不用、什么时候用，是插件的事（今天没人用，见上）。
- 核不认识 ComfyUI：`globals` 就是一个字符串字典（键随意），宿主不解释。
- 用户偏好（tab 排序 / 默认首页 / 显示别名 / 统一地址）都在 `data/host.json` 的偏好段；
  `PUT /api/ui` 只认这几个键（`tabOrder` / `home` / `tabAliases` / `homeLabel` / `globals`）。

## 6. 配置分层（D16/D19 之后）

```
插件包 plugin.settings[].default           ← 随包发布：字段形状 + 表单默认值（不改运行期行为）
  → data/plugins/<包名>/settings.json      ← 随机器：插件自己持有、自己读写（D12/D15）
  → data/host.json 的偏好段                ← 随用户：tab 排序 / 默认首页 / 显示别名 / 统一地址
```

- **随包发布**的东西在 `plugins/<id>/package.json`：`plugin.contract/title/order/client/settings`，
  构建时**原样派生**到 `tabs/<id>/package.json`（宿主只读派生后的那份）。
- **随机器**的东西在 `data/plugins/<包名>/`：插件自己的空间，宿主不代管、不迁移、不清理（D12）。
- **随用户**的东西在 `data/host.json` 的偏好段：`tabOrder` / `home` / `tabAliases` / `homeLabel` / `globals`。
- **没有「部署层」配置了**：`plugins.yml` 的 `config` 段、`profiles/`、`pnpm plugin` 全随 D19 删除 ——
  需要配置的插件自己给端点、自己存（§5.6），宿主不再替任何插件持有一份「它的配置」。

### 6.1 为什么不再有清单文件（D13 的结局）

清单（`plugins.yml`）当年承担三件事：插件集、每行的配置、启停状态。三件事的归宿：

| 当年 | 现在 |
|---|---|
| 插件集（`id` / `name`） | `tabs/` 目录本身就是插件集（D14/D16），源码在 `plugins/*` |
| 每行的配置 | 插件自己持有（D15），宿主没有写它配置的端点 |
| 启停状态 | 宿主自己持有：`data/host.json` 的 `disabled: []`（D21；选择它是因为"这个插件停用了"是**部署事实**，不是插件自己的数据） |

代价是明确的：**宿主侧看不到一份「这批部署装了什么、怎么配的」清单**。补偿：`tabs/` 目录就是
那份清单（它是构建产物、可复现），而「怎么配的」本来就该在本机的 `data/` 里看。
- 保存配置会**就地重载**该插件（`loader.update` → fiber 重建 → 立即生效，不用重启）。
- `disable` / `enable` 走 `loader.update`，**运行期即生效，不用重启**；`add` / `remove` 需要重启后端 + 刷新浏览器。这层差别在 CLI 与设置页里都写明了。

### 6.2 目录型 tab：`tabs/<id>/`（唯一的插件来源）

D14 引入的 `/tabs` 来源在 D16/D19 之后成了**唯一**来源：插件 = `tabs/<id>/` 目录。
目标是让"加一类工作流插件"退化成**丢一个目录**（零安装、零清单、零 `node_modules`）。

机制上没有任何新生命周期，全部是已有零件的另一种用法：

| 环节 | 做法 |
|---|---|
| 发现 | `apps/server/src/tabs.ts` 的 `scanTabs()` 扫 `<tabsDir>`（默认 `tabs/`），**只在启动与 `POST /api/tabs/rescan` 时**执行（D20）；重扫按目录指纹做增量：新的挂上、变的带 `?v=` 重挂、没了的卸掉 |
| 挂载 | `ctx.loader.create({ id: 目录名, name: 入口绝对路径, config: {} })` —— Loader 的 `import()` 直接吃绝对路径 |
| 改代码 | 目录指纹（相对路径 + size + mtime）一变就**卸载重挂**，说明符改成 `<入口>?v=<token>` —— 不同 URL = 新模块实例（`plugin-package.ts` 解析时会剥掉 query）。重挂 = 新 fiber，所以收尾要写 `ctx.effect`，状态要放 `ctx.space` |
| id | **目录名即 id**。平铺 entry 的 id 不能带 `:`（那是 Loader 的 group 分隔符，会让 `resolve`/`remove` 找不到它）；它同时决定 `/api/p/<id>` 与 `/plugins/<id>/` |
| manifest | 同一份 `package.json` 的 `plugin` 段（`contract` / `title` / `order` / `client` / `settings`）→ `GET /api/plugins`、设置页说明、前端装载全用它 |
| 失败 | 坏目录**不消失**：以 `disabled` 挂一行、原因记在 `problem` 上 → `GET /api/plugins` 里 `phase: "rejected"` + 原因，设置页照样列出来 |
| 状态 | 宿主**不持有**它们的配置：插件用 `ctx.space` 自持在 `data/plugins/<包名>/`；宿主**没有**写它配置的端点（D15/D19） |
| 配置 | 值 + 设置界面都归插件自己（D15）：字段形状照旧在 `package.json` 的 `plugin.settings[]`（由 `GET /api/plugins` 下发，只是形状），值写在插件自己的空间里；存完由插件的前端调 `POST /api/tabs/:id/reload` **强制重挂**，`apply()` 重新读一遍设置 |
| 统一地址 | 只读默认值（§5.7）：插件要就自己 `GET /api/ui` 取 `globals.comfyuiBaseUrl` 当兜底；宿主不往任何插件里写值 |

**为什么要求自包含**：插件产物本来就自带依赖（`plugins/anima-plus` 的 `dependencies` 是空的，
deps 全在 `devDependencies`、由 esbuild inline 进 `lib/server.js`），所以 tabs 目录下不需要
`node_modules` —— "丢目录就能用"因此成立，也顺手免掉 N 份不可复现的依赖树。

**生效时机**：改 `tabs/<id>/` 里的任何文件（源码或产物）都只是目录变了，**点一次「重新扫描插件目录」**
（= `POST /api/tabs/rescan`）才卸载重挂 —— 指纹一变就换带 `?v=` 的说明符，绕开 Node 的 ESM 模块缓存。
代价只有一条：重挂 = 新 fiber —— 插件要用 `ctx.effect` 把收尾做干净，要活下来的状态必须写进 `ctx.space`。
前端产物不用动：`/plugins/<id>/*` 不缓存，刷新浏览器就是新的。

**profile 已经没了**（D19）：宿主只扫 `tabsDir`，没有清单、没有 Include、没有模板 bootstrap。

分权已经拍完（D15+D21）：**插件自己的数据**（配置/库/缓存）在 `data/plugins/<包名>/`，
**宿主的部署事实**（顺序、首页、统一地址、启停）在 `data/host.json`。剩下的未决只有一条：
安全边界（能写 `tabs/` = 能在宿主进程执行代码，容器 / 文件权限是唯一边界）。
细节与写法见 `docs/config.md` §6、`tabs/README.md`。

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
6. 页面**渲染期**抛错：`PluginBoundary` 接住并给出可读原因，外壳与其它 tab 不受影响（D23）
```

### 7.3 路由前缀

**顺序有硬要求：先把插件的 `routes` 全部 `addRoute`，再 `app.use(router)` / `mount`。**
vue-router 的 `install()` 会立刻用 `history.location` 发起**首次导航**，而 `addRoute` **不会**重新解析
当前路由 —— 顺序反了的话，直接停在 `/w/<id>` 的首屏（例如默认首页）先匹配到兜底路由，
插件页面会显示成「没声明 routes」，点一下 tab 才恢复（实测踩过）。

框架只管 `/w/<id>` 前缀与 tab 渲染位置；**插件内部子路由自管**（`routes` 数组相对挂载）。

### 7.4 开发态

主机稳定、插件各自 HMR——**这才是真正的「不重新混合编译」**：

- 插件前端自己 `vite dev` 起端口；开发态清单里 `clientUrl` 指向该 dev server。
- 插件后端改代码：`tsx watch` 重启插件进程段，或接 `@cordisjs/plugin-hmr`（可选，不进第一轮）。

---

## 8. 能力（不再是插件）

**框架本体不含业务**：`comfy` / `weilin` / `jobs` / `quota` 这些能力今天各自住在用得上它的
插件里（`plugins/anima-plus/server/{comfy,weilin,jobs,safety}/`），**不是**能被 `inject` 的独立插件。
原因是 D16/D19 之后不存在"库形态插件"：跨插件只有一条路 —— 走 HTTP 路由，
没有"被 import 的能力包"，也就没有一个插件 `inject` 另一个插件的机制。

| 能力 | 今天在哪 | 将来若要复用 |
|---|---|---|
| ComfyUI 连接 / 上传取图 | `plugins/anima-plus/server/comfy/` | 抽成共享源码包，**构建时 bundle** 进各插件产物 |
| 标签库 / LoRA / 缩略图 | `plugins/anima-plus/server/weilin/` | 同上；或由一个插件暴露 HTTP 路由给别的插件 |
| 任务状态机 | `plugins/anima-plus/server/jobs/` | 同上 |
| 并发闸门 / 护栏 | `plugins/anima-plus/server/safety/` | 同上 |

### 为什么并发与配额必须共享

隔离做到底会撞上硬事实：**共享的是一块 GPU + 一个 ComfyUI 实例**。

| 冲突点 | 各自为政的后果 |
|---|---|
| WS 连接数 / 队列深度 | 每插件一条 → ComfyUI 侧连接爆炸、队列不可观测 |
| 并发提交 | 两个 tab 同时提交 → GPU OOM（v1 `safety/quota.ts` 就是为此存在） |
| ComfyUI `input`/`output` 目录 | 每插件各写一套上传/取图胶水 |

这些能力**不做框架内置**（G4），今天各自住在用得上它的插件里；跨插件复用只能走 HTTP 路由，
不引入"被 import 的能力包"（D19 已明确不存在这种形态）。

---

## 9. 存储：一插件一空间，版本自管（D12）

### 9.1 为什么 `PRAGMA user_version` 又回来了

v1（已删除的 `apps/server/src/store/db.ts`）用 `PRAGMA user_version` 记迁移版本，当初废弃它是因为
**多插件共库**时它是"单库一个整数"：A 插件跑到 5，B 插件会以为自己也到 5。

D12 把库拆给插件自己之后，一个库只有一个所有者，这个前提消失了 —— `PRAGMA user_version`
重新成为**正确**的机制（SQLite 原生、零额外表、事务内可更新）。本仓库的 `anima-example`
与 `demo` 都是这么做的：

```js
const MIGRATIONS = [{ version: 1, sql: `CREATE TABLE jobs (...)` }]

function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(step.sql)
      db.exec(`PRAGMA user_version = ${Number(step.version)}`)
      db.exec('COMMIT')
    } catch (err) { db.exec('ROLLBACK'); throw err }
  }
}
```

规则不变：**只追加、不回改，每条一个事务，失败整体回滚**。

### 9.2 三条规则

1. **一插件一空间**：`data/plugins/<包名>/` 是插件的私有财产，核不解析内容；
   建库、命名、版本、清理全自管。**没有任何跨插件库操作**（这是 D12 的前提）。
2. **插件之间只走 HTTP 路由**：要用别人的能力就调它的 API（`/api/p/<id>/…`），
   而不是读它的库文件 —— 库文件是各自的，"越权查表"这条路本来就不存在。
3. **卸载语义**：删插件 = 删 `tabs/<id>/` 目录（D19 后没有 `plugin remove` 了）；
   数据留在 `data/plugins/<包名>/`，宿主**碰都不碰** —— 要删自己删。见 T4。

---

## 10. 目录结构

```
comfyui-web/
├── apps/
│   ├── server/              宿主后端（cordis Loader + 句柄 + 清单端点）
│   │   ├── src/
│   │   │   ├── index.ts         进程入口：装配、信号、静态产物托管
│   │   │   ├── kernel.ts        Loader 引导、句柄、tab 扫描与热重挂装配
│   │   │   ├── core-plugin.ts   内置 core 插件入口（装配下面四块，/api/* 与 /plugins/* 托管）
│   │   │   ├── core-host.ts     core 的配置 / 共享上下文（TabsFacade、host.json 路径）
│   │   │   ├── core-rows.ts     清单行（phase 判定、manifest → PluginRow）
│   │   │   ├── core-routes.ts   宿主级端点：/api/{host,plugins,ui,tabs/*}
│   │   │   ├── core-assets.ts   /plugins/:id/* 产物直送（不复制进 dist）
│   │   │   ├── config.ts        data/host.json + 环境变量（dataDir 走 env/内置默认）
│   │   │   ├── host-settings.ts 唯一配置文件：部署段 + 偏好段（D16，读侧永不抛 / 坏文件不重写）
│   │   │   ├── plugin-package.ts 插件包 manifest 解析（含说明符 `?query` 剥离）
│   │   │   ├── tabs.ts          目录型插件模块出口（D14；实现见下面三个）
│   │   │   ├── tabs-scan.ts     扫目录 / 目录指纹（纯 fs）
│   │   │   ├── tabs-loader.ts   与 Loader/routes 打交道（挂 / 卸一行）
│   │   │   ├── tabs-service.ts  装载状态机（TabsService：重扫、重挂、清单）
│   │   │   ├── loader-entries.ts  Loader 行查找（`shortId` / `findEntry`）
│   │   │   └── handles/{space,routes}.ts   两个句柄
│   │   └── scripts/build.mjs               打包后端（esbuild → dist/app/server.mjs）
│   └── web/                 宿主前端（Vue 壳 + tab 栏 + 设置页 + import map）
├── packages/shared/         前后端共享的类型与常量
├── plugins/                 插件**源码工程**（vite / esbuild / tsconfig；构建成 tabs/<id>/，D16）
├── tabs/                    插件**交付物**（D16/D19）：一个子目录一个插件，目录名即 id、自包含无依赖
│                            （**不入库**：`.gitignore` 只留 `README.md`；写法见 tabs/README.md）
├── data/                    运行时状态（**全部不入库**）
│   ├── host.json            宿主唯一配置文件：部署段 + 偏好段（不存在时自动生成，D16）
│   └── plugins/<包名>/      核按包名给每个插件的空间（D12）
│       ├── @comfyui-web+anima-example/{anima-example.sqlite,images/}
│       └── @comfyui-web+anima-plus/{anima-plus.sqlite,cache/loras-thumbs/}
├── dist/                    构建产物（**不入库**，D17/D18）：整包可搬的交付物
│   ├── app/                 宿主：server.mjs（单文件后端，无 sourcemap）+ web/（前端外壳，**不含任何插件**）
│   ├── tabs/                plugins/* 构建出的插件交付物（宿主唯一装载来源）
│   └── data/                空目录：首次启动在这里写 host.json（部署时可写的那个卷）
├── docs/                    现行文档：README.md（索引）· architecture.md · config.md
│   └── archive/             历史文档（v1 时代 + v2 落地过程），只作来龙去脉参考
├── nginx.conf / docker-compose.yml
└── scripts/verify.mjs       `pnpm verify` 的入口

（旧服务的 data/comfyui-server.db、根 config.json、根 templates/、workflow/ 都已删除：
  预设迁进了插件空间，其余没有读者。v1 文档在 docs/archive/。
  模板这层抽象后来也删了（D22）：一个工作流 = 一个 tab，插件里不再分"模板"。）
```

> **环境坑（提前记下）**：仓库 `pnpm-workspace.yaml` 已有 `storeDir: .pnpm-store`，原因是本环境 HOME 只读。所有跑 pnpm 的地方都得显式指 store，别指望默认路径。

---

## 11. 落地路径

三步走，都已走完：

1. **框架本体（零业务插件）**：宿主 Loader、两个句柄、core 插件端点、前端壳 + tab 栏 + 设置页
   （当年的清单 + `plugin` CLI 已随 D19 删除）。验收标准是"装一个插件后宿主产物一个字节都不变"。
2. **极简工作流插件化**：`plugins/anima-example` —— 插件自己提交 ComfyUI、收 WS 进度、写自己的表，
   不反代任何旧服务。
3. **v1 整体搬迁**：`plugins/anima-plus` —— v1 的模板/渲染/显存护栏/任务编排/LoRA/标签/预设逐字搬进 `server/`，
   外加 WeiLin 反代与依赖检查。

当时的详细计划、每一条落地过程与实测证据（14.1b–14.1h）在
[`docs/archive/v2-implementation-notes.md`](./archive/v2-implementation-notes.md)。

---

## 12. 已定事项与遗留风险

| # | 项 | 结论 / 现状 |
|---|---|---|
| T1 | ~~profile 位置~~ | **已随 D19 删除**：没有 `profiles/` 了，插件来源只有 `tabs/`（D14/D16） |
| T2 | ~~用户覆盖层存储~~ | **已随 D19 删除**：当时取消独立用户层、设置页直接写清单；现在没有清单，用户偏好写 `data/host.json` 的偏好段（§5.5） |
| T3 | secret 落盘形式 | **明文 + 文件权限 + API 脱敏 + 保存时占位符语义**；不做加密 |
| T4 | 卸载语义 | **已随 D19 删除**（`plugin remove` 没了）：删插件 = 删 `tabs/<id>/` 目录；数据在 `data/plugins/<包名>/`，宿主动都不动（要删自己删） |
| T5 | 契约版本演进策略 | **拒绝加载**：`tabs.ts` 扫描时比对 `plugin.contract`，不匹配的 tab 挂成 `disabled` 并在 `GET /api/plugins` 里标 `phase: "rejected"` + 原因（D19 后不再有 Include patch 层） |
| T6 | jobs 的前端进度协议 | 保持「不做统一协议」；tab 栏不显示全局任务状态 |
| R1 | cordis 上游是 RC | 已锁死版本（D3）；暂不 vendor |
| R2 | 前端装载的调试链路 | 已落地：坏插件**占一个 tab 并显示原因**（`error` 字段贯穿 `/api/plugins` → tab 栏 → `/w/<id>` 兜底页） |
| R3 | 单文件产物的退化 | 已落地：交付物 = `dist/app/server.mjs` + `dist/app/web/` + `dist/tabs/` + `dist/data/`（D18）；插件前端由宿主从 `dist/tabs/<id>/` **直送**，不进宿主 bundle |

---

## 13. v1 资产去哪了（迁移映射）

| v1 资产 | v2 归属 |
|---|---|
| `apps/server/src/comfy/` | `plugins/anima-plus/server/comfy/`（插件私有模块，不是独立插件） |
| `apps/server/src/weilin/` | `plugins/anima-plus/server/weilin/` |
| `apps/server/src/jobs/manager.ts` | `plugins/anima-plus/server/jobs/` |
| `apps/server/src/safety/quota.ts` | `plugins/anima-plus/server/safety/` |
| `apps/server/src/store/db.ts` | **没有对应物**：核不再提供数据库句柄，各插件在自己的空间里自建（见 §9） |
| `apps/server/src/store/presets.ts` | 进 `@comfyui-web/anima-plus`（插件私有表） |
| `apps/server/src/templates/` | 进各插件（工作流是插件私有资产，不再是全局数据目录）；**多模板这层抽象已删**（D22）：一个插件 = 一份定义 |
| `apps/server/src/http/routes.ts` | 拆到各插件；宿主只留清单端点与托管 |
| `apps/web/src/components/` | 进各插件；宿主只留壳 + tab 栏 + 设置页 |
| `config.json` | 拆成：宿主段（端口/路径/日志，`data/host.json`）+ 用户偏好段（同文件）+ 插件自己的空间（D16/D19） |

---

## 14. 落地现状

**交付物**（只有一个后端：宿主；业务全在插件里）：

| 位置 | 内容 |
|---|---|
| `apps/server/` | 宿主后端：`config.ts` 配置、`kernel.ts` 装配（Loader + tabs）、`core-plugin.ts` + `core-{host,rows,routes,assets}.ts` 宿主端点、`tabs.ts` + `tabs-{scan,loader,service}.ts` 目录型插件、`host-settings.ts` 唯一配置文件（D16）、`handles/{space,routes}.ts` 两个句柄、`plugin-package.ts` 包清单解析、`scripts/build.mjs` |
| `apps/web/` | 宿主前端：`index.html`（import map 是核心）、`src/main.ts` 插件装载器、`App.vue` tab 栏壳、`views/SettingsView.vue` + `views/settings/*`（设置页只读展示插件设置，D15）、`styles/*.css`（`style.css` 只是 `@import` 入口） |
| `tabs/` | 工作流插件交付物（D14/D15/D16）：一个子目录一个插件、目录名即 id、自包含；装载时机见 D20（启动 + 手动重扫） |
| `plugins/anima-plus/` | **v1 整体搬完**：前端是 v1 的 `App.vue` + 8 个组件，后端是 v1 那 14 个模块逐字搬进 `server/`（渲染/显存护栏/任务编排/LoRA/标签/预设），反代已删；另加依赖检查（`server/deps.ts`，见 §14.1f）。工作流定义形状见 D22（`workflow.json` + `assets/form.json`）。见 §13 与 `plugins/anima-plus/README.md` |
| `data/host.json` | 宿主唯一配置文件（部署段 + 偏好段）；不存在时宿主写默认值，挂空 data 卷即可启动（D16） |

### 14.1 落地时的三处偏离（都要记住）

1. **设置渲染不用 schemastery，改用 `plugin.settings[]` 静态 JSON**（D10）。
   原方案要执行插件代码才能拿到 schema；插件导入失败时设置页会瞎，而坏插件恰恰最需要改配置。
2. **取消独立的用户设置层**：设置页只写 `data/host.json` 的偏好段（`plugins.yml` 那套已随 D19 删除，见 §6.1）。
3. **路由挂载点不是 fastify 的 `register`，而是可逆的分发表**。
   fastify 路由表在 `ready()` 之后冻结：既不能撤销也不能重复注册同一前缀。而本方案要求
   「改配置就地重载」和「运行期停用立即断流」，所以宿主只在启动时向 fastify 注册**一条**
   `/api/p/*` 兜底路由，运行期增删全是内存操作。插件拿到的是一个极小的路由门面
   （`get/post/put/patch/delete/all`，支持 `:param` 与 `*rest` ——
   透明反代要靠 `*rest` 接住任意深度的子路径）。

### 14.2 装配期的三个关键机制

- **契约闸门在扫描时判定**（D19 后没有 patch 层）：`tabs.ts` 比对 `plugin.contract`，不匹配的目录
  **不会进 Loader**，而是以 `disabled` 挂一行并把原因记在 `problem` 上 —— 文件本身自然不动（T5）。
- **单插件失败隔离 + 可见**：模块导入失败/激活失败不会让宿主退出，而是记进日志并在
  `/api/plugins` 的 `error` 字段里露出，前端给它一个带 `!` 的 tab。装配期信息比"安静地少一个 tab"重要得多。
- **前端渲染错误隔离（D23）**：`PluginBoundary` 包住 `<RouterView>`（`apps/web/src/plugin-boundary.ts`），
  `app.config.errorHandler` 兜边界之外的错误。插件页面在渲染期抛错时，它那一块显示原因、外壳和其它 tab 照常，
  切走再回来即恢复。验证在 `apps/web/scripts/isolation-test.mjs`（`pnpm verify` 的 `isolation` 步，
  不需要浏览器：用宿主 dev 态那份 Vue + 自建 renderer 复现机制）。

### 14.3 已知限制

- 插件前端入口**运行时动态 import**，不使用打包器的静态分析：插件 bundle 要自己保证是自包含的 ESM
  （只 external `vue` / `vue-router`）。
- 插件前端入口**运行时动态 import**（不经打包器改写），所以坏插件的报错只到"加载失败 + 原因"这一层；`tabs/` 里没有构建脚本可用，产物必须是编译完的。
- 前端 `import(...)` 的调试栈跨包，坏插件的报错目前只到"加载失败 + 原因"这一层。
- 本仓库的开发沙箱里，跨 `bash` 调用启动的后台进程无法回收（PID namespace 限制），
  所以验证时统一用「同一次调用内启动 + kill」，或换空闲端口。

### 14.4 D15 的落点（tab 的配置归插件自己）

- **宿主侧**：`POST /api/tabs/:id/reload`（`tabs.ts` 的 `reload()`：指纹没变也卸载重挂，运行期停用状态保留）；
  没有写插件配置的端点（D19 把 `PUT /api/plugins/:id/config` 与 `fallback`/`following` 一起去掉了）。
- **外壳侧**：`SettingsView.vue` 对插件行只显示说明与只读的 `plugin.settings[]`，不渲染表单、不给保存按钮。
- **插件侧**：`anima-plus` / `anima-example` 各自把设置写进 `ctx.space` 的 `settings.json`，
  提供 `GET/PUT /api/settings`，并在自己的页面里出一个设置面板（存完调 `reload` 让新值生效）。

### 14.5 D16 的落点（配置收进 data/，profile 退役）

- **`data/host.json`**：`apps/server/src/host-settings.ts`（读侧永不抛 / 坏文件不重写 / 写侧原子）
  + `config.ts` 的"先定 dataDir 再读文件"。宿主启动即初始化：建 `data/plugins/`、没有 `host.json`
  就写默认（端口 / 日志级别 / `tabsDir` / 偏好段），旧的 `data/ui-prefs.json` 会被一次性搬进来。
- **已删**（D16）：根目录 `host.config.json`、`ui-prefs.ts`、`host-globals.ts`；
  `PUT /api/ui` 只认偏好段的 `tabOrder` / `home` / `tabAliases` / `homeLabel` / `globals`
  （`following` 随 D19 删了；`disabled` 由启停端点单独写，见 D21），
  设置页不会连带改掉端口等部署段。
- **已落地（Step 2）**：`tabs/<id>/` 放**编译完的产物**（源码与构建留在 `plugins/*`，
  `scripts/pack-tab.mjs` 直接输出到 `tabs/<id>/`）；`tabs/` **不入库**（D17），`verify` 补了
  `tabs-sync` 步（结构性检查，见 §4.1）。
- **已落地（打包，D18）**：`dist/` 收成完整结构 —— `app/server.mjs`（去 sourcemap）+ `app/web/` +
  `tabs/`（`scripts/build-dist.mjs` 拷贝）+ `data/`（空）；产物态 `repoRoot = dist/`。
  `docker-compose.yml` **平铺挂载**（`./app`→`/app:ro`、`./tabs`→`/tabs:ro`、`./data`→`/data` 可写，
  `REPO_ROOT=/`），所以 `/data` 是唯一的写入点。
- **已落地（Step 3，D19）**：`profiles/`、Include 装配、`apps/server/scripts/plugin.mjs`、清单落盘、
  契约 patch 层、`fallback`/`following`、`SchemaForm.vue`、`PUT /api/plugins/:id/config` 全删；
  示例 `tabs/hello/` 也删了（骨架并进 `tabs/README.md`）；`plugins/README.md` 是新的插件编写入口；
  宿主 `dev` 的 `--exclude` 改成 `.cordis/data/dist/tabs/web`（loader 现在把 `resolve.mjs` 写在
  **仓库根**的 `.cordis/` 下，不排除还是活锁）。
- **已落地（扫描时机，D20）**：删掉 `fs.watch` 与 2s 指纹轮询，`TabsService` 只剩
  `scan()`（只读目录，无副作用）与 `rescan()`（增量重挂）；入口只有启动装配与
  `POST /api/tabs/rescan`；外壳在设置页与欢迎页各放一个「重新扫描插件目录」按钮，
  按 `added`/`reloaded`/`removed`/`failed` 分项回报。实测：放进一个新目录后**不点按钮不会出现**，
  点了才 `added`；改产物后重扫报 `reloaded`，删目录后报 `removed`。
- **已落地（启停落盘，D21）**：`data/host.json` 加 `disabled: []`；`PUT /api/plugins/:id/enabled`
  先原子写盘、再改运行期状态（停用走 `loader.update`，启用走整格重挂），写不进去就报 500 而**不**
  假装成功；装载时由 `tabs.ts` 读盘决定 disabled。清单的 `enabled` 报**当前事实**（Loader 行优先），
  避免"刚启用却还显示停用"的窗口。

其余实施细节（每条功能的落地过程、验收证据）见
[`docs/archive/v2-implementation-notes.md`](./archive/v2-implementation-notes.md)。

---

## 附：参照工程的关键坐标

| 事实 | 位置 |
|---|---|
| cordis 五概念 / 分发模式 / waterfall 语义 | `/app/deepseek-harness/docs/cordis-primer.zh.md` |
| Loader EntryTree API | `/app/deepseek-harness/vendor/loader/README.md` |
| Include：YAML ↔ Loader entries（含写回） | `/app/deepseek-harness/vendor/include/README.md` |
| 插件包 / `dsh plugin add` / 层序 | `/app/deepseek-harness/docs/user/develop/basic/publish.zh.md` |
| 上游包名与版本对照表 | `/app/deepseek-harness/vendor/README.md` |
| `inject` 只有必需依赖（无 optional） | `/app/deepseek-harness/vendor/cordis/src/registry.ts` |
| 全栈插件契约（slots / capabilities / config / db 角色） | `/workspace/bbs/core/src/plugin.ts` |
| 装配分 Pass 校验（fail-fast 模型） | `/workspace/bbs/core/src/createServer.ts` |
