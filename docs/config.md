# 配置地图

仓库里叫"配置"的文件有十来个，它们**不是一层，而是五层** —— 先认层，再找文件：

| 归属层 | 意思 | 谁改 | 在哪 |
|---|---|---|---|
| **随包发布** | 插件自带的事实：默认值、合法范围、表单字段 | 插件作者，跟版本走 | `plugins/*/package.json` 的 `plugin.settings[]`、`plugins/*/server/config.ts` |
| **随部署变化** | 这台装置怎么跑：端口、路径、默认 profile | 部署的人；宿主首次启动也会写默认值 | `data/host.json`（部署段，不存在时自动生成）、`docker-compose.yml`、`nginx.conf` |
| **随机器变化** | 这批部署装了哪些插件、各配了什么（本机状态） | 设置页 / `pnpm plugin` | `profiles/<n>/plugins.yml`（不入库）、`plugins.example.yml`、`package.json` |
| **随用户变化** | 运行期偏好：tab 顺序、默认首页、统一地址 | 设置页，随时改 | `data/host.json`（偏好段）、`data/plugins/<包名>/` |
| **随目录** | 目录型工作流插件：整个目录就是一个插件（自包含、无 `node_modules`） | 你，往 `tabs/` 丢目录 | `tabs/<id>/`（**不入库**：编译产物，见 §6）、配置与状态自持在 `data/plugins/<包名>/` |

层与层的边界是锁过的：D6（§4.2 / §6）、D13（§6.1）、§5.5 / §5.7。**不要跨层放值** ——
比如"某台机器的 ComfyUI 地址"属于随机器/随用户，放不进随包发布的 `package.json`。

## 一览

| 文件 | 谁读（代码） | 层 | 能直接手改吗 | 入库 |
|---|---|---|---|---|
| `data/host.json`（部署段） | 宿主启动：`apps/server/src/config.ts` → `loadHostConfig()` | 部署 | ✅ 改完要重启 | ❌（本机状态；不存在时宿主写默认值） |
| `docker-compose.yml` | `docker compose` | 部署 | ✅ | ✅ |
| `nginx.conf` | 外部/容器 nginx（**conf.d 片段**） | 部署 | ✅ | ✅ |
| `profiles/<n>/package.json` | pnpm + `apps/server/scripts/plugin.mjs` | 机器（插件集基线） | ⚠️ 走 `pnpm plugin add/remove` | ✅ |
| `profiles/<n>/plugins.example.yml` | 宿主启动的 bootstrap（清单缺失时） | 机器（行基线） | ⚠️ 走 `pnpm plugin snapshot` | ✅ |
| `profiles/<n>/plugins.yml` | Include（**唯一真源**）+ 设置页写 | 机器 | ✅ 但**别写注释** | ❌（D13） |
| `profiles/<n>/pnpm-workspace.yaml` | pnpm | 环境 | ✅ | ✅ |
| `pnpm-workspace.yaml`（根） | pnpm（workspace + `storeDir`） | 环境 | ✅ | ✅ |
| `data/host.json`（偏好段：`tabOrder` / `home` / `globals`） | 宿主 core 插件（`apps/server/src/host-settings.ts`）；`GET /api/ui` | 用户 | ❌ 走设置页 | ❌ |
| `data/plugins/<包名>/…` | 各插件自己（如目录型 tab 的 `settings.json`） | 用户 / 运行期 | ❌ 走插件自己的设置界面 | ❌ |
| `plugins/<pkg>/package.json` 的 `plugin.settings[]` | 宿主 → `GET /api/plugins` → 设置页表单 | 包 | ✅（改包） | ✅ |
| `plugins/<pkg>/server/config.ts` | 插件自己（运行期默认值 / 范围） | 包 | ✅（改包） | ✅ |
| `tabs/<id>/package.json` | 宿主扫描（`apps/server/src/tabs.ts` → `scanTabs()`） | 目录 | ✅ 改完等热重扫（或 `POST /api/tabs/rescan`） | ❌（产物） |
| `tabs/<id>/server.js`、`client.js` | Loader 直接 `import()` 绝对路径 → 宿主 / 浏览器 | 目录 | ✅ 存盘即**热重挂**（约 0.3~2s，前端刷新浏览器） | ❌（产物） |

---

## 1. 宿主进程：`data/host.json`（唯一配置文件）

宿主启动读一次，之后不再看文件。**文件可以不存在 —— 宿主会写一份默认的出来**，
所以挂一个空的 `data/` 卷就能起来（首次启动会建 `data/plugins/` 并生成 `host.json`）。
文件**在、但读不出来**时用内置默认值跑，并且**不覆盖它**（用户手写的错误不该被静默重置）。

唯一的例外是 `dataDir` 自己的位置：它由内置默认 `<仓库根>/data` 与
`COMFYUI_WEB_DATA_DIR` 决定（鸡生蛋 —— 它管着这个文件在哪儿），不写进文件。

**部署段与偏好段同处一个文件**（D16）：两者都必须能在运行期改，分家只会多出"这个值写哪儿"的
判断成本，还多一份能写坏的状态。会被程序重写的文件**不写注释**（`plugins.yml` 的教训，§6.1），
所以这里用纯 JSON，解释写在本文档。

| 字段 | 默认 | 作用 | 环境变量覆盖 |
|---|---|---|---|
| `host` | `0.0.0.0` | 监听地址 | — |
| `port` | `8087` | 监听端口（宿主是唯一后端） | `COMFYUI_WEB_PORT` |
| `dataDir` | `data` | 唯一可写卷：宿主配置 `host.json` + `plugins/<包名>/`（也在文件外 —— 它管着这个文件在哪儿） | `COMFYUI_WEB_DATA_DIR` |
| `profilesDir` | `profiles` | profile 根（相对路径按仓库根解析） | — |
| `profile` | `default` | 用哪个 profile → `profiles/<name>/plugins.yml` | `COMFYUI_WEB_PROFILE` |
| `tabsDir` | `tabs` | 目录型 tab 的根：每个子目录一个插件，**目录名即 id**（见 §6） | — |
| `logLevel` | `info` | pino 级别 | `COMFYUI_WEB_LOG_LEVEL` |
| `webDir` | 源码态 `<仓库根>/dist/app/web`；打包态 `<server.mjs 所在目录>/web` | 宿主前端产物目录（存在才托管） | — |

另有 `REPO_ROOT`（显式指定仓库根，测试用）与 `NODE_ENV=production`（关掉 `pino-pretty`，退回 JSON 日志）。

**产物态（D18）**：`dist/` 自成一体 —— `repoRoot` = `dist/`，于是 `tabsDir = dist/tabs`、`dataDir = dist/data`、
`webDir = dist/app/web`。整包搬走后无需任何配置；要外挂卷/端口再给 `REPO_ROOT`、`COMFYUI_WEB_DATA_DIR`。

- **优先级：环境变量 > 文件 > 内置默认**。环境变量只作**临时覆盖**（换个端口起第二个实例），不是第二份配置来源。
- **纯 JSON、不带注释**：这个文件会被程序重写（设置页保存），注释必然丢 —— `plugins.yml` 就是这么丢掉注释的（§6.1）。解释写在这里。
- **它不含任何业务配置**：没有 ComfyUI 地址、没有插件开关。插件地址在 `plugins.yml`（或跟随 `data/host.json` 的统一地址）。
- 它就在 `data/`（docker 里那唯一可写的卷）里，容器内可改；空卷首次启动时宿主会把它生成出来（D16）。

## 2. 插件集与清单：`profiles/<name>/`

- **`package.json`** —— 插件集基线：依赖即"这个 profile 装了哪些插件"（本地插件是 `link:../../plugins/x` 的**相对**路径，别写绝对路径）。`pnpm plugin add/remove` 会同时改它和清单。
  它是 profile 这个**独立 workspace 的根工程**，`name`（`@comfyui-web/profile`）只为满足 pnpm，**没有任何代码读它** —— 复制/改名 profile 目录不用同步改它。
- **`plugins.example.yml`** —— 行基线，只有 `id` / `name`（`config` / `disabled` 都是本机状态，剥掉）。由 `pnpm plugin snapshot` 从 live 清单生成；**清单缺失时宿主从这里复制一份**（`apps/server/src/index.ts`）。
- **`plugins.yml`** —— **运行时唯一真源**（D7），由 Include 托管。设置页的 `PUT /api/plugins/:id/config` 写的就是这里的 `config`，`disabled` 由设置页/CLI 切换。它是本机状态所以**不入库**（D13），而且 **`Include` 重写会丢注释 → 别在这里写注释**。字段含义见 `profiles/default/README.md`。
- profile 是**独立的 pnpm workspace**（`pnpm-workspace.yaml` 里 `storeDir: ../../.pnpm-store`）：既不冒泡到仓库根污染 lockfile，也绕开只读的 HOME。

## 3. 运行期状态：`data/`

**`data/host.json` 的偏好段**（`apps/server/src/host-settings.ts`，端点 `GET/PUT /api/ui`）：

```jsonc
{
  "tabOrder": ["anima-plus", "anima-example"],   // 标签栏顺序
  "home": "anima-plus",                          // 默认首页
  "globals": { "comfyuiBaseUrl": "http://10.0.0.5:8188" },  // 宿主全局设置
  "following": ["anima-plus"]                    // 谁在"跟随统一设置"
}
```

- 读：文件缺失 / JSON 坏掉 / 类型不对 **一律退默认，不抛**；写：先写 `.tmp` 再 `rename`（原子替换）。
- `globals` 目前只有 `comfyuiBaseUrl`（`host-globals.ts`）。**`following` 才是"谁在跟随"的真源**：设置页里该项**留空 = 跟随**，宿主把统一值写进该插件的**行配置**（所以 `plugins.yml` 里存的是解析后的地址），前端对跟随者照旧显示成空。整条链与两版取舍见 §5.7。
- **`data/plugins/<包名>/`** —— 每个插件的私有空间（SQLite、缓存、缩略图…），核不解析内容；空间按**包名**分配（`@comfyui-web+anima-plus`）。删它 = 重置该插件的运行期数据（`pnpm plugin remove --drop-data` 干的就是这件事）。

## 4. 插件自己的设置：默认值存两份

同一个设置项有两个来源，**职责不同，别混**：

1. **表单默认（随包发布）**：`plugins/<pkg>/package.json` 的 `plugin.settings[]` ——
   `key` / `type` / `label` / `description` / `default` / `min` / `max` / `step` / `options` / `secret` / `fallback`。
   宿主读包元数据后由 `GET /api/plugins` 原样带出，设置页据此渲染（D10：**不执行插件代码**也能画表单，坏插件照样能改配置）。
2. **运行期默认（随包发布）**：插件自己的 `server/config.ts`（默认值 + 合法范围 + 越界收敛）。

⚠️ **`plugin.settings[].default` 只是表单占位提示，不是运行期默认值**。两个真实例子：

- `anima-example`：表单 `defaultSteps: 6`，但**不填**时运行期取工作流里 KSampler 的实际值（`plugins/anima-example/server.js:469` 的 `bindings.current.steps`）。
- `anima-plus`：表单 `comfyuiBaseUrl` 默认 `http://localhost:8188`，运行期默认在 `plugins/anima-plus/server/config.ts` 的 `DEFAULT_COMFY_BASE_URL`。

改默认值要**两处都改**，否则会出现"设置页显示 8188、实际连别处"。

**排查"这个值现在到底从哪来"**：`GET /api/plugins` 每项的 `sources`（`host` = 跟随统一 / `plugin` = 自定义 / `unset` = 两边都没填）+ 插件自己的 `/config` 端点回显的 `configFiles`（含"越界已收敛到 N"这类结论）。

## 5. 部署

- **`docker-compose.yml`**（单服务）：挂 `dist:ro`、`profiles`（**必须可写**：宿主会重写 `profiles/<n>/.cordis/resolve.mjs`）、`plugins:ro`、`data`；`UID`/`GID`/`TZ` 走 env。`profiles` 与 `plugins` 必须保持仓库里那层**相对深度**（`link:` 指向 `../../plugins/x`）。
  **`data` 是唯一需要可写的卷**（宿主配置就住在它里面）；空卷也能起，宿主自己初始化。
- **端口在三处保持一致**：`data/host.json` 的 `port`（容器内）= `docker-compose.yml` healthcheck 里的 URL = `nginx.conf` 的 `set $backend_url http://comfyui-web:8087`。
- **`nginx.conf`**（根目录）：**conf.d 片段**，只有 `server` 块，没有 `events` / `http` 外壳 —— 不能直接 `nginx -c nginx.conf`。
  `cp nginx.conf /etc/nginx/conf.d/comfyui-web.conf && nginx -t && nginx -s reload`。
  SSE 不缓冲 / 插件产物不缓存 / `/assets/` 长缓存这三件事都注释在文件里。

## 6. 目录型 tab：`tabs/<id>/`

`tabs/` 是一类**特殊的工作流插件**：一个目录就是一个插件，**目录名即 id**，没有安装步骤，
也不需要 `profiles/`（那条链路可以整个不用）。

产物形态（D16）：`tabs/` 是**交付物**，不是源码工程 —— 有工具链的插件源码在 `plugins/<id>/`，
`pnpm build:plugins` 把它编译进 `tabs/<id>/`（入口固定 `server.js` / `client.js`）。`tabs/` **不入库**
（重建字节稳定，`verify` 的 `tabs-sync` 步只查「每个源码工程都有可装载的产物」，不比对 git）；
库里只有手写示例 `tabs/hello/`（`.gitignore`：`/tabs/*/` + `!/tabs/hello/`）。

```
tabs/hello/package.json   manifest（plugin.contract/title/order/client）+ 服务端入口 main
tabs/hello/server.js      cordis 插件：export name / inject / apply
tabs/hello/client.js      ESM 前端入口：export default { tabs, routes }（vue 走页面 import map）
```

- **和 profile 的关系**：两者是**同一个 manifest 契约的两个来源**。profile 的行写模块说明符
  （裸包名 / 相对路径），tab 的行写**服务端入口的绝对路径**；契约闸门、失败隔离、
  `GET /api/plugins`、设置页表单、前端 tab 装载全部复用，没有第二套生命周期。
  `plugins.yml` 不存在时宿主**跳过** profile 那一层，只加载 `/tabs`。
- **必须自包含**：tabs 目录下**没有** `node_modules` —— 插件只 import node 内置模块和宿主句柄
  （`ctx.routes` / `ctx.space`）。要用第三方库就先 bundle 进产物。这是"丢目录就能用"的前提，
  也顺手免掉 N 份不可复现的依赖树。
- **配置归插件自己**（D15）：`/tabs` 只回答"有哪几个 tab"，既不持有它们的配置、也不代写清单。
  值住在 `<dataDir>/plugins/<包名>/`（格式自定，如 `settings.json`），读写走插件自己的端点，
  **界面也由插件自己出**（它自己有页面）—— 宿主设置页对这类行只读（清单行上是 `configOwner: 'plugin'`），
  `PUT /api/plugins/:id/config` 对它**直接拒绝**（免得"改完没落盘、重启就丢"的假象）。
  字段的**形状**（label / 范围 / 默认值）仍在 `package.json` 的 `plugin.settings[]` 里，由宿主清单端点下发。
- **配置怎么生效**：宿主不碰它的配置，只提供 `POST /api/tabs/:id/reload`（强制重挂，指纹没变也重挂）。
  插件存完配置由自己的前端调一次它，装载时读到的新值立刻生效 —— 这比"宿主替它热改字段"可靠：
  需要重建的东西（客户端、队列上限）本来就只能在 `apply()` 里装。
  所以 **manifest 里不要给目录型 tab 写 `fallback`**：那是"宿主持有行配置并跟随统一设置"那套，
  对自持配置的 tab 没有意义（内核也不会去写它的行配置）。
- **热到什么程度**：
  - 增 / 删 / 改名**目录** → 热（`GET /api/plugins` 立刻反映，浏览器刷新即见）；
  - **改代码** → 也热：宿主发现目录指纹变了就**卸载重挂**，说明符带 `?v=<token>` 绕开 Node 的
    ESM 模块缓存（同一 URL 不重新求值，换 URL 就是新模块实例）。延迟 ≈ 0.3s（`fs.watch` 快路径）
    / 最多 2s（指纹轮询兜底 —— 实测 Linux 的递归监听会静默失聪，所以**轮询才是硬保证**）；
    `POST /api/tabs/rescan` 可手动触发。改**前端**代码后刷新浏览器即可（`/plugins/<id>/*` 不缓存）。
  - 因此插件必须把收尾写在 `ctx.effect(() => () => 收尾)` 里（关文件 / 定时器 / 在跑的任务），
    并把**要活下来的状态写进 `ctx.space`** —— 重挂 = 新 fiber，内存状态一律归零。
    示例见 `tabs/hello/server.js`（`lifecycle.log` 会留下 load/unload 成对痕迹）。
- **边界**：谁能写 `tabs/`，谁就能让宿主进程执行代码（同进程、同权限、无沙箱）。这是它
  "丢进去就能用"的代价，容器 / 文件权限是唯一边界。
- 示例：`tabs/hello/`（3 个文件、零依赖）。`tabsDir` 在 `data/host.json` 里换（默认 `tabs`，相对路径按仓库根解析）。

## 7. 常见诉求 → 改哪儿

| 想干的事 | 改哪里 |
|---|---|
| 换宿主端口 | `data/host.json` 的 `port` + `docker-compose.yml` healthcheck 的 URL + `nginx.conf` 的 upstream，然后重启 |
| 所有插件共用一个 ComfyUI 地址 | 设置页的"统一 ComfyUI 地址"（写 `data/host.json` 的偏好段，并把值灌进跟随者的行） |
| 只给某个插件单独地址 | 该插件的地址项填上 = 自定（写 `plugins.yml` 该行）；清空 = 回到跟随 |
| 加 / 删插件 | `pnpm plugin add <包>` / `pnpm plugin remove <id>` → 重启宿主；想让基线跟上再 `pnpm plugin snapshot` |
| 加一个自己的 tab | 在 `tabs/` 下建目录（照 `tabs/hello/` 抄）—— **不用装、不用改清单**；增删目录与改代码都热（见 `tabs/README.md`） |
| tab 的配置 / 数据存哪儿 | tab 插件自己写 `ctx.space`（→ `data/plugins/<包名>/`）：宿主不代管、不迁移、不清理 |
| 改目录型 tab 的设置项 | 在该插件自己的页面里改（如「设置」面板）—— 它写进自己的空间并请求宿主 `POST /api/tabs/:id/reload`；宿主设置页对这类行只读 |
| 给目录型 tab 换配置界面 | 改 `package.json` 的 `plugin.settings[]`（形状，宿主清单端点下发）+ 插件自己的表单；运行期默认与范围仍在插件自己的 `config.ts` |
| 临时换端口起第二个实例 | `COMFYUI_WEB_PORT=18087 pnpm start`（env，不改文件） |
| 换一套 profile | `COMFYUI_WEB_PROFILE=xxx`（profile 本身随 D16 退役） |
| 重置某个插件的运行期数据 | 删 `data/plugins/<包名>/`（等价于 `pnpm plugin remove --drop-data`） |
| 改插件的可配项 / 默认值 | 设置项清单与表单默认在 `plugins/<pkg>/package.json`；运行期默认与范围在 `plugins/<pkg>/server/config.ts` |

## 8. 这里没有的东西（v1 遗迹）

`config.json`、`config.local.json`、8086 端口、`dist/server.mjs`、`dist/web/`、`VITE_API_TARGET` 都属于
**已删除的 v1 单体服务**；v1 的操作手册与规划文档都进了 `docs/archive/`（别照着它们配）。
现行宿主配置只有 `data/host.json` 这一个文件（D16），入口文档是根 `README.md` + `docs/README.md`。

---

相关：`docs/architecture.md`（§4.2 包 manifest、§5.5 外壳偏好、§5.6 设置、§5.7 统一地址、§6/§6.1 分层与入库形态、§6.2 目录型 tab）、
`profiles/default/README.md`（清单字段与"本机状态 vs 基线"）、`tabs/README.md`（目录型 tab 的写法）、
`plugins/*/README.md`（各插件的设置项说明）。
