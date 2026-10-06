# 快速上手

本仓就是**一套当前系统**：一个后端（宿主 + 插件）、一个前端（外壳 + tab）。
业务逻辑全在插件里，宿主只提供框架。

**文档地图**（别猜，按这张表找）：

| 文档 | 回答什么 |
|---|---|
| 本文 | 怎么跑起来、怎么装插件、怎么自己写一个插件、目录约定 |
| [`architecture.md`](./architecture.md) | 架构与决策（D1–D21）、插件契约（§4）、核给的句柄（§5）、配置分层（§6）、落地现状（§14） |
| [`config.md`](./config.md) | 十几个"配置"文件分别属于随包发布 / 随部署 / 随机器 / 随用户 / 随目录哪一层，谁能改，入不入库 |
| [`../tabs/README.md`](../tabs/README.md) | 目录型插件（`tabs/<id>/`）：怎么写、热到什么程度、收尾契约 |
| [`archive/`](./archive/README.md) | **历史文档**（v1 单体时代 + v2 落地过程），只作来龙去脉参考 |
| 各插件的 `README.md` | 那个插件的设置项与内部结构（`plugins/*/README.md`） |

> 约定：**过程叙事不要写进现行文档**。落地过程写进 `archive/`，现行文档只留结论与状态。

```bash
pnpm install

# 开发态：一条命令起整套热更新栈（后端 node --watch-path + 外壳 vite dev + 插件 build --watch）
scripts/dev-stack.sh 8087 5173

# 或者手动分开起（`pnpm dev:host` 已经带了下面那串 --exclude）：
#   注意 cordis 的 loader 每次启动都会写 .cordis/resolve.mjs，位置是「baseUrl 往上最近的那个
#   package.json」旁边（现在 baseUrl = tabs/，所以落在仓库根）；
#   tsx watch 盯整个仓库 → 写文件又触发重启 → 无限重启循环，服务只在 1 秒的窗口里可达，
#   所以必须 --exclude 掉它（还有 data/dist/tabs/web）。
pnpm dev:host                # 后端宿主，8087（tsx watch，改 src/ 自动重启）
pnpm dev:web                # 前端外壳（vite :5173，把 /api 与 /plugins 代理到后端）
pnpm dev:plugins            # 插件产物 watcher（改 plugins/* 源码边写边出 tabs/）

# 生产态：构建出完整可搬的 dist/
pnpm build                   # → dist/app/server.mjs + dist/app/web/ + dist/tabs/ + dist/data/
node dist/app/server.mjs     # 一个进程同时提供 API 与前端（dist/ 自成一体）
```

打开 <http://127.0.0.1:8087>（或开发态的 <http://127.0.0.1:5173>）。宿主**自己不含任何业务功能**：
没装插件时只有一个欢迎页和设置页。

> **8086 那个旧服务已经删除**：`anima-plus` 的业务接口整体搬进了插件（`plugins/anima-plus/server/`，
> 逐字搬运 + 4 处适配），反代与 `upstreamBaseUrl` 设置项都不在了。旧单页前端也早就删了，
> 它的代码现在住在 `plugins/anima-plus/client/src/`。历史文档在 [`archive/`](./archive/README.md)。

---

## 装一个插件

```bash
pnpm build:plugins            # 插件源码（plugins/<id>/）→ tabs/<id>/
# 手写 tab：直接把目录丢进 tabs/（三个文件的骨架见 tabs/README.md）
# 然后在设置页点「重新扫描插件目录」（或 POST /api/tabs/rescan）—— 宿主不监听目录，D20
```

**插件 = `tabs/<id>/`**（目录即插件，D16/D19）：没有清单、没有安装步骤、没有 `node_modules`，
宿主**唯一**的装载来源就是它。`tabs/` **不入库**（构建产物、可复现），仓库只留 `tabs/README.md`。
启停在设置页切换、**写进 `data/host.json` 的 `disabled`**（重启后仍生效）；插件配置由插件自己持有
（`data/plugins/<包名>/`）—— 宿主管部署事实，插件管自己的数据。
**放进去 / 改完要点一次「重新扫描插件目录」才生效**（宿主不监听、不轮询，D20）。
怎么从 0 写一个插件（后端两个句柄、前端 tab、构建脚本、调 ComfyUI）见 **[`plugins/README.md`](../plugins/README.md)**。

**装插件不需要重新构建宿主。** 这是本方案的核心主张，验收口径是
`sha256(dist/app/**)` 在装插件前后逐字节一致 —— 宿主产物里既没有插件代码，
也没有 Vue 本体（Vue 由 `index.html` 的 import map 提供，插件 bundle 里 `external` 掉它）。

### 现有插件

| 插件 | 说明 |
|---|---|
| `@comfyui-web/anima-example` | **第一个「真」插件**：自带 `workflow.json`（源自已删的 `workflow/anima.simple.json`）做成 tab「默认Anima」。插件自己提交 ComfyUI、收 WS 进度、落图、在自己的空间里建库，**不反代任何旧服务**。见 `plugins/anima-example/README.md` |
| `@comfyui-web/anima-plus` | **v1 整体搬完了**：页面是 v1 的，后端（模板/渲染/显存护栏/任务编排/LoRA/标签/预设）也整套搬进了插件，**不再依赖 8086**。见 `plugins/anima-plus/README.md` |

---

## 写一个插件

从 `plugins/anima-example/` 抄（现存最小的完整例子：一个 tab、一个文件空间、一个自建库、一套设置项），
契约细节见 `docs/architecture.md` §4：

```
plugins/myflow/
├── package.json   # name + plugin{ contract, title, client, settings[] }
├── server/        # 服务端源码（构建成 tabs/myflow/server.js；单文件也行，多文件必须打包）
└── client/        # 前端源码（vite 构建成 client.js）
```

后端只有一个入口 `apply(ctx, config)`，句柄按需 `inject`。**核只给文件空间**，
存储形态（SQLite？JSON？）由插件自己决定：

```js
import { DatabaseSync } from 'node:sqlite'

export const name = 'myflow'
export const inject = ['space', 'routes']   // 只声明用得到的

export function apply(ctx, config) {
  const space = ctx.space.for('@me/myflow')  // 按包名分一块 data/plugins/<包名>/
  const db = new DatabaseSync(space.resolve('myflow.sqlite'))  // 想建库就自己建
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS jobs (...)')  // 表名/版本/迁移都自己管

  const routes = ctx.routes.for('myflow')  // 实际路径 /api/p/myflow/*
  routes.get('/jobs/:id', async (request) => ({ id: request.params.id }))
}
```

前端只有一个默认导出，**不创建 app、不碰 router、不渲染 tab 栏**：

```js
import { h, ref, onMounted } from 'vue'   // 由宿主 import map 解析，与宿主同一份 Vue

export default {
  tabs: [{ id: 'myflow', title: '我的工作流', order: 10 }],
  routes: [{ path: '', component: { setup: () => () => h('div', '…') } }],
}
```

约定：**插件后端只 `import` 类型、不 `import` cordis 运行时代码**（宿主已把 cordis
打进了自己的产物）；插件前端**不要**把 `vue` / `vue-router` 打进去（`external` 掉它们）。

---

## 目录约定

```
apps/server/          宿主后端（cordis 微内核 + 文件空间/路由两个句柄 + 宿主端点）
apps/web/             宿主前端（壳 + tab 栏 + 设置页：插件开关/配置 + 标签页排序 + 默认首页；Vue 经 import map 提供）
plugins/*             插件**源码工程**（宿主不 import 它们；构建成 tabs/<id>/，D16）
tabs/<id>/            插件**交付物**（**目录名即 id**，自包含无依赖，**不入库**；见 docs/config.md §6）
tabs/README.md        仓库里 tabs/ 唯一入库的文件：目录型插件的写法
data/                 开发态的运行时数据：host.json（唯一配置文件，不存在时自动生成）+ plugins/<包名>/
dist/                 交付物（**不入库**）：app/{server.mjs,web/} + tabs/（插件拷贝）+ data/（空，运行时写入）
docker-compose.yml    部署单元（./dist/app 与 ./dist/tabs 只读挂载，./dist/data 可写；REPO_ROOT=/）
nginx.conf            反向代理（conf.d 片段，只有 server 块）
```

> 以上这些"配置"文件各属于哪一层（随包发布 / 随部署 / 随机器 / 随用户 / 随目录）、谁能改、入不入库：
> 见 **`docs/config.md`**。

## 自检

```bash
pnpm verify                  # typecheck + 构建 + 冒烟（日志与产物在 .cache/verify/）
pnpm -r typecheck
```
