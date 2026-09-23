# 快速上手

本仓就是**一套当前系统**：一个后端（宿主 + 插件）、一个前端（外壳 + tab）。
没有 v1/v2 之分，只有"哪些东西还没搬完"这个临时状态。

```bash
pnpm install

# 开发态：一条命令起整套热更新栈（后端 node --watch-path + 外壳 vite dev + 插件 build --watch）
scripts/dev-stack.sh 8087 5173

# 或者手动分开起：
#   注意后端 dev 用的是 `node --watch-path=src`，**不是 `tsx watch`**：
#   cordis 的 loader 每次启动都会重写 profiles/<name>/.cordis/resolve.mjs（内容其实恒定），
#   tsx watch 盯整个仓库 → 写文件又触发重启 → 无限重启循环，服务只在 1 秒的窗口里可达。
#   `--watch-path` 只盯源码目录，从根上避开这类"自己写自己看"的坑。
pnpm dev:host                # 后端宿主，8087（node --watch-path，改 src/ 自动重启）
COMFYUI_WEB_DEV_PORT=5173 pnpm dev:web   # 前端外壳（vite，把 /api 与 /plugins 代理到后端）

# 生产态：构建 + 单进程
pnpm build                   # → dist/host/host.mjs + dist/host/web/
node dist/host/host.mjs      # 一个进程同时提供 API 与前端
```

打开 <http://127.0.0.1:8087>（或开发态的 5175）。宿主**自己不含任何业务功能**：
没装插件时只有一个欢迎页和设置页。

> **8086 那个旧服务（`apps/server`）已经删除**：`anima-plus` 的业务接口整体搬进了插件
> （`plugins/anima-plus/server/`，逐字搬运 + 4 处适配），反代与 `upstreamBaseUrl` 设置项都不在了。
> 旧单页前端也早就删了，它的代码现在住在 `plugins/anima-plus/client/src/`。
> 改名也已经做完：宿主目录是 `apps/server`，包名 `@comfyui-web/server`（`pnpm dev:host` 走的就是它）。

设计文档在 `docs/architecture.md`（含决策清单、契约、实施结果与验收证据）；**配置文件的分工看
`docs/config.md`**（十几个"配置"文件分别属于随包发布 / 随部署 / 随机器 / 随用户哪一层）。

---

## 装一个插件

```bash
pnpm plugin list                          # 看当前清单
pnpm plugin add ./plugins/anima-example --id anima-example   # 装（本地目录走 link:，npm 包直接写包名）
# 重启宿主 → tab 自动出现
pnpm plugin disable anima-example         # 也可以运行期在设置页切换
pnpm plugin remove anima-example          # 会问「要不要连数据一起删」（--drop-data/--keep-data）
pnpm plugin snapshot                      # 把当前清单剥掉本机部署值（config/disabled）写回 plugins.example.yml
```

**`profiles/<name>/plugins.yml` 不入库**：设置页会把本机地址之类的部署值写回它（连"跟随统一设置"
的项也存解析后的地址），所以它是"这批部署的事实"，跟 `data/` 一样当作本机状态。入库的是
`plugins.example.yml` 模板；宿主启动时清单缺失会**自动从模板复制一份**。
装完插件想让基线跟上就跑一次 `pnpm plugin snapshot`。详见 `profiles/default/README.md`。

**装插件不需要重新构建宿主。** 这是本方案的核心主张，验收口径是
`sha256(dist/host/**)` 在装插件前后逐字节一致 —— 宿主产物里既没有插件代码，
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
├── server.js      # export name / inject / apply(ctx, config)
└── client/        # 前端源码（vite 构建成 lib/client.js，或像 demo 那样手写单文件 ESM）
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
plugins/*             插件源码（宿主不 import 它们）
profiles/<name>/      profile：插件清单 + 自己的 node_modules
  plugins.yml           清单唯一真源（**不入库**，本机部署状态）；设置页会重写它，所以别写注释
  plugins.example.yml   入库的基线模板（pnpm plugin snapshot）；清单缺失时宿主从它复制
  README.md             说明写这里
data/                 运行期数据：ui-prefs.json（标签栏顺序/默认首页/统一地址）+ plugins/<包名>/（每插件自己的空间）
dist/host/            宿主产物：host.mjs + web/
host.config.json      宿主配置（端口/profile/路径）
docker-compose.yml    部署单元（挂 dist/host.config.json/profiles/plugins/data）
nginx.conf            反向代理（conf.d 片段，只有 server 块）
```

> 以上这些"配置"文件各属于哪一层（随包发布 / 随部署 / 随机器 / 随用户）、谁能改、入不入库：
> 见 **`docs/config.md`**。

## 自检

```bash
pnpm -r typecheck            # 含 v1，全绿才算没回归
pnpm plugin list          # 清单与安装状态
node apps/server/scripts/plugin.mjs --help 2>/dev/null || true
```
