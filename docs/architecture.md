# 架构设计：工作流插件化

> 状态：**讨论稿**（待用户确认）
> 上游文档：[v1-architecture](./archive/monolith-architecture.md)
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
| G2 | 宿主提供挂载点与句柄，不提供业务：前端 tab 挂载点、管理设置、后端路由挂载点、插件文件空间句柄（**不含数据库**：存储形态由插件自定，见 D12） |
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
| D3 | 内核版本 | **锁死确切版本，不用 `^`** | 上游停在 RC 期，小版本漂移会咬人。实际落地：`cordis@4.0.0-rc.10`、`@cordisjs/plugin-loader@1.0.0-rc.7`、`@cordisjs/plugin-include@1.1.0` |
| D4 | 插件来源与安装 | **npm 包 + profile 目录 + `plugin add`（转发 pnpm）** | 对齐 dsh：插件是包，profile 是清单，安装即改清单 |
| D5 | 前端装载机制 | **导入映射（import map）共享 Vue** | 宿主构建期固定输出 import map，插件 `external` 掉 `vue` / `vue-router`；宿主完全不需要知道插件是谁 |
| D6 | 元数据归属 | **包级静态事实在 `package.json`，部署事实在 `plugins.yml`** | 见 §4.2 / §6：随包发布的东西与随部署变化的东西必须分开 |
| D7 | 清单唯一真源 | **后端 Loader**，前端启动拉 `GET /api/plugins` | 避免前后端两份清单漂移（v1 已踩过 `VITE_API_TARGET` 双真源的坑） |
| D8 | 数据库（**已被 D12 取代**） | ~~共享一个 SQLite + 框架强制表前缀~~ | 原裁定；后被 D12 取代 —— 既然不存在跨插件库操作，共享库剩下的只有耦合 |
| D9 | 能力归属 | `weilin` / `comfy` / `jobs` / `quota` 全是**能力插件**，框架不含业务 | 用户裁定「高度隔离，让 weilin 成为插件依赖而不是项目」 |
| D10 | 设置渲染 | **插件 `package.json` 的 `plugin.settings[]` 自描述 JSON**，宿主按它渲染表单（**偏离**原计划） | 原计划用 schemastery 推断，但那要**执行插件代码**才能拿到 schema —— 插件导入失败时设置页就瞎了，而坏插件恰恰最需要改配置。JSON 元数据在导入失败时依然可读 |
| D11 | 交付顺序 | ① 框架本体（tab 栏 + 后端挂载点 + 设置）→ ② 极简工作流插件化安装验证 → ③ 改造 txt2img → anima-plus 插件 | 用户裁定 |
| D12 | 存储归属 | **核不提供数据库句柄**：只按**包名**在 `data/plugins/<包名>/` 下分一块唯一空间；建库、写 JSON、版本迁移、清理全是插件自己的事 | 用户裁定「不存在跨插件库操作」；落地见 §5、§9。代价：核里不再有迁移账本可查；改包名＝换空间 |
| D13 | 清单的入库形态 | **`plugins.yml` 不入库**（本机部署状态），入库 `plugins.example.yml` 模板 + profile 的 `package.json` 依赖；宿主启动时清单缺失就从模板复制（`pnpm plugin snapshot` 刷新模板） | `.gitignore` 只能整个文件忽略，而清单里的 `config` 必然含本机值（§5.7 连"跟随统一设置"也存解析后的地址），提交它 = 每次改设置都产生待提交 diff + secret（T3 明文）泄漏面。见 §6 |

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
│       ├─ 句柄服务：ctx.space（按包名的文件空间）/ ctx.routes   │
│       ├─ 清单端点：GET /api/plugins（= loader.entries() ⊕ 包 manifest）│
│       └─ 静态托管：/plugins/<id>/*（从 profile node_modules 真实路径送）│
│                                                              │
│  插件（各自独立构建，各自 npm 包）                              │
│    @comfyui-web/anima-plus   @comfyui-web/weilin   @comfyui-web/comfy   @comfyui-web/jobs …       │
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

### 4.1 包结构

```
@comfyui-web/anima-plus/
├── package.json           # 含 plugin manifest（§4.2）
├── src/
│   ├── server/index.ts    # cordis 插件：name / inject / Config / apply
│   ├── client/index.ts    # 前端入口：默认导出 { tabs, routes, settings? }
│   └── shared/            # 前后端共享的纯类型
├── migrations/            # 版本化 SQL（框架执行，见 §9）
├── lib/                   # 构建产物（server.js / client.js / client.css）
└── index.html?            # 不需要；前端只有入口，无独立壳
```

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

形状与 dsh 的插件完全一致（取自 `packages/acp/acp/src/index.ts`）：

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

**可选依赖**（例如「装了 weilin 就用」）——注意本版本 cordis 的 `inject` **只有必需依赖**，没有 `optional` 语法（已核对 `vendor/cordis/src/registry.ts`）：

```ts
const weilin = ctx.get('weilin', false)   // strict=false → 缺失返回 undefined
```

### 4.4 前端入口

**默认导出**一个纯数据对象，宿主负责挂载：

```ts
export default {
  tabs: [{ id: 'anima-plus', title: 'Anima Plus', order: 10 }],
  routes: [{ path: '', component: MainView }, { path: 'history', component: HistoryView }],
  settings: { default: SettingsView },   // 可选：覆盖框架的 schema→表单 默认渲染
}
```

契约要点：

- 插件**不创建 Vue app**、不碰 `createRouter`、不渲染 tab 栏——宿主是唯一 app 所有者。
- `import { ref } from 'vue'` 由 **import map** 解析到宿主那一份实例（§7.1）。
- CSS 用 `cssInjectedByJsPlugin` 让 JS 自注入，宿主不需要知道插件有几个样式文件。

### 4.5 契约版本闸门

- 插件声明 `plugin.contract: 1`；宿主不认识就**拒绝加载并在清单里报出原因**，不做兼容猜测。
- 启动校验 `peerDependencies.vue` 与宿主副本一致；不一致直接拒绝，别让它跑到运行期才炸。
- 演进策略待定（§12）。

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

- **按包名分配**，不按 profile 里的行 id：空间跟着**代码**走，行 id 只是本地别名；
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
- 插件前端产物由宿主托管在 `/plugins/<id>/*`，**从 profile 的 `node_modules` 解析真实路径后受控送出，不复制进 `dist/`**。

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

`settings` 是包 manifest 的 `plugin.settings[]` 原样带出（设置页据此渲染表单）；`config` 是该行
在 `plugins.yml` 里的配置，但**跟随统一设置的项回传成空串**（见 §5.7）；声明了 `fallback` 的字段
另外带一个 `sources`，说清这一项的值从哪来：`plugin`（插件自定）/ `host`（跟随统一设置）/
`unset`（两边都没填，用插件内置默认）。

### 5.5 外壳偏好：标签栏顺序 + 默认首页

设置页负责这两件事，偏好存 `<dataDir>/ui-prefs.json`：

```jsonc
{
  "tabOrder": ["anima-example", "anima-plus"],
  "home": "anima-plus",
  "globals": { "comfyuiBaseUrl": "" },
  "following": []
}
```

同一个文件里还住着**宿主全局设置**（`globals`）和它的跟随名单（`following`）——见 §5.7；
它们必须能在运行期改，理由和上面完全一样。

- **为什么不放 `host.config.json`**：那是部署期配置（docker 里只读挂载 `./host.config.json:ro`），
  而这两项是用户在设置页随时会改的运行期状态；`data/` 才是「本装置自己的可写状态」。
- **端点**：`GET /api/ui` / `PUT /api/ui`（宿主 core 插件提供，只负责存取与清洗）。
- **回退链在外壳**（只有它看得到实时清单）：
  - 顺序 = **过滤 + 补齐**：偏好里点过名的按偏好排在前面，其余保持清单顺序跟在后面。
    所以偏好里留着已卸载插件的 id、或漏列了几个插件，都不会让 tab 栏缺项。
  - 默认首页 = 偏好里的 id（且当前真有这个 tab、且它没坏）→ 第一个没坏的 tab →
    第一个 tab（哪怕坏了：至少把失败原因摆出来，比白屏强）→ 一个 tab 都没有就留在欢迎页。
  - 根路径 `/` 按这条链重定向；偏好不可用时，设置页会把「已回退到谁」显式写出来。
- **后端只保证三件事**：读得到、写得进、坏文件不炸。文件缺失 / 不是 JSON / 类型不对
  一律退化成默认值；写入先写 `.tmp` 再 `rename`（原子替换）；清洗规则 = 去重、丢非字符串、
  限长限条数。测试口径见 §14.1e。

### 5.6 设置

**已落地**（见 §14.1e 与 `plugins/anima-plus/README.md` 的「配置」一节）：

- 插件在 `package.json` 的 `plugin.settings[]` 里声明字段（`type/label/default/min/max/options/secret`），
  宿主读包元数据后由 `GET /api/plugins` 原样带出，设置页用 `SchemaForm.vue` 渲染；
- 保存走 `PUT /api/plugins/:id/config`，值写进 **`plugins.yml` 该行的 `config`**（不是用户覆盖层），
  宿主随即**就地重载**该插件（改地址不用重启宿主）；
- `plugin.settings[].default` 只是**表单默认值**，运行期默认值在插件自己的 `config.ts` —— 两处都要改，
  否则「设置页显示 8188、实际连别处」；
- 解析原则是**填错不许炸**：非法值回默认、越界收敛进范围，并把结论记进 `configFiles`，
  由插件自己的 `/config` 端点露出来（排障时一眼看到这次的值是从哪儿来的）。

**还没做**：插件注册自定义设置组件替换某段渲染（框架目前只有 schema 表单这一条路）。
**不做**：把插件设置写进用户覆盖层 —— 插件设置是**每台部署一份**（地址、并发、缓存），
用户偏好（tab 排序、默认首页）才是每人一份，走 `data/ui-prefs.json`（§5.5）。

### 5.7 宿主全局设置：统一 ComfyUI 地址（插件可选跟随）

一台装置上多个插件连的往往是同一个 ComfyUI。与其在每张插件卡片里各填一遍，不如让设置页提供
**一个统一地址**，每个插件自己决定"跟随统一 / 自定"：

```jsonc
// <dataDir>/ui-prefs.json
{
  "tabOrder": ["anima-example", "anima-plus"],
  "home": "anima-plus",
  "globals": { "comfyuiBaseUrl": "http://10.2.3.22:8188" },
  "following": ["anima-plus"]      // 谁在跟随（宿主维护；设置页里它们显示成留空）
}
```

插件只要在 manifest 里声明"哪一项可以被兜底"：

```jsonc
{ "key": "comfyuiBaseUrl", "type": "string", "fallback": "comfyuiBaseUrl" }
```

- **设置页的语义：留空 = 跟随，填了 = 自定**（两边都留空 = 用插件自己的内置默认值）。
  这三个状态由 `GET /api/plugins` 的 `sources` 如实报出来（`host` / `plugin` / `unset`），
  设置页在每个插件卡片上写明当前是哪一个。
- **核不认识 ComfyUI**：核只实现"这一项留空时用宿主全局 `<键>`"这一条通用规则；全局项住在
  可写的 `data/ui-prefs.json`（§5.5 同一个文件，理由也一样）。以后要加"统一输出目录"之类的
  全局项，插件照这样声明即可 —— **插件代码一行都不用改**（它照旧只读自己的 config）。
- **跟随者对前端显示为留空**：宿主把统一值写进它的行配置（`plugins.yml` 里因此是解析后的地址），
  但 `GET /api/plugins` 对跟随者把这一项回传成空串。否则用户会以为是自己填的，一保存就把它
  固化成"自定"。
- **清空统一地址**：跟随名单一起清空，各行写回空值 → 插件退回内置默认值。

**为什么没用 Loader 的补丁层**（第一版就是这么做的，实测后换掉了）：cordis 的 `include` 支持
`{ id, config }` 补丁，而补丁只活在内存里、不会写进 `plugins.yml` —— "留空 = 跟随"本来可以原样
留在文件里。但实测两件事：

1. **改已有补丁是慢路径**：补丁内容一变（统一地址改了值），include 会重排整棵子树，这段时间
   它对别的请求也不响应；实测一次 `PUT /api/ui` 超过 25 秒（第一次加补丁只要 1.6 秒）。
2. **补丁盖着的键写不进文件**：用户给这一项填自定值时，写入会被吃进补丁层 —— 运行时看着变了，
   `plugins.yml` 里什么都没留下。而"先撤补丁 → 写用户值 → 重算补丁"依赖 include 的异步应用任务
   （`ctx.loader.await()` **不等**它），实测会被"中途态"骗过：看起来已经撤了，写下去照样被吃掉。

换成"写行配置 + `following` 名单"之后，走的是插件设置本来就在用的那条路：落盘 + 就地重载，
每次 `PUT /api/ui` 都在 2 秒内返回（插件重载放后台）。**代价**：跟随者的文件里存的是解析后的
地址，不再是空的 —— "谁在跟随"由 `ui-prefs.json` 的 `following` 名单负责，设置页对跟随者照旧
显示留空（两种做法的实测记录见 §14.1h）。

**保存时序**：`PUT /api/ui` 先把偏好落盘（含 `following`），再**后台**把新值写进跟随者的行
（写一行会重载一个插件；anima-plus 激活要枚举模型/查依赖，不能阻塞响应）；
`PUT /api/plugins/:id/config` 则当场写完并重载那一个插件。客户端不带 `following` 时沿用现值 ——
只传 `tabOrder/home/globals` 的调用方不该把跟随名单清空。

---

## 6. 清单与配置分层

```
插件包 plugin.settings[].default（表单提示，不改运行期行为）    ← 随包发布
  → plugins.yml 的该行 config（传给 apply(ctx, config)）    ← 部署层，也是设置页写入的地方
```

```yaml
# profiles/default/plugins.yml
- id: anima-plus
  name: '@comfyui-web/anima-plus'
  config:            # 传给插件 apply 的配置（可省）
    steps: 30
- id: weilin
  name: '@comfyui-web/weilin'
```

**这里偏离了原计划的「用户覆盖层 `data/settings.json`」**，理由：

- `plugins.yml` 由 Include 托管，宿主对它调 `loader.update` 会**写回文件**，天然就是
  「设置页的持久化落点」。再叠一层用户覆盖层，就要自己实现「合并 → 写回 → 路由到正确的层」，
  而 Include 的 patch 层只解决「谁拥有这个 key」，不负责把用户改动落盘。
- 单层让**唯一真源**成立：文件里看到的就是插件拿到的，没有隐式合并，排障不用猜。
- 插件升级不丢配置：`plugins.yml` 是独立文件，插件包升级/重装都不动它。

代价与约束（必须写进文档）：

- **`plugins.yml` 里不要写注释**，Include 重写文件会丢注释；说明放 `profiles/<name>/README.md`。
- 运行期默认值以**插件代码**为准（`config.steps ?? 30`）；`plugin.settings[].default` 只是表单占位提示。

### 6.1 清单本身也不入库（D13）

上面那套分层把"随包发布"和"随部署变化"分开了，但**没解决"随机器变化"**：`config` 段就是每台机器
一份的部署值（地址、并发、缓存），设置页写它，§5.7 的"跟随统一设置"还写**解析后的地址**。
也就是说 `plugins.yml` 天然长着一张"这批部署的事实"的脸，而不是可以跟别人合并的源码。

落地的形态：

```
profiles/<name>/plugins.example.yml   入库：基线（id/name），`pnpm plugin snapshot` 生成
profiles/<name>/package.json          入库：插件集（依赖 + link:）
profiles/<name>/plugins.yml           不入库：本机部署状态（Include 托管，设置页写）
```

- `.gitignore` 忽略 `/profiles/*/plugins.yml`；宿主启动时清单缺失就从模板复制一份
  （`apps/server/src/index.ts`，profile 目录本来就在那里 `mkdirSync`）。
  **bootstrap 是必需的**：Include 拿到不存在的文件会抛 `ConfigFileError` 让宿主起不来，
  所以"只写 ignore"会让新克隆起不来。
- 模板的刷新是显式动作：`pnpm plugin snapshot` 读 live 清单、剥掉 `config` / `disabled`
  （`disabled` 也是这批部署的启停状态）写回模板。**不自动同步**，因为"这个插件从今天起是基线的一部分"
  是个需要人确认的判断。

**为什么不只忽略 `config` 段**：`.gitignore` 只能按文件/目录匹配，忽略不了 YAML 的某个字段。
要么整文件不入库，要么把值挪进第二个文件 —— 后者就是把 T2 砍掉的覆盖层再请回来（§5.7 已实测
补丁层的两个问题：改一次 >25s、且写不进文件）。

**为什么不继续提交 `plugins.yml`**：它是唯一真源（D7），而真源里必然有本机值。提交它意味着
每次在设置页改地址都留下一个待提交 diff，且行里一旦出现 secret（T3 是明文落盘）就是泄漏。

**代价**：某台机器上 enable/disable、额外装的插件不再进 git。补偿：插件集有 `package.json` 的依赖
这半份基线，行基线有 `plugins.example.yml`，而"这批部署怎么配的"本来就该在本机看。

**止血选项**（不想动结构时）：`git update-index --skip-worktree profiles/default/plugins.yml`。
纯本机技巧：上游改这个文件时 `git pull` 会报 "local changes would be overwritten"，且新克隆没有这层保护。

其余规则不变：

- 按 **row id** 定位；保存时**替换整段 config、不深合并**（cordis patch 语义，与 dsh 一致）。
- 保存配置会**就地重载**该插件（`loader.update` → fiber 重建 → 立即生效，不用重启）。
- `disable` / `enable` 走 `loader.update`，**运行期即生效，不用重启**；`add` / `remove` 需要重启后端 + 刷新浏览器。这层差别在 CLI 与设置页里都写明了。

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
| `@comfyui-web/weilin` | 标签库 / LoRA 浏览 / 缩略图（v1 `weilin/` 升格） | `inject: ['weilin']`（必需）或 `ctx.get('weilin', false)`（可选） |
| `@comfyui-web/comfy` | ComfyUI 连接 + **全局并发闸门** + input/output 胶水（v1 `comfy/` 升格） | `inject: ['comfy']` |
| `@comfyui-web/jobs` | 任务状态机 + 进度事件（后端） | `inject: ['jobs']`；**前端协议由插件自己消费**（N3） |
| `@comfyui-web/quota` | 跨插件共享配额与护栏（v1 `safety/quota.ts` 升格） | `inject: ['quota']` |

### 为什么并发与配额必须共享

隔离做到底会撞上硬事实：**共享的是一块 GPU + 一个 ComfyUI 实例**。

| 冲突点 | 各自为政的后果 |
|---|---|
| WS 连接数 / 队列深度 | 每插件一条 → ComfyUI 侧连接爆炸、队列不可观测 |
| 并发提交 | 两个 tab 同时提交 → GPU OOM（v1 `safety/quota.ts` 就是为此存在） |
| ComfyUI `input`/`output` 目录 | 每插件各写一套上传/取图胶水 |

做成能力插件而非框架内置，既满足 G4 的隔离诉求，又不必重造这些轮子。

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
2. **插件之间只走 HTTP 路由**：能力插件（`comfy`/`jobs`/…）对外暴露路由，别人调它的 API，
   而不是去读它的库文件。现在连"越权查表"那条路都没有了 —— 库文件是各自的。
3. **卸载语义**：删数据 = 删掉整个空间目录（`plugin remove` 询问；`--drop-data` / `--keep-data`
   可显式指定，非 TTY 默认保留）。见 T4。

---

## 10. 目录结构

```
comfyui-web/
├── apps/
│   ├── server/              宿主后端（cordis Loader + 句柄 + 清单端点）
│   │   └── src/
│   │       ├── kernel/      Loader 引导、Include 装配
│   │       ├── handles/     db / buffer / routes
│   │       └── core-plugin/ 内置 core 插件（提供 /api/plugins、/api/ui、/plugins/* 托管）
│   └── web/                 宿主前端（Vue 壳 + tab 栏 + 设置页 + import map）
├── packages/
│   └── contract/            插件契约的类型包（纯类型，供插件 peerDep）
├── profiles/
│   └── default/
│       ├── package.json     插件依赖（pnpm 管理）+ profile manifest（入库，插件集基线）
│       ├── pnpm-workspace.yaml  含 storeDir（防 HOME 只读，见下）
│       ├── plugins.example.yml  清单模板（入库，D13；`pnpm plugin snapshot` 生成）
│       └── plugins.yml      清单（Include 托管；**不入库**，本机部署状态）
├── plugins/                 ← 开发态的插件源码（构建/发布后进 profile 的 node_modules）
├── data/
│   ├── ui-prefs.json        外壳偏好：标签栏顺序 + 默认首页（设置页写，坏了就退默认）
│   └── plugins/<包名>/       ← 核按包名给每个插件分的空间（D12）
│       ├── @comfyui-web+anima-example/{anima-example.sqlite,images/}
│       └── @comfyui-web+anima-plus/{anima-plus.sqlite,cache/loras-thumbs/}
│
│   （旧服务的 data/comfyui-server.db、根 config.json、根 templates/、workflow/
│     都已删除：预设迁进了插件空间，模板进了插件资产，其余没有读者）
├── dist/                    宿主构建产物：server.mjs + web/（**不含任何插件**）
├── v1/                      v1 历史文档
└── v2/                      本目录
```

> **环境坑（提前记下）**：仓库 `pnpm-workspace.yaml` 已有 `storeDir: .pnpm-store`，原因是本环境 HOME 只读。**profile 目录里跑 pnpm 会用到默认 store，同样会炸**——profile 侧也必须显式指 `storeDir`。

---

## 11. 交付计划

### 第 1 步：框架本体（**零业务插件**）

产物：

- `apps/server`：Loader + Include 吃 `plugins.yml`、两个句柄、core 插件提供 `GET /api/plugins`、`GET/PUT /api/ui`（外壳偏好）与 `/plugins/*` 托管
  （原名 `apps/host-server`，2026-09 旧服务删除后完成改名；包名同步为 `@comfyui-web/server`）
- `apps/web`：Vue 壳 + import map + tab 栏（纯清单驱动）+ 设置页（schema→表单）
- 插件 CLI：`plugin add / remove / list / enable / disable`

**验收标准**：把一个插件目录 `plugin add` 进来、重启，tab 就出现了——而宿主的构建产物**一个字节都没变**（可用构建前后 `sha256` 对比证明）。

### 第 2 步：极简工作流插件化安装（**已落地**，见 §14.1c）

用户提供一个极简工作流，把它做成 `@comfyui-web/<name>` 插件，验证：`plugin add` → 重启 → tab 出现 → 路由通 → 一张表建起来 → 一个临时文件落进 `tmp`。

实际落地的是 `workflow/anima.simple.json`（11 个原生节点；该目录后来随旧服务一起删了，
插件自带副本 `plugins/anima-example/workflow.json`）→ `@comfyui-web/anima-example`（tab 名「默认Anima」），
并且走完了整条链路：插件自己提交 ComfyUI、收 WS 进度、下载产出图、写自己的表，**不反代任何旧服务**。

### 第 3 步：改造 txt2img → anima-plus

把 v1 的 txt2img（模板渲染 + 预设 + 进度 + 图库 + weilin 依赖）整体迁成 `@comfyui-web/anima-plus` + `@comfyui-web/weilin`。

---

## 12. 待定项与风险

| # | 项 | 结论 / 现状 |
|---|---|---|
| T1 | profile 位置 | **`profiles/`**（与 `data/` 并列）；profile 是独立 pnpm workspace，`storeDir: ../../.pnpm-store` |
| T2 | 用户覆盖层存储 | **取消独立用户层**，设置页直接写 `plugins.yml`（理由与代价见 §6） |
| T3 | secret 落盘形式 | **明文 + 文件权限 + API 脱敏 + 保存时占位符语义**；不做加密 |
| T4 | 卸载语义 | **询问用户是否删数据**（`plugin remove` 交互询问；`--drop-data` / `--keep-data` 可显式指定，非 TTY 默认保留）。D12 之后"删数据"就是删 `data/plugins/<包名>/` 这一个目录 |
| T5 | 契约版本演进策略 | **拒绝加载**：挂载前做契约闸门，用 Include 的 patch 层把不匹配的行 `disabled`，**不改文件** |
| T6 | jobs 的前端进度协议 | 保持「不做统一协议」；tab 栏不显示全局任务状态 |
| R1 | cordis 上游是 RC | 已锁死版本（D3）；暂不 vendor |
| R2 | 前端装载的调试链路 | 已落地：坏插件**占一个 tab 并显示原因**（`error` 字段贯穿 `/api/plugins` → tab 栏 → `/w/<id>` 兜底页） |
| R3 | 单文件产物的退化 | 已落地：宿主 = `dist/host/host.mjs` + `dist/host/web/`；插件前端由宿主从包目录**直送**，不进 dist |

---

## 13. 与 v1 的迁移映射

| v1 资产 | v2 归属 |
|---|---|
| `apps/server/src/comfy/` | 计划：能力插件 `@comfyui-web/comfy`；**实际**：先搬进 `anima-plus/server/comfy/`（见 §14.1d） |
| `apps/server/src/weilin/` | 计划：能力插件 `@comfyui-web/weilin`；**实际**：先搬进 `anima-plus/server/weilin/` |
| `apps/server/src/jobs/manager.ts` | 计划：能力插件 `@comfyui-web/jobs`；**实际**：先搬进 `anima-plus/server/jobs/` |
| `apps/server/src/safety/quota.ts` | 计划：能力插件 `@comfyui-web/quota`；**实际**：先搬进 `anima-plus/server/safety/` |
| `apps/server/src/store/db.ts` | **没有对应物**：核不再提供数据库句柄，各插件在自己的空间里自建（见 §9） |
| `apps/server/src/store/presets.ts` | 进 `@comfyui-web/anima-plus`（插件私有表） |
| `apps/server/src/templates/` | 进各插件（模板是插件私有资产，不再是全局数据目录） |
| `apps/server/src/http/routes.ts` | 拆到各插件；宿主只留清单端点与托管 |
| `apps/web/src/components/` | 进各插件；宿主只留壳 + tab 栏 + 设置页 |
| `config.json` | 拆成：宿主段（端口/路径/日志）+ `plugins.yml`（部署）+ 用户覆盖层 |

## 14. 第一步实施结果（已落地）

**交付物**（v1 的 `apps/server` 与 8086 端口已删除，只剩宿主一个后端；v2 全部是新包）：

| 位置 | 内容 |
|---|---|
| `apps/server/` | 宿主后端：`config.ts` 配置、`kernel.ts` 装配、`core-plugin.ts` 宿主端点、`ui-prefs.ts` 外壳偏好存取、`handles/{space,routes}.ts` 两个句柄、`plugin-package.ts` 包清单解析、`scripts/{build,plugin}.mjs` |
| `apps/web/` | 宿主前端：`index.html`（import map 是核心）、`src/main.ts` 插件装载器、`App.vue` tab 栏壳、`views/SettingsView.vue` + `components/SchemaForm.vue` |
| `profiles/default/` | profile：`plugins.yml`（不入库）+ `plugins.example.yml` 模板 + 独立 pnpm workspace + README（D13） |
| `plugins/anima-plus/` | **v1 整体搬完**：前端是 v1 的 `App.vue` + 8 个组件，后端是 v1 那 14 个模块逐字搬进 `server/`（模板/渲染/显存护栏/任务编排/LoRA/标签/预设），反代已删；另加依赖检查（`server/deps.ts`，见 §14.1f）。见 §14.1d 与 `plugins/anima-plus/README.md` |
| `host.config.json` | 宿主配置（端口 8087、profile） |

### 14.1 三处实施期偏离（都要记住）

1. **设置渲染不用 schemastery，改用 `plugin.settings[]` 静态 JSON**（D10）。
   原方案要执行插件代码才能拿到 schema；插件导入失败时设置页会瞎，而坏插件恰恰最需要改配置。
2. **取消独立的用户设置层**，设置页直接写 `plugins.yml`（T2，理由见 §6）。
3. **路由挂载点不是 fastify 的 `register`，而是可逆的分发表**。
   fastify 路由表在 `ready()` 之后冻结：既不能撤销也不能重复注册同一前缀。而本方案要求
   「改配置就地重载」和「运行期停用立即断流」，所以宿主只在启动时向 fastify 注册**一条**
   `/api/p/*` 兜底路由，运行期增删全是内存操作。插件拿到的是一个极小的路由门面
   （`get/post/put/patch/delete/all`，支持 `:param` 与 `*rest` ——
   透明反代要靠 `*rest` 接住任意深度的子路径）。

### 14.1b v1 界面搬进 tab（前端先行，已落地；后端后来也补齐了，见 §14.1d）

`plugins/anima-plus/` 把 v1 的单页搬成了 v2 的一个 tab，**接口暂时仍打 v1 后端**：

- 前端：v1 的 `App.vue` + 6 个组件 + `form.ts`/`presets.ts`/`clone.ts` 原样复制，
  只改了 3 处（API 前缀、两处图片 URL）。`@/` 别名指向插件自己的 `client/src`，
  所以复制过来的文件**一行 import 都没改**。
- 后端（**当时**）：插件做**透明反代**（`/api/p/anima-plus/api/*` → 8086），而不是让浏览器跨源 ——
  那要给 v1 加 CORS，与「v1 一行不改」冲突；反代还让 dev/prod 行为一致。
  反代已随 §14.1d 整体删除，这段保留的是「前端先行」那一步的做法与理由。
- 实测：GET/POST/DELETE、查询串、二进制图片（sha256 与直连一致）、
  SSE（`text/event-stream` + chunked + snapshot 首帧）全部通过。
- 一个容易漏的点：v1 回传的图片地址是**它自己的绝对路径**（`/api/assets/...`），
  搬到插件后必须改写到反代前缀下，否则会打到宿主源上 404。
  这个改写收在 `api.ts` 一层，并且 SSE 那条入口（绕开 api 层）也要单独过一遍。
- v1 的全局 `style.css` 收敛到 `.cw-anima-plus` 作用域，否则会改掉宿主外壳的主题。

### 14.1c 第一个「真」插件：anima-example（已落地）

`workflow/anima.simple.json`（11 个原生节点，不依赖任何自定义节点包；原目录已删，
插件自带 `workflow.json`）被做成了 `@comfyui-web/anima-example`，tab 名「默认Anima」。与 anima-plus 的本质区别：
**后端逻辑住在插件里** —— 没有反代，也不依赖 8086 那个旧服务。

- **绑定不写死节点号**：表单字段 → 节点的映射全部由 `class_type` + 连线推导
  （正/负向提示词顺着 `KSampler.positive`/`negative` 找上游、宽高顺着 `latent_image`
  找到 `EmptyLatentImage`、LoRA 顺着 `model` 找）。在 ComfyUI 里拖动节点或重新导出都不会失效；
  `GET /options` 会把推导结果一起回传，排障时一眼能看出哪根线接错了。
- **下拉选项取自 ComfyUI 自己的 `/object_info`**（缓存 60 秒），不写死枚举；
  服务端按同一份列表校验，越界或不在枚举里的值直接 400，不打到 GPU 上。
- **两个句柄全用上**：`ctx.routes`（9 条路由，含 SSE）、`ctx.space`
  （`data/plugins/@comfyui-web+anima-example/` 一个目录装下全部：`anima-example.sqlite`
  里的 `jobs` / `assets` 两张表 + `images/<jobId>/<idx>.png`）。
- **存储自管**：`node:sqlite` 直接开在空间里，schema 版本用 `PRAGMA user_version`，
  迁移数组写在插件里（核不再有账本与表前缀）。库里存的是**相对空间根**的图片路径，
  空间整体搬走也不失效；两张表之间可以用**真外键**（`ON DELETE CASCADE`）。
- **提示词拆分与拼接**：正向文本拆成「描述提示词（主输入框）+ 正向提示词（质量/风格串，折叠）」，
  在**后端** `joinPrompt()` 里拼成 `描述词, 正向词` 再写进正向 `CLIPTextEncode`
  （顺带清掉两侧空格与逗号 —— 工作流自带的文本末尾就有一个逗号）；前端按同一套规则做预览。
  库里两段分开存，历史记录能分别回填（D12 清库重建，所以 v1 建表就带上了这两列）。
- **带安全护栏**（`server.js` 末尾的 `SAFETY` + `assertGraphSafe()`）：步数 1~32、宽高 64~1216，
  另外 CFG 0~30、批量 1~8、提示词 ≤8000 字符。三道闸叠加：请求越界直接 **400 且不夹紧**、
  `plugins.yml` 里配的默认值超界**收敛并记日志**（否则「不传参数」就绕过上限）、
  提交前**照图再查一遍**（拦得住模板自带的数值与以后改坏的绑定）。上下限随 `GET /options`
  一起下发，前端输入框的 `min`/`max` 直接绑上 —— 参考实现抄走的不该是一个能把 200 步 /
  4096² 打到 GPU 上的裸奔版本。见 `plugins/anima-example/README.md`「安全护栏」。**上下限由每个插件自定**（核不管业务）：
  边长两边都是 1216；步数 example 32，anima-plus 24 —— 后者是多 LoRA 叠加、Turbo 6 步出图，
  步数窗口本该更窄，前者直接跑原生工作流所以留宽。
- **零运行时依赖**：`server.js` 只 import node 内置模块，WebSocket 用 node 自带的全局
  `WebSocket`；插件不 import cordis（宿主已经打了一份进去，插件再引一份就是两个实例）。
- 实测证据（无头环境）：
  - 真跑两张图（832×1216 / 6 步，33 秒；512×512 / 4 步，14 秒），状态迁移
    `queued → running → succeeded` 与节点序列 `54 → 56 → 27 → 21` 全部正确；
  - SSE 事件序列完整：
    `snapshot → node(56) → progress(1/4、3/4、4/4) → node(27) → node(21) → node(null) → completed`；
    已终态作业的 SSE 发完 snapshot 即关闭（前端收到终态必须自己 `close()`，
    否则 `EventSource` 自动重连会变成死循环）；
  - 落盘图片与 ComfyUI `/view` 的**原图逐字节一致**（`cmp` 无差异，1 449 409 字节），
    经 `/api/p/anima-example/assets/...` 取回同样逐字节一致（插件不做二次编码）；
  - 存储落在插件自己的空间里：`data/plugins/@comfyui-web+anima-example/{anima-example.sqlite,images/}`，
    无表前缀，`PRAGMA user_version = 1`，`assets` 对 `jobs` 的外键级联删实测生效。
- 无浏览器环境下的替代验证：`plugins/anima-example/scripts/contract-test.mjs` 真的
  `import()` 构建产物（补一个最小 document 桩），断言 `default.tabs` / `default.routes`
  形状与样式注入；外加模块图检查（每个模块的静态 import 都必须能落到 import map 上，
  这正是当初白屏事故的成因）。

### 14.1d 8086 旧服务整体搬进 anima-plus（已落地，旧服务已删除）

`apps/server`（4852 行）的**业务**整体搬进 `plugins/anima-plus/server/`，
旧目录连同 8086 端口、`config.json` 的读取者、`upstreamBaseUrl` 设置项一起消失。

搬法是**逐字搬运，不重写**：14 个模块原样复制（`comfy/` `templates/` `safety/` `jobs/`
`weilin/` `store/` `errors.ts` `http/routes.ts`），只做 4 处适配：

1. `store/db.ts` **零改动** —— 它本来就只接受一个文件路径，传 `space.resolve('anima-plus.sqlite')` 即可；
2. `comfy/real.ts` **零改动** —— 仍用 `ws` 包（esbuild 打进产物）；
3. `http/routes.ts` **加 1 行** `reply.hijack()` —— 宿主只用一条 `/api/p/*` 兜底路由接住所有插件请求，
   SSE 必须显式接管响应；
4. **错误映射搬到适配层** —— 旧服务在 fastify 的 `setErrorHandler` 里把 `AppError` 映射成
   404/413/422/429/502/503，插件不能碰宿主全局错误处理。`server/index.ts` 因此造了一个
   "假 fastify"包住每个 handler，顺便把 `app.get<{Params…}>` 的泛型吃掉，
   所以那 462 行的路由表**一行未改**。

不搬的：`comfy/mock.ts`（旧服务的测试替身）、`index.ts`（组装根，由插件 `apply()` 取代）、
`config.ts`（355 行进程级配置 → 插件只留 5 个设置项：地址 / 并发 / 历史保留 / 依赖检查预热与缓存）、
`scripts/smoke.ts`（随服务删除）。

为了让"逐字搬运"成立，插件后端改为 **esbuild 打包**（`scripts/build-server.mjs` → `lib/server.js`）：
anima-example 那种"直接跑 server.js"的写法在 2800 行 / 14 个文件面前不划算 ——
打包后这些文件保持 `.ts` + `.js` 后缀相对导入的原状，一行都不用改。

**验收证据**（无头环境，真 ComfyUI）：

- 真跑一张图：`POST /api/p/anima-plus/api/jobs`（512×512 / 4 步）→ 12 秒 succeeded，
  产物 WebP 512×512 / 42 366 字节，`/api/assets/:id/raw` 与 `/thumb` 都是 200；
- 21 条路由逐条实测 200：`system/health`、`templates{,/:id}`、`models`、`loras/{browse,meta,thumb}`、
  `tags/{groups,tags,autocomplete,translate}`、`presets{list,put,delete}`、
  `jobs{post,get,list,delete,cancel,events}`、`assets/{raw,thumb}`、`system/{stats,queue}`；
- 错误路径形状与旧服务一致：模板不存在 404、`steps=999` → 422「不能大于 24」、
  `width=99999` → 422、`LoRA×9` → 422「最多 8 个」、空 body 400；
- SSE：终态任务连上即发 snapshot 就关闭；运行中任务实时推 `node`/`progress`；
- 用户预设无损搬迁：旧库 `data/comfyui-server.db` 里那 3 条（1 条正向提示词 + 2 条宽高对）
  经**插件自己的 API** 写进 `data/plugins/@comfyui-web+anima-plus/anima-plus.sqlite`，
  `GET /api/presets` 逐条对上；
- 新自检 37/37：`pnpm --filter @comfyui-web/anima-plus smoke`（纯函数级，不需要 ComfyUI）。

**已知偏离与代价**：

- §13 表里"能力插件"的拆法**没有做**：核只提供 `routes` / `space` 两个句柄，跨插件服务注入
  没有契约，硬拆要改宿主内核（属于新设计）。模块目录按旧服务原样保留，将来可机械提取。
- 前端 `API_BASE` 保持 `'/api/p/anima-plus'` **不动** —— 插件内部仍注册 `/api/*`，
  完整路径与 v1 逐字一致，所以 `api.ts` 一行没改（早期文档里"改成空串"的说法是错的）。
- 任务列表仍在内存里（与旧服务一致，重启丢历史）；缩略图后来换成纯 JS 编解码（§14.1g），`sharp` 依旧不装。
- `data/comfyui-server.db`、根 `templates/`、`workflow/`、`config.json` 现在是**遗产**：
  没有程序再读它们（模板在 `plugins/anima-plus/assets/templates/` 有一份），
  保留是为了留住原始来源；确认无用后可以删。

### 14.1e 设置页接管标签栏顺序与默认首页（已落地）

需求原话：「设置页还要负责 tab 排序和默认首页的选定，用默认退回保证健壮性」。

- **后端只管存取**：`<dataDir>/ui-prefs.json`（`apps/server/src/ui-prefs.ts`），
  端点 `GET /api/ui` / `PUT /api/ui`。读侧**永不抛**（文件缺失 / 坏 JSON / 类型不对 → 默认值），
  写侧先写 `.tmp` 再 `rename`（原子替换）。放 data 而不是 `host.config.json`：
  后者在 docker 里是 `:ro` 只读挂载，不能当运行期状态。
- **回退链放在外壳**（只有它看得到实时清单）：顺序 = 过滤 + 补齐；
  默认首页 = 偏好 id（有效且没坏）→ 第一个没坏的 tab → 第一个 tab（坏了也给它，至少看到原因）
  → 一个都没有就留在欢迎页。根路径 `/` 按这条链重定向；顶栏顺序是**响应式**的，
  设置页改完立刻生效，不用刷新。偏好不可用时设置页会显式写出「已回退到谁」。
- **无头环境下的实测证据**（2026-09，全部为真跑）：
  - 后端 7 组：文件不存在 → 默认值；重复 id 去重、未知 id 原样保留（过滤是前端的事）；
    把文件写成 `this is not json {` 后 `GET /api/ui` 仍 **200 + 默认值**；
    类型垃圾 `{"tabOrder":[1,"","a","a",null,{"x":1},"b"],"home":42}` 被洗成
    `{"tabOrder":["a","b"],"home":null}`；body 传数组 / 空对象都不炸；
    20 次并发写之后文件仍是合法 JSON、无 `.tmp` 残留；500 字符的 id 被丢、300 条被截到 200 条。
  - 前端 12 项纯函数用例（`orderTabs` / `resolveHome`）全过，含「偏好指向已卸载插件」
    「偏好那个 tab 坏了」「全是坏的」「一个 tab 都没有」这些边界。

### 14.1f 依赖检查：缺哪个节点、出自哪个包、去哪装（已落地）

起因：「我 plus 里的 md 写了 comfy 运行此流需要哪些插件，但我不确定该如何展现它，
comfy 拥有检查是否拥有这些插件的接口吗？」答案：**核心没有"列出已装插件"的接口，
但有更准的判据** —— `GET /object_info`，它的键就是已注册的节点类（实测 2608 个 / 9.3MB / 2.1s）。

- **判据用节点类，不用"包装没装"**：装了包但 import 失败、缺 Python 依赖时**包在而节点不在**，
  查包会给假阳性。`/extensions` 只列前端 js 扩展，不能当判据。
- **出处由模板手写**（`requirements.packs[].url`），**不查 ComfyUI-Manager**：
  它的"类 → 包"推测会猜错，而且不在 Manager 上的包（WeiLin 就是）根本查不到；
  作者本来就知道自己用的是哪个仓库。写声明时用 `python_module` 校过一次，因此发现
  `AnimaLayerReplayPatcher` 出自 **Enhancer** 而不是 TeaCache、`SaveImagePlus` 出自 **Danbooru**、
  `PrimitiveFloat` 来自 `comfy_extras`（算内置）—— 这些"凭包名猜"都会猜错。
- **单一真源**：`requirements.nodes` 由 loader 从 `graph.json` 的 `class_type` 推导，
  **不接受手写**。手写那份漂过一次：模板只列 9 种、图里实际 17 种，缺的 8 种一路跑到
  ComfyUI 才报 `node type ... does not exist`。`builtin` + 各包 `provides` 必须覆盖图里
  所有类（契约测试断言），否则界面只能说"缺某节点"却说不出装谁。
- **三态**（`GET /api/deps`）：`true` 齐 / `false` 确实缺 / **`null` 没查成**（ComfyUI 不可达）。
  第三态是刻意的：把"连不上"说成"缺依赖"会把人引去装一堆本来就在的包；这种状态下**不拦提交**。
- **缓存**：object_info 约 9MB / 2s，服务端缓存 5 分钟 + 并发单飞 + `?refresh=1`；
  提交前的检查也走同一份（之前每次提交都要整份拉一遍）。
- **展现**（`client/src/components/DependencyNotice.vue`）：
  - 顶栏一个 `依赖 ✓ / 缺 N / ？` 的 pill，点开是**完整安装清单**（每个包 ✓/✗ + GitHub 地址）
    —— 这正是 `readme.md` 那份链接清单的用途，包括不在 Manager 上的包；
  - **只在出问题时自己冒红/黄条**，正常时页面零打扰；
  - 当前模板缺节点时**禁用「开始生成」**；后端 422 的 message 也直接带出处。
  - 顶栏另有**帮助**按钮：把包内 `readme.md` 的**原文**渲染出来（`GET /api/help` +
    零依赖小渲染器 `client/src/md.ts`：先转义再套标签、只放行 http(s) 链接、隐藏 HTML 注释）。
    既然"文件即真源"，`readme.md` 就必须在 `package.json` 的 `files` 里（安装态读得到）；
    读不到时面板退化成"按声明实时生成的清单"，不留白屏。
- **文档不再有两处真源**：`readme.md` 与 README 的依赖段由 `scripts/gen-deps.mjs` 从声明生成，
  契约测试校验同步（不一致就报"跑 deps:sync"）。
- **实测证据**（2026-09，无头环境）：
  - `/api/deps` → `ok:true`、8 个包全 ✓、`nodeCount=2608`，二次调用 `cached:true`（0.2s）；
  - 临时往 `graph.json` 塞一个不存在的节点并声明它出自 WeiLin → `/api/deps` 给出
    `missing:[{classType:"FakeMissingNode",pack:{name:"WeiLin",url:…}}]`、模板 `ready:false`；
    提交被拦成 **422 GRAPH_VALIDATION_FAILED**，message 为
    `依赖的节点未加载: FakeMissingNode（装 WeiLin：https://github.com/weilin9999/…）`；
    随后还原并复测 `ok:true`；
  - 17 项纯函数用例（三态 / 剪枝后精确指向 / 缓存 / refresh / 单飞 / 不谎报）全过。

### 14.1g 缩略图换成纯 JS 编解码（已落地）

**问题**：v1 的缩略图是"运行时惰性 `import('sharp')`，拿不到就原图直出"。sharp 是原生模块，
它的 `.node` 没法内联进单文件 `lib/server.js`（N1 纯 JS 交付的硬约束），所以 v2 一直靠
"在 ComfyUI 主机上跑离线脚本预缩放"这条**外部步骤**兜着 —— 部署时忘了跑，列表就退化成几百 MB。

**决定**：换成 `purejsimage`（strict TS、零运行时依赖、14 个稳定编解码器；包内那 8 个 `.wasm`
是**可选加速器**，要显式注册，我们只走纯 JS 路径）。它一次解决三件事：服务端能自己转、
离线脚本从"必须"降为可选、少一个"部署时必须记得跑"的步骤。

**策略与理由**（细节与实测见 `plugins/anima-plus/README.md` 的「缩略图」）：

1. **只在划算时转**：实测这台库里 13/14 的预览图**已经**被离线脚本缩成 20~30KB 的 WebP
   （v1 文档里"平均 3.4MB、76% PNG"是**未处理**时的状态），再转一遍纯属浪费。
   所以源 ≤128KB 且边长 ≤ 目标 ×2 就透传；真要转的是新加的 LoRA（几 MB PNG）
   和产出图（ComfyUI 的 PNG，1~2MB）—— 也就是"增长出来的那一部分"。
2. **输出 JPEG q74 而不是 WebP**：实测纯 JS 的 WebP 编码慢一倍（512px 预览 191ms vs 91ms），
   大图产物反而更大（42KB vs 30KB）。代价是无 alpha，预览图不透明、白底压平即可。
3. **不上 worker 线程**：实测 3072×2048 PNG 转码 474ms 期间，事件循环最长只阻塞 32ms
   （编解码器按行/分块处理并 `await`），宿主与出图进度不受影响，RSS 增量 14MB。
4. **失败一律回退原图**：解码失败 / 格式不支持 / 超过 24MB 上限都返回 `null`，路由回退成
   原图直出，**绝不 500** —— 缩略图是锦上添花，不能因为它让整个列表打不开。

**代价**：`lib/server.js` 从 232KB 涨到 **785KB**（打包进去约 556KB 纯 JS 编解码器），
单文件交付不变；`sharp` 仍然不装。

**验证**：`smoke` 新增 11 项（合成 PNG 跑通"转码/透传/坏字节回退"三条路径并回读产物尺寸），
`contract-test` 新增 6 项（依赖精确锁、产物里没有 `sharp`、引擎 tag 与 `image/jpeg` 真进了产物）。

### 14.2 装配期的两个关键机制（都是踩过才知道的）

- **契约闸门用 patch 层实现**：宿主在建树**之前**读一遍 `plugins.yml`，把 `contract` 不匹配的行
  用 Include 的 `patches: [{ id, disabled: true }]` 盖掉 —— 插件不会被导入，而**文件本身不动**（T5）。
- **单插件失败隔离 + 可见**：模块导入失败/激活失败不会让宿主退出，而是记进日志并在
  `/api/plugins` 的 `error` 字段里露出，前端给它一个带 `!` 的 tab。装配期信息比"安静地少一个 tab"重要得多。

### 14.3 验收证据（全部为无头环境下实测）

1. **装插件不改宿主产物**（本方案的核心主张）：
   - `sha256(dist/host/host.mjs)` 在**装/卸载、改配置、停用/启用**插件之后逐字节不变；
   - 宿主产物里没有任何插件代码：`grep -rl "cw-anima-example" dist/host/`（插件自己的 CSS 前缀）
     与 `grep -rl "@comfyui-web/anima-example\"" dist/host/` 均无命中
     （产物里唯一含 "anima" 字样的是 Vue 自身源码里的 `animate` 与 sourcemap 里的注释）。
2. **前端共享 Vue 是同一个实例**：
   - 构建产物：`grep 'from"vue"'` 命中（裸说明符保留），无任何 `/vendor/` 硬编码；
   - dev 态（vite）：`vue` 被解析成 `/vendor/vue.esm-browser.js`，**与 import map 的目标 URL 完全相同**；
   - 宿主产物 11.6 kB（Vue 没被打进去，Vue 本体 173 kB 由 `/vendor/` 提供）。
3. **插件全链路可用**：每个 tab 的 `clientUrl` 都在清单里；`/plugins/<id>/client.js` 200；
   以 `anima-example` 为例，9 条路由里 `/options`（拉 ComfyUI `/object_info`）、`POST /jobs`、
   `/jobs/:id`、SSE `/jobs/:id/events`、`/assets/:jobId/:idx`（图片字节）全部实测返回预期结果。
4. **热重载与启停**：`PUT /api/plugins/anima-example/config`（body 是 `{config:{…}}`，整份回写）
   把 `defaultSteps` 从 6 改成 8 后，插件下一次 `/options` 立刻读到 8；停用后该插件所有路由返回
   503 且原因可读（`插件 anima-example 已被停用`），重新启用后恢复。
   插件清单端点 `GET /api/plugins` 是唯一真源。

### 14.4 已知限制

- 插件前端入口**运行时动态 import**，不使用打包器的静态分析：插件 bundle 要自己保证是自包含的 ESM
  （只 external `vue` / `vue-router`）。
- `plugins.yml` 会被 Include 重写，**注释会丢**；说明写 `profiles/<name>/README.md`。
- 前端 `import(...)` 的调试栈跨包，坏插件的报错目前只到"加载失败 + 原因"这一层。
- 本仓库的开发沙箱里，跨 `bash` 调用启动的后台进程无法回收（PID namespace 限制），
  所以验证时统一用「同一次调用内启动 + kill」，或换空闲端口。

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

### 14.1h 统一 ComfyUI 地址：插件可选跟随（已落地）

**问题**：多个插件连同一个 ComfyUI，地址却要在每张卡片里各填一遍；漏填一个就是"这个插件连不上、
那个正常"。**做法**：设置页给一个统一地址（`data/ui-prefs.json`），插件在 manifest 里用
`fallback` 声明"这一项留空就跟随统一"（机制与两版取舍见 §5.7）。

真机矩阵（宿主 :8100，两个插件都声明了 `comfyuiBaseUrl` 的 fallback）：

| 步骤 | 操作 | 结果 |
| --- | --- | --- |
| A | 统一地址为空 | 两个插件 `sources=unset`，`plugins.yml` 干净 |
| B | 统一地址设为 `…:8188` | 两个插件 `sources=host`、运行期地址变 8188、`following` 记下两个 id；设置页看到的这一项仍是空的 |
| C | 给 anima-example 填 `…:9999` | 写进 `plugins.yml` 该行、`sources=plugin`、运行期 9999；anima-plus 仍 `host` |
| D | 统一地址改 `…:8288` | anima-plus 跟着变 8288；anima-example 仍是 9999（自定不被覆盖） |
| E | anima-example 清空 | 回到 `sources=host`，地址变 8288 |
| F | 统一地址清空 | 跟随名单清空、各行写回空值，运行期回到内置默认 `localhost:8188` |

`PUT /api/ui` 每次都秒回（实测 0.005–1.8 秒），写插件行（会触发重载）在后台完成。
第一版用 Loader 补丁层，被上面 §5.7 记的两个实测问题否决。
