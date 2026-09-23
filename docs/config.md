# 配置地图

仓库里叫"配置"的文件有十来个，它们**不是一层，而是四层** —— 先认层，再找文件：

| 归属层 | 意思 | 谁改 | 在哪 |
|---|---|---|---|
| **随包发布** | 插件自带的事实：默认值、合法范围、表单字段 | 插件作者，跟版本走 | `plugins/*/package.json` 的 `plugin.settings[]`、`plugins/*/server/config.ts` |
| **随部署变化** | 这台装置怎么跑：端口、路径、默认 profile | 部署的人，部署时定 | `host.config.json`、`docker-compose.yml`、`nginx.conf` |
| **随机器变化** | 这批部署装了哪些插件、各配了什么（本机状态） | 设置页 / `pnpm plugin` | `profiles/<n>/plugins.yml`（不入库）、`plugins.example.yml`、`package.json` |
| **随用户变化** | 运行期偏好：tab 顺序、默认首页、统一地址 | 设置页，随时改 | `data/ui-prefs.json`、`data/plugins/<包名>/` |

层与层的边界是锁过的：D6（§4.2 / §6）、D13（§6.1）、§5.5 / §5.7。**不要跨层放值** ——
比如"某台机器的 ComfyUI 地址"属于随机器/随用户，放不进随包发布的 `package.json`。

## 一览

| 文件 | 谁读（代码） | 层 | 能直接手改吗 | 入库 |
|---|---|---|---|---|
| `host.config.json` | 宿主启动：`apps/server/src/config.ts` → `loadHostConfig()` | 部署 | ✅ 改完要重启 | ✅ |
| `docker-compose.yml` | `docker compose` | 部署 | ✅ | ✅ |
| `nginx.conf` | 外部/容器 nginx（**conf.d 片段**） | 部署 | ✅ | ✅ |
| `profiles/<n>/package.json` | pnpm + `apps/server/scripts/plugin.mjs` | 机器（插件集基线） | ⚠️ 走 `pnpm plugin add/remove` | ✅ |
| `profiles/<n>/plugins.example.yml` | 宿主启动的 bootstrap（清单缺失时） | 机器（行基线） | ⚠️ 走 `pnpm plugin snapshot` | ✅ |
| `profiles/<n>/plugins.yml` | Include（**唯一真源**）+ 设置页写 | 机器 | ✅ 但**别写注释** | ❌（D13） |
| `profiles/<n>/pnpm-workspace.yaml` | pnpm | 环境 | ✅ | ✅ |
| `pnpm-workspace.yaml`（根） | pnpm（workspace + `storeDir`） | 环境 | ✅ | ✅ |
| `data/ui-prefs.json` | 宿主 core 插件（`apps/server/src/ui-prefs.ts`） | 用户 | ❌ 走设置页 | ❌ |
| `data/plugins/<包名>/…` | 各插件自己 | 用户 / 运行期 | ❌ | ❌ |
| `plugins/<pkg>/package.json` 的 `plugin.settings[]` | 宿主 → `GET /api/plugins` → 设置页表单 | 包 | ✅（改包） | ✅ |
| `plugins/<pkg>/server/config.ts` | 插件自己（运行期默认值 / 范围） | 包 | ✅（改包） | ✅ |

---

## 1. 宿主进程：`host.config.json`（根目录）

宿主启动读一次，之后不再看文件；**文件可以不存在**，全走内置默认。

| 字段 | 默认 | 作用 | 环境变量覆盖 |
|---|---|---|---|
| `host` | `0.0.0.0` | 监听地址 | — |
| `port` | `8087` | 监听端口（宿主是唯一后端） | `COMFYUI_WEB_PORT` |
| `dataDir` | `data` | 运行期状态根：`ui-prefs.json`、`plugins/<包名>/` | — |
| `profilesDir` | `profiles` | profile 根（相对路径按仓库根解析） | — |
| `profile` | `default` | 用哪个 profile → `profiles/<name>/plugins.yml` | `COMFYUI_WEB_PROFILE` |
| `logLevel` | `info` | pino 级别 | `COMFYUI_WEB_LOG_LEVEL` |
| `webDir` | 源码态 `<仓库根>/dist/host/web`；打包态 `<host.mjs 所在目录>/web` | 宿主前端产物目录（存在才托管） | — |

另有 `REPO_ROOT`（显式指定仓库根，测试用）与 `NODE_ENV=production`（关掉 `pino-pretty`，退回 JSON 日志）。

- **优先级：环境变量 > 文件 > 内置默认**。环境变量只作**临时覆盖**（换个端口起第二个实例），不是第二份配置来源。
- 支持 `//` 与 `/* */` 注释：`config.ts` 里手写剥离，**不是**标准 JSONC。
- **它不含任何业务配置**：没有 ComfyUI 地址、没有插件开关。插件地址在 `plugins.yml`（或跟随 `data/ui-prefs.json` 的统一地址）。
- docker 里它是 `:ro` 只读挂载（见 `docker-compose.yml`）→ 容器内改不了它；运行期能改的值一律走设置页（落 `data/`），这正是 §5.5 把 `ui-prefs.json` 放 `data/` 的理由。

## 2. 插件集与清单：`profiles/<name>/`

- **`package.json`** —— 插件集基线：依赖即"这个 profile 装了哪些插件"（本地插件是 `link:../../plugins/x` 的**相对**路径，别写绝对路径）。`pnpm plugin add/remove` 会同时改它和清单。
- **`plugins.example.yml`** —— 行基线，只有 `id` / `name`（`config` / `disabled` 都是本机状态，剥掉）。由 `pnpm plugin snapshot` 从 live 清单生成；**清单缺失时宿主从这里复制一份**（`apps/server/src/index.ts`）。
- **`plugins.yml`** —— **运行时唯一真源**（D7），由 Include 托管。设置页的 `PUT /api/plugins/:id/config` 写的就是这里的 `config`，`disabled` 由设置页/CLI 切换。它是本机状态所以**不入库**（D13），而且 **`Include` 重写会丢注释 → 别在这里写注释**。字段含义见 `profiles/default/README.md`。
- profile 是**独立的 pnpm workspace**（`pnpm-workspace.yaml` 里 `storeDir: ../../.pnpm-store`）：既不冒泡到仓库根污染 lockfile，也绕开只读的 HOME。

## 3. 运行期状态：`data/`

**`data/ui-prefs.json`**（`apps/server/src/ui-prefs.ts`，端点 `GET/PUT /api/ui`）：

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

- **`docker-compose.yml`**（单服务）：挂 `dist:ro`、`host.config.json:ro`、`profiles`（**必须可写**：宿主会重写 `profiles/<n>/.cordis/resolve.mjs`）、`plugins:ro`、`data`；`UID`/`GID`/`TZ` 走 env。`profiles` 与 `plugins` 必须保持仓库里那层**相对深度**（`link:` 指向 `../../plugins/x`）。
- **端口在三处保持一致**：`host.config.json` 的 `port`（容器内）= `docker-compose.yml` healthcheck 里的 URL = `nginx.conf` 的 `set $backend_url http://comfyui-web:8087`。
- **`nginx.conf`**（根目录）：**conf.d 片段**，只有 `server` 块，没有 `events` / `http` 外壳 —— 不能直接 `nginx -c nginx.conf`。
  `cp nginx.conf /etc/nginx/conf.d/comfyui-web.conf && nginx -t && nginx -s reload`。
  SSE 不缓冲 / 插件产物不缓存 / `/assets/` 长缓存这三件事都注释在文件里。

## 6. 常见诉求 → 改哪儿

| 想干的事 | 改哪里 |
|---|---|
| 换宿主端口 | `host.config.json` 的 `port` + `docker-compose.yml` healthcheck 的 URL + `nginx.conf` 的 upstream，然后重启 |
| 所有插件共用一个 ComfyUI 地址 | 设置页的"统一 ComfyUI 地址"（写 `data/ui-prefs.json`，并把值灌进跟随者的行） |
| 只给某个插件单独地址 | 该插件的地址项填上 = 自定（写 `plugins.yml` 该行）；清空 = 回到跟随 |
| 加 / 删插件 | `pnpm plugin add <包>` / `pnpm plugin remove <id>` → 重启宿主；想让基线跟上再 `pnpm plugin snapshot` |
| 临时换端口起第二个实例 | `COMFYUI_WEB_PORT=18087 pnpm start`（env，不改文件） |
| 换一套 profile | `host.config.json` 的 `profile`，或 `COMFYUI_WEB_PROFILE=xxx` |
| 重置某个插件的运行期数据 | 删 `data/plugins/<包名>/`（等价于 `pnpm plugin remove --drop-data`） |
| 改插件的可配项 / 默认值 | 设置项清单与表单默认在 `plugins/<pkg>/package.json`；运行期默认与范围在 `plugins/<pkg>/server/config.ts` |

## 7. 这里没有的东西（v1 遗迹）

`config.json`、`config.local.json`、8086 端口、`dist/server.mjs`、`VITE_API_TARGET` 都属于
**已删除的 v1 单体服务**；根 `README.md` 是 v1 的历史文档（它自己在顶部声明了），别照着它配。
v2 的宿主配置只有 `host.config.json` 这一个文件。

---

相关：`docs/architecture.md`（§4.2 包 manifest、§5.5 外壳偏好、§5.6 设置、§5.7 统一地址、§6/§6.1 分层与入库形态）、
`profiles/default/README.md`（清单字段与"本机状态 vs 基线"）、`plugins/*/README.md`（各插件的设置项说明）。
