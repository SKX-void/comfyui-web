# comfyui-server

ComfyUI 的**轻前端服务器**：用一个网页表单调用 ComfyUI 出图，不碰节点图编辑器。

```
表单 → 模板渲染（注入 graph）→ ComfyUI /prompt → WS 收进度 → SSE 推浏览器 → 取图
```

> 规划文档在 [`v1/`](./v1/)，从 [`v1-plan.md`](./v1/v1-plan.md) 开始读。

---

## 快速开始

```bash
pnpm install

# 方式 A：mock 模式（无需 ComfyUI，内置模拟器，可立即验证全链路）
pnpm build            # → dist/server.mjs + dist/web/
node dist/server.mjs
# 打开 http://127.0.0.1:8080

# 方式 B：连接真实 ComfyUI
COMFY_BASE_URL=http://127.0.0.1:8188 pnpm --filter @comfyui-server/server start
```

开发模式（Vite dev server + 热更新）：

```bash
pnpm dev:server   # 后端，端口取 config.json 的 port
pnpm dev:web      # 前端 0.0.0.0:5173，Vite 代理 /api → 后端
```

- 前端监听 **`0.0.0.0:5173`**，可从其它机器访问（启动时会打印 Network 地址）
- `strictPort: true`：5173 被占用时直接报错，不会悄悄换端口，避免访问错地方
- **代理目标只由 `config.json` 的 `port` 决定**，没有第二个环境变量。
  换端口就改 `config.json`（改完 `touch` 一下 `vite.config.ts` 让 Vite 重启，或直接重启它）。
  早期版本同时支持 `VITE_API_TARGET`，结果两处事实来源漂移（代理指向了旧端口却不自知），已移除。

**改了 `template.json` 不想重启后端？** 调一下热重载：

```bash
curl -X POST http://127.0.0.1:8080/api/templates/reload
```

校验失败会直接报错且保留原有模板，不会把服务搞坏。

**从其它主机名访问被拦？** Vite 有 Host 校验（防 DNS rebinding），非白名单主机会报
`Blocked request. This host ("xxx") is not allowed.`。默认已放行 `dsh-env` / `localhost` / `.local`；
其它主机名用：

```bash
VITE_ALLOWED_HOSTS=my.host pnpm dev:web      # 追加指定主机
VITE_ALLOWED_HOSTS='*' pnpm dev:web          # 全部放行（仅限可信内网）
```

> SSE（`/api/jobs/:id/events`）能直接穿过 Vite 代理，无需额外配置。

冒烟测试（无需任何外部服务）：

```bash
pnpm smoke                          # 默认只输出结论：✅ smoke 通过 164/164（0.9s）
pnpm smoke -- --verbose             # 逐条打印 150+ 项断言（排查用）
pnpm smoke -- --log=/tmp/smoke.log  # 明细落盘，终端仍只留摘要
```

**一套命令跑完全部验证**（typecheck → 冒烟 → 构建），终端每步只留一行结论：

```bash
pnpm verify
```

```
▶ verify（typecheck → smoke → build）
✔ typecheck    11.6s
✔ smoke         4.0s
✔ build        13.8s
✅ verify 通过（3 步，29.4s）· 日志 .cache/verify/
```

各步完整输出在 `.cache/verify/<step>.log`；**失败时自动摘出失败行回显并给出日志路径**，
不必把几千行日志灌进终端。也可以只跑其中几步：

```bash
pnpm verify typecheck smoke     # 只跑指定步骤
pnpm verify --no-build          # 跳过构建
pnpm verify --verbose           # 额外回显各步完整输出
```

---

## 构建与部署

一条命令，产出**根目录下自包含的 `dist/`**：

```bash
pnpm build
```

```
dist/
├── server.mjs      后端单文件（esbuild，约 1.9 MB，**不需要 node_modules**；无 .map）
├── web/            前端静态产物（vite build：index.html + assets/ + brush.svg）
└── templates/      工作流模板（与 server.mjs 版本锁定，见下）
```

然后**一个进程同时当 API 服务器和静态文件服务器**：

```bash
node dist/server.mjs                    # 或 pnpm --filter @comfyui-server/server start:bundle
```

打开 `http://<host>:<config.json 的 port>` 就是完整应用：`/api/*` 走接口，
其余路径交给前端（`@fastify/static` + 未知路径回退到 `index.html`）。
**生产环境不需要 Vite** —— 它只是构建期工具，不是运行期组件。

### 前端目录的位置是**固定的**：`<server.mjs 所在目录>/web`

这条规则由 `config.ts` 保证（前端 outDir 由 `apps/web/vite.config.ts` 指向 `../../dist/web`）：

```
打包态：server.mjs 就在 dist/ 里 → webDir = <所在目录>/web   ← 与仓库在哪无关
源码态：tsx 跑 src/index.ts     → webDir = <仓库根>/dist/web ← 同一份布局
```

所以 `dist/` 是一个**部署单元，可以整体搬到任何地方**：

```
/opt/whatever/          ← 把 dist/ 的内容解压到这里就行
├── server.mjs
├── web/
├── config.json         # 可选；不给就用内置默认值 + 环境变量
├── templates/          # 模板（必须）
└── data/               # 自动创建（SQLite）
```

```bash
cd /opt/whatever && node server.mjs     # 直接跑，不需要任何路径环境变量
```

`templatesDir` / `dataDir` / `config.json` 的解析基准（"仓库根"）按这个顺序确定：
`REPO_ROOT` 环境变量 → 往上找 `pnpm-workspace.yaml`（本地开发/本地跑产物都命中仓库根）
→ 都找不到（说明产物被搬走了）就**以产物所在目录为根**。

（实测：把 `dist/` 整个拷到 `/tmp/relocate`，塞进 `config.json` 与 `templates/`，
**周围没有任何 node_modules**，不设任何路径变量直接 `node server.mjs` →
静态页 200、SPA 回退 200、未知 `/api` 404、护栏生效、mock 全链路出图成功。）

### 单文件产物里有什么、没有什么

| | 内容 |
|---|---|
| **打进去** | 服务端全部源码 + `fastify` / `ws` / `pino` / `@fastify/*`（361 个模块，343 个来自 node_modules） |
| **外置** | `pino-pretty`、`bufferutil`、`utf-8-validate`（都只在特定分支才需要） |
| **拷进 dist/** | `templates/`（与 server.mjs 版本锁定，一起进产物） |
| **不打包**（运行时按目录读） | `config.json`（或环境变量）、`dataDir`（缓存默认 `<dataDir>/cache`） |

**模板跟着产物走**：`template.json` 的 bindings 直接指向 graph 的节点/字段、
`requirements.nodes` 指向具体节点类、transform 名字要在 `transforms.ts` 里找得到 ——
模板与 server 是**强代码耦合**的，必须同版本，所以 `pnpm build` 会把它拷进 `dist/templates/`，
部署时不需要单独挂载（要热改模板就用 `TEMPLATES_DIR` 指到外面，或开发模式跑源码）。

所以：改配置、重新构建前端，**不用重新打后端**；但动模板要重新 `pnpm build`。

### 改构建脚本前必须知道的坑

1. **必须是 ESM 输出**。源码用 `import.meta.url` 定位目录，CJS 输出下 esbuild
   会把 `import.meta` 抹成 `{}`，所有路径立刻全乱。
2. **`NODE_ENV` 固化进产物**。pino 的 transport 是运行时按**模块名** spawn worker
   加载 `pino-pretty` 的，打不进包；固化成 `production` 后这条分支不会走。
   （产物里日志是 JSON；开发用 `tsx` 跑源码时仍然是彩色可读的。）
3. **`bufferutil` / `utf-8-validate` 必须标 external**：`ws` 的可选原生加速件，
   没装就走纯 JS；不标 external，esbuild 会因为解析不到直接构建失败。
4. **产物带 `createRequire` 兜底**（banner），让打包进来的 CJS 包在动态 `require` 时也能工作。
5. **`__BUNDLED__` 由 esbuild `define` 注入**，`config.ts` 靠它区分"打包态 / 源码态"
   来算目录（两者到仓库根的距离不同）。源码态下这个标识符不存在，
   所以只能用 `typeof __BUNDLED__ !== 'undefined'` 判断。
6. **vite 的 `outDir` 是 `../../dist/web` + `emptyOutDir: true`**：清空的只是 `dist/web`
   自己，不会碰到旁边的 `server.mjs`。所以 `pnpm build` 的顺序无所谓。
7. **`node:sqlite` 要求 Node ≥ 24**（无 flag 可用），所以根 `package.json` 的
   `engines` 写着 `>=24`，esbuild 的 `target` 也是 `node24`。

### Docker（compose，不需要 Dockerfile）

**部署单元就是四样东西，放在同一个目录里，整个复制走就能跑**：

```
deploy/                      # ← 可以整个目录复制到任何机器
├── docker-compose.yml
├── config.json              # 开发模式和容器**共用**这一份
├── dist/                    # pnpm build 的产物：server.mjs + web/ + templates/
└── data/                    # SQLite + 缩略图缓存（仓库自带 .gitkeep，目录一定存在）
```

```bash
pnpm install && pnpm build   # 产出 dist/
docker compose up -d
curl localhost:8086/api/system/health
```

镜像用官方 `node:26-alpine`，**不需要 Dockerfile、不需要 `npm install`**，镜像里没有任何项目依赖。

**配置走文件模式**：挂 `./config.json` → `/app/config.json`，所以 compose 里只有两个环境变量
（`NODE_ENV` 和 `TZ`）。环境变量优先级仍然最高，临时改一次很方便：
`COMFY_BASE_URL=other:8188 docker compose up -d`。

挂载与路径的对应关系：

| 宿主机 | 容器 | 权限 | 用途 |
|---|---|---|---|
| `./dist` | `/app` | **ro** | `server.mjs` + `web/` + `templates/`（一个挂载点就够） |
| `./config.json` | `/app/config.json` | **ro** | 共用配置 |
| `./data` | `/app/data` | rw | SQLite + 缩略图缓存 |

**为什么 `data` 挂在 `/app/data` 而不是 `/data`**：`config.json` 里写的是**相对路径**
`"dataDir": "data"`，它相对"根"解析 —— 开发时是仓库根，容器里是 `/app`：

```
开发  ：<仓库根>/data              ← pnpm dev:server
容器  ：/app/data                  ← compose 把 ./data 挂到这里
```

这样**一份 config.json 两种跑法都成立**，不用维护两份、也不用为容器加一排环境变量。
（代价是 data 挂载嵌在只读的 `/app` 里面；每个挂载点各管各的权限，可写不受影响。
 想改成顶层 `/data` 就得把 `dataDir` 写成绝对路径，那样开发模式会跑去写宿主机的 `/data`，
 一份配置就伺候不了两边了。）

其他几点：

- **改了代码要重启**：`pnpm build && docker compose restart comfyui-server`（挂载是 ro，但进程要重新加载产物）。
- **本机 8086 被开发服务器占用**时：`HOST_PORT=9086 docker compose up -d`。
- 网络用 external `server-net`（和你 SillyTavern 那份一致）；ComfyUI 若也在同一网络里，
  改 `config.json` 的 `comfyui.baseUrl` 为容器名:端口即可。
- `healthcheck` 用镜像自带的 busybox `wget`；`logging` 限 10 MB × 3，别让请求日志吃满磁盘。
- `data/` 目录在仓库里已经有 `.gitkeep`，所以不会被漏掉；如果是手动拷到别的机器，
  记得把 `data/` 一起拷（或先 `mkdir -p data`，让 docker 建的话会是 root 所有，
  容器里用 `${UID}` 就写不进去了 —— 真发生的话启动会直接提示"数据目录不可用"）。

> 实测（本环境没有 docker，用等价目录结构验证同一套约定）：
> `/app` = dist 内容 + `config.json`（只读），`/app/data` 可写，环境变量**只给 `NODE_ENV` 和 `TZ`**，
> 直接 `node /app/server.mjs` → 启动日志显示 `templates=/app/templates`、
> `db=/app/data/comfyui-server.db`、`webDist=/app/web`、监听 `0.0.0.0`；
> `/` `/brush.svg` `/assets/*` `/spa/x` 全 200、未知 `/api` 404、护栏 422、mock 全链路出图成功。

### nginx 反向代理

`nginx/comfyui-server.conf` 是一个**只含 server 块**的片段，丢进 `conf.d/` 就能用：

```bash
cp nginx/comfyui-server.conf /etc/nginx/conf.d/comfyui-server.conf
nginx -t && nginx -s reload
```

它处理三件事（都注释在文件里）：

1. **SSE 不缓冲**：`/api/jobs/<id>/events` 单独一个 location，`proxy_buffering off` +
   长 `proxy_read_timeout` + 清空 `Connection`。应用自己会发 `X-Accel-Buffering: no`，
   nginx 默认认这个头；但只要中间多一层代理、或有人 `proxy_ignore_headers`、或头被吞掉，
   进度就会卡死 —— 所以显式关缓冲是**兜底**。
   （实测：忽略那个头时，普通 location 2 秒内收到 **0 字节**，带这段的 2 秒内正常收到 133 字节。）
2. **请求体上限** `client_max_body_size 512k`：比应用自己的 256 KB 略大，
   这样用户看到的还是应用返回的中文 413，而不是 nginx 那张 HTML 错误页。
3. **`/assets/` 长缓存**：vite 产物文件名带内容哈希，所以给 30 天并 `proxy_hide_header
   Cache-Control`（不盖掉就会同时冒出两个 Cache-Control 头）；`index.html` 不带哈希，
   保持应用发来的 `max-age=0`。

> nginx 与 comfyui-server 都在 `server-net` 里时，把三处 `proxy_pass` 改成
> `http://comfyui-server:8086;`（容器里的 nginx 用 `127.0.0.1` 够不到宿主机的端口映射）。

### 两种流程的分工

| | 命令 | 出口 | 用途 |
|---|---|---|---|
| 开发 | `pnpm dev:server` + `pnpm dev:web` | Vite `0.0.0.0:5173`（代理 `/api`） | 改代码，HMR，手机经反代访问 |
| 部署 | `node dist/server.mjs` | 后端自己的端口（`config.json` 的 `port`） | 一个进程一个端口，无 Node 依赖树 |
| 容器 | `docker compose up -d` | 宿主 `${HOST_PORT:-8086}` | 给别人用；重启策略/健康检查/日志轮转交给 compose |

> 局域网直连时记得把 `config.json` 的 `host` 改成 `0.0.0.0`；
> 开发流程能走 5173 是因为 Vite 监听所有网卡、再由它转发到 `127.0.0.1` 的后端。

---

## 目录结构

```
comfyui-server/
├── api.example.json          # 原始导出工作流（参考）
├── v1/                       # 规划文档
├── scripts/verify.mjs        # 统一验证入口（pnpm verify：typecheck + 冒烟 + 构建）
├── docker-compose.yml        # 容器部署（只读挂载 dist/，不需要 Dockerfile）
├── dist/                     # 构建产物（gitignore）：server.mjs + web/ + templates/
├── templates/                # 工作流模板
│   └── txt2img-basic/
│       ├── template.json     # inputs + bindings（不含 graph）
│       └── graph.json        # API 格式工作流（从 ComfyUI 导出）
├── packages/shared/          # 前后端共享 TS 类型
└── apps/
    ├── server/               # Node-TS BFF
    │   ├── scripts/build.mjs # esbuild 打包 → <仓库根>/dist/server.mjs
    │   ├── src/comfy/        # ComfyUI 客户端（real = HTTP+WS，mock = 内置模拟器）
    │   ├── src/templates/    # 模板加载 / 渲染 / 变换器
    │   ├── src/safety/       # 硬件安全护栏 + 资源配额
    │   ├── src/jobs/         # 任务编排 + 事件总线
    │   └── src/http/         # 路由层
    └── web/                  # Vue 3 SPA（构建产物输出到 <仓库根>/dist/web）
```

---

## 配置

配置从 **`config.json`**（仓库根，支持 `//` 与 `/* */` 注释）读取：

```jsonc
{
  "host": "127.0.0.1",              // 局域网直连改成 "0.0.0.0"
  "port": 8080,
  "comfyui": {
    "baseUrl": "10.2.3.22:8188",   // 可省协议，自动补 http://
    "mode": "real"                  // real | mock
  },
  "templatesDir": "templates",      // 相对"根"（解析规则见〈构建与部署〉）
  "dataDir": "data",                // SQLite + 缩略图缓存（相对"根"）
  // cacheDir 不用配：默认 <dataDir>/cache
  "logLevel": "info",
  "mockStepDelayMs": 120
}
```

> `webDir`（前端静态产物目录）**默认就是 `server.mjs` 旁边的 `web/`**，所以配置里
> 通常不需要写；只有要托管别处的产物时才加 `"webDir": "dist/web"` / 绝对路径。

### 优先级

```
环境变量  >  config.local.json  >  config.json  >  内置默认值
```

- `config.local.json`：本机私密覆盖，已加入 `.gitignore`
- 也可用 `CONFIG_FILE=/path/to/other.json` 指定另一份配置
- 启动日志与 `GET /api/system/health` 都会回显**实际加载了哪些配置文件**

### 环境变量（用于临时覆盖）

| 变量 | 说明 |
|------|------|
| `COMFY_MODE` | `real` / `mock` |
| `COMFY_BASE_URL` | ComfyUI 基址（如 `10.2.3.22:8188`） |
| `PORT` / `HOST` | 本服务监听 |
| `TEMPLATES_DIR` | 模板目录 |
| `DATA_DIR` | 持久化数据目录（SQLite 等） |
| `CACHE_DIR` | 可重建的缓存目录（缩略图）；默认 `<dataDir>/cache` |
| `WEB_DIR` | 前端静态产物目录（默认 `<dist>/web`） |
| `REPO_ROOT` | `templatesDir` / `dataDir` / `config.json` 的解析基准 |
| `MOCK_STEP_DELAY_MS` | mock 模式每步耗时 |
| `LOG_LEVEL` | 日志级别 |
| `CONFIG_FILE` | 指定配置文件路径 |

### 地址写法

`baseUrl` 允许省略协议，且**必须带端口**（漏写会启动报错，因为 ComfyUI 默认 8188，漏端口几乎总是笔误）：

| 写法 | 归一化结果 |
|------|-----------|
| `10.2.3.22:8188` | `http://10.2.3.22:8188` |
| `http://10.2.3.22:8188/` | `http://10.2.3.22:8188` |
| `https://comfy.example.com:8443` | `https://comfy.example.com:8443` |
| `10.2.3.22` | ❌ 启动报错：缺少端口 |

---

## API 一览

| 端点 | 说明 |
|------|------|
| `GET /api/templates` · `GET /api/templates/:id` | 模板列表 / 详情（含 inputs） |
| `POST /api/jobs` | 提交任务 |
| `GET /api/jobs` · `GET /api/jobs/:id` | 任务列表 / 详情 |
| `GET /api/jobs/:id/events` | **SSE 进度流** |
| `POST /api/jobs/:id/cancel` | 取消 |
| `DELETE /api/jobs` | 清空历史记录（只清已结束的，在途任务保留） |
| `GET /api/assets/:id/raw` | 取产出图（原图） |
| `GET /api/assets/:id/thumb?w=&h=` | 产出图缩略图（列表用，约 3 KB） |
| `GET /api/models?folder=` | 模型枚举 |
| `GET /api/loras/browse?path=` | **LoRA 目录浏览**：一层的内容（子目录 + 当前目录直属 LoRA，不递归） |
| `GET /api/loras/thumb?file=&w=` | **服务端生成的预览缩略图**（WebP；无预览图返回 204） |
| `GET /api/loras/meta?file=` | LoRA 详情（触发词） |
| `GET /api/loras/preview?src=` | 预览图原始代理（仅详情页用） |
| `GET /api/tags/groups` | 标签分组（顶层组 + 子组 + 计数） |
| `GET /api/tags?q=&groupId=&page=&pageSize=` | 标签检索（服务端在缓存树上过滤） |
| `GET /api/tags/autocomplete?q=` | 输入补全 |
| `POST /api/tags/translate` | 中英翻译 |
| `GET /api/system/health` · `/api/system/stats` · `/api/system/queue` | 系统状态 |
| `GET /api/presets` | 全部预设（`Record<kind, Record<name, value>>`） |
| `PUT /api/presets/:kind/:name` | 新增/覆盖预设 |
| `DELETE /api/presets/:kind/:name` | 删除预设 |

### WeiLin 数据源的体积约束（实测，务必遵守）

| WeiLin 端点 | 体积 | 用法 |
|------------|------|------|
| `get_lora_list` | **41 MB** | ❌ 绝不使用 |
| `get_lora_folder_list` | 98 KB | ✅ 列表/目录（服务端缓存 5min） |
| `get_lora_list_by_search` | 命中数级 | ✅ 搜索 |
| `lorainfo/api/loras/info` | **71 KB/条** | ⚠️ 仅在选中时按需查 |
| `prompt/get_group_tags_paginated` | 848 KB | ✅ 一次拉全量，服务端缓存 10min |
| `prompt/fast/autocomplete` | 3 KB | ✅ 不缓存 |
| `prompt/local/translate` | 132 B | ✅ 不缓存 |
| `lorainfo/api/loras/img` | **4.87 MB/张**（1664×2432 PNG） | ⚠️ **必须服务端缩略** |

> 适配层在 `apps/server/src/weilin/client.ts`，对前端暴露的是**KB 级**的
> `/api/loras*` 与 `/api/tags*`，而非 WeiLin 的原始响应。

### 预览图体积（重要）

WeiLin 的 LoRA 预览图是**原始尺寸**。实测采样 40 个：

| 格式 | 占比 | 平均大小 |
|------|------|---------|
| **PNG** | **76%** | **3.4 MB** |
| JPEG | 18% | 1.8 MB |
| WebP | 5% | 1.0 MB |

290 个 LoRA 合计约 **870 MB**，在网页列表里直接加载不可行。

#### 方案一：离线预缩放（推荐，且能完全移除 sharp）

在 **ComfyUI 主机**上运行：

```bash
# 先干跑，看会改什么（默认就是干跑）
python scripts/resize-lora-previews.py --root "D:/comfyui/ComfyUI/models/loras"

# 确认后执行（原图自动备份到 _preview_backup/）
python scripts/resize-lora-previews.py --root "..." --apply
```

**「未处理」的识别**：WeiLin 上传新预览图时会先删掉该 LoRA 已有的全部预览图
（含 `.webp`），再按上传文件自身的扩展名写入；Civitai 的图片多为 `.jpeg`。
于是 **`.webp` = 已处理，其它扩展名 = 新增/未处理** —— 跑一次干跑即可看到
「按扩展名」的统计。

**编码后端**：优先用 `cwebp`（PATH 里能找到就用；也支持 `CWEBP` 环境变量
或 `--cwebp` 指定路径），回退到 Pillow。
两者的代码路径都经过测试。图像尺寸由脚本自己解析文件头得出
（PNG/JPEG/GIF/BMP/WebP 的 VP8、VP8L、VP8X 三种子块），
因此**没有 Pillow 也能正确缩放**。

实测把最长边缩到 512px、输出 WebP q82：**3 MB → 约 50 KB**，整库 870 MB → 约 15 MB。

> ⚠️ 脚本会**删除**旧的预览图文件。原因：WeiLin 的查找顺序是
> `jpg → png → jpeg → gif → webp`，只要旧的 `foo.png` 还在，新的 `foo.webp`
> 永远不会被使用。所以对每个基名只保留一个 `.webp`，其余变体全部删除
> （包括同名共存的 `foo.jpg` + `foo.png`）。原图默认备份。

常用参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `--max-side` | 512 | 最长边上限；小于此值不放大 |
| `--quality` | 82 | WebP 质量 |
| `--apply` | 关 | 不加则仅干跑 |
| `--no-backup` | 关 | 不备份原图 |
| `--min-kb` | 0 | 非 WebP 来源小于此体积则跳过 |
| `--webp-max-kb` | 150 | 已是 WebP 且小于此体积则跳过重压 |

脚本幂等：跑完再跑一次会提示「没有需要处理的图片」。

预缩放之后，服务端**不需要任何图像处理能力**，`sharp` 可以从
`optionalDependencies` 里彻底删掉。

> Windows 上如果 `python` 不在 PATH，可用 ComfyUI 自带的
> `python_embeded\python.exe`（但此时 `cwebp` 仍需在 PATH 上）。

#### 方案二：服务端缩放（默认关闭，无原生依赖）

`sharp` **不是依赖**。项目不含任何原生模块，`pnpm install` 在任意平台都不会编译。
服务端只做「回源 + 磁盘缓存」，图像缩放交给离线脚本。

代码里保留了可选缩放能力（运行时惰性 `import('sharp')`，拿不到就跳过），
需要时手动装上即可启用：

```bash
pnpm --filter @comfyui-server/server add sharp
```

启用后会把预览图缩到请求尺寸（`w`×`h`），单张约 8 KB 而非 30 KB。

#### 实测对比（目录 `Anima\画师`，31 个 LoRA）

| 阶段 | 冷启动 | 下载量 |
|------|--------|--------|
| 初始（原始 PNG，服务端 sharp 缩放） | 7.9 s | 259 KB |
| 预缩放后 + 服务端 sharp | 1.6 s | 235 KB |
| **预缩放后 · 无 sharp（当前默认）** | **0.56 s** | 917 KB |

> 无 sharp 反而更快 —— 省掉了 31 次解码+重编码的 CPU。
> 代价是多传 4 倍（源文件 512px，卡片位只需 180px）。
> 浏览器侧有 `Cache-Control: immutable`，每个浏览器只付一次。

#### 浏览器端压缩回传？

不推荐：首次仍需把原图（3~10 MB）拉到浏览器，只是把解码开销转嫁给客户端，
并没有减少首屏传输。离线预缩放才是从源头解决。

#### 产出图

模板用 `SaveImagePlus` 输出 WEBP q80，单张约 100 KB；服务端再加一层磁盘缓存。
列表小图走 `/api/assets/:id/thumb`。

------|---------|------|----------------|
| 卡片网格（3:4 竖版） | `w=180&h=240` | **8.4 KB** | **259 KB** |
| 已选行小图 | `w=120&h=160` | ~4 KB | — |

冷启动约 8 s（每张需拉 5 MB 原图解码），**命中缓存 0.10 s**（约 80× 加速）。

- 支持非正方形：LoRA 预览图多为竖构图（1664×2432 ≈ 2:3），
  一律切方形会丢掉大半画面；卡片用 3:4，并用 `position: 'attention'` 让裁剪偏向主体
- 缓存目录 `<repo>/.cache/loras-thumbs/`（已 gitignore），key 含尺寸
- 并发请求同一 LoRA 会合并，避免重复解码同一张 5 MB 原图
- 没有预览图的 LoRA 返回 **204**，前端显示占位块
- 前端 `<img loading="lazy">`，只加载可见项

---

## 预设

四个输入块各自可以切换预设：**正向提示词 / 正向质量词 / 负向质量词 / 宽高对**。
点击「预设」拉起对话框，列出该类别全部预设、展示详细内容，由「载入」按钮套用。

### 存储：每类别一张表（范式化）

用 Node **内置的 `node:sqlite`**（不是 `better-sqlite3` —— 那是原生模块，
与「纯 JS 源码构建」目标冲突，和 sharp 同一类问题）。
库文件在 `dataDir/comfyui-server.db`（默认 `data/`，已 gitignore）。

四种预设是**独立实体**，各自一张表：

```sql
CREATE TABLE preset_size (
  id          TEXT PRIMARY KEY,       -- 'ps_<uuid>'：跨库合并不撞键
  uid         TEXT NOT NULL,          -- 预留多用户，v1 固定 'local'
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  width       INTEGER NOT NULL CHECK (width  > 0),
  height      INTEGER NOT NULL CHECK (height > 0),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (uid, name)
);
-- preset_prompt / preset_quality_pos / preset_quality_neg 同构，把 width/height 换成 text
```

**为什么不用「单表 + JSON 值」**（早期版本踩过）：

| 维度 | JSON 值 | 类型化列（当前） |
|------|---------|-----------------|
| `description` | 只能塞进 `$desc` 键 | **真列** |
| `width/height` | 字符串里的数字 | `INTEGER` + **CHECK 约束** |
| 查询 | 需要 `json_extract` | `WHERE width > 1024`、`ORDER BY width*height` |

用不上的灵活性（"加类别不用迁移"）不值得拿完整性和可查询性去换。

> 迁移用 `PRAGMA user_version`，只追加不回改。
> v2 迁移会把 v1 的 JSON 表数据**搬迁**到新表（`$desc` 提升为 `description` 列），
> 然后删掉旧表。

### API

响应里带**字段元数据**（dialog 展示"详细内容"用），以及一个由列**派生**的
`values`（键换成模板 input 的 key）：

```jsonc
// GET /api/presets/size
{
  "kind": "size",
  "label": "宽高对",
  "fields": [
    { "column": "width",  "inputKey": "width",  "label": "宽", "type": "int" },
    { "column": "height", "inputKey": "height", "label": "高", "type": "int" }
  ],
  "items": [
    { "id": "ps_…", "name": "竖版 832×1216", "description": "",
      "sortOrder": 0, "values": { "width": 832, "height": 1216 } }
  ]
}
```

| 端点 | 说明 |
|------|------|
| `GET /api/presets` | 全部类别（前端一次拉齐） |
| `GET /api/presets/:kind` | 单类别 |
| `PUT /api/presets/:kind/:name` | body `{ description?, values: {…} }` |
| `DELETE /api/presets/:kind/:name` | 删除 |

> `values` 的键与服务端列名是**两套**：列名是存储，inputKey 是模板字段。
> 映射在 `store/presets.ts` 的 `PRESET_KINDS` 登记表里集中定义 ——
> 加一种预设 = 一条 registry + 一条迁移。

### 模板声明

```jsonc
{ "key": "prompt",     "ui": { "preset": "prompt" } },   // 简写，目标为自身
{ "key": "qualityPos", "ui": { "preset": "qualityPos" } },
{ "key": "qualityNeg", "ui": { "preset": "qualityNeg" } },
{ "key": "width",      "ui": { "preset": { "kind": "size",          // 一条预设改多个字段
                                           "targets": ["width", "height"] } } }
```

界面：单字段的「预设」按钮在标签行右侧；整行（宽高）的在行上方。

---

## 任务历史：刻意不持久化

出图结果是**用过即弃**的，服务端不建 `jobs` 表。「本次会话」卡片只是内存态，
后端重启即清空（UI 上已注明）。

卡片右上角有个「清空」按钮（就是 `DELETE /api/jobs`）：只清**已结束**的记录，
**正在跑的任务会保留** —— 把在途任务的记录删掉，它后面的事件就没地方落了，
用户还会以为"什么都没在跑"，而 GPU 其实正忙着。清空只影响内存里那份列表 ——
**产出图本身不受影响**：本服务不存图，只把 ComfyUI 给的 `type/subfolder/filename`
编成 `assetId` 记在任务上，图始终在 ComfyUI 那台机器的 output 目录里。

需要留档时，把「输出格式」切到 **PNG** —— 这相当于一个「存 / 不存」开关：

| 格式 | 832×1216 实测 | 图片元数据 |
|------|--------------|-----------|
| **PNG** | 644 KB | ✅ `tEXt.api_workflow` = **完整 API 图 JSON**（17 节点，含正提示词、LoRA 列表、全部参数） |
| **WEBP q80** | 54 KB | ❌ 仅 `EXIF` 里 1KB 的 A1111 参数串（**缺正提示词**、缺 LoRA 列表） |

### ⚠️ 必须发送 `extra_pnginfo`，否则 PNG 也没有元数据

ComfyUI 的**原生** `SaveImage` 会自动注入 `PROMPT`（完整 API 图）—— 它总是有元数据。

但**第三方**保存节点（如 `SaveImagePlus`）不会。要让它们写入，必须在 `/prompt`
请求里带 `extra_data.extra_pnginfo`：

```jsonc
POST /prompt
{
  "prompt": { … },
  "client_id": "…",
  "extra_data": {
    "extra_pnginfo": { "api_workflow": { … } }   // ← 键名自定，保存节点会逐个写入
  }
}
```

`JobManager` 已按此发送（`jobs/manager.ts`）。键名刻意**不叫 `workflow`** ——
那是 ComfyUI UI 格式，前端打开会解析失败；`api_workflow` 只用于我们自己恢复参数。

> 教训：早期版本没发 `extra_pnginfo`，导致换成 `SaveImagePlus` 后
> PNG 输出里只剩 500 字节的 A1111 参数、正提示词永久丢失。

---

## 硬件安全护栏

给**别人**用之前必须知道的一节：前端的 `min`/`max` 只是 HTML 提示，
改个请求体就绕过去了，所以上限由服务端自己兜。规则表在
`apps/server/src/safety/limits.ts`，详细设计见 [`v1/v1-safety.md`](./v1/v1-safety.md)。

| 规则 | 字段（按名字匹配，与模板解耦） | 范围 |
|------|------------------------------|------|
| `steps` | `steps` | 1 – 24 |
| `steps_to_run` | `steps_to_run` | 1 – 24（豁免 `-1`，那是"跑满 steps"的哨兵） |
| `size` | `width` / `height` / `target_width` / `target_height` | 64 – 1216 |
| `batch` | `batch_size` | 1 – 1 |
| `loras`（数量） | `lora_str` / `temp_lora_str`（JSON 数组） | ≤ 8 个，超量直接拒、不截断 |

三道闸门，越靠后越"绝对"：

1. **表单值**（`coerceValues`）：按「模板 `ui.min/max` ∩ 安全策略」校验，
   越界直接 422，错误信息带字段名与上限。
2. **渲染结果**（`renderTemplate` → `guardGraph`）：值全部落图后再扫一遍最终图。
   能追溯到用户填的字段 → 拒绝（不悄悄改用户参数）；
   只来自模板（`const`/导出原值）→ 夹紧到安全值 + WARN；
   **取值判定不了 → 拒绝**（fail closed，不猜就不会漏）。
3. **出口**（`ComfyClient.submit` → `assertGraphSafe`）：发往 ComfyUI 前纯断言，
   有一处越界就拒绝提交；走到这里还越界说明上游有 bug。

配套行为：

- **单一真相源**：`GET /api/templates/:id` 会用策略收窄下发的 `ui.min/max`
  （实测 `steps` 从 200 → 24），所以 `template.json` 里那份旧值不影响安全，
  也不用同步维护。
- **顺连线解析**：`steps` 常写成 `["49", 0]` 而不是字面量，
  校验会一路追到 `26.inputs.steps → 49.inputs.value`；
  上游有多个数值输入时不猜，直接判定失败。
- **启动期校验**：模板 `default` 越界、或受管控字段判定不了 → 整体启动失败；
  模板自带的越界值只告警（提交时夹紧）。

### 资源配额（`safety/quota.ts`）

`limits.ts` 管"图里的值"，`quota.ts` 管"服务自身的资源"：

| 常量 | 值 | 行为 |
|------|----|------|
| `MAX_QUEUE_DEPTH` | 5 | 在途任务超 5 → **429 QUEUE_FULL**（先登记再校验，并发也数得准） |
| `MAX_JOBS_RETAINED` | 200 | 任务表超条数时**从最旧的开始丢**，在途任务永不丢 |
| `MAX_BODY_BYTES` | 256 KB | Fastify `bodyLimit`，超出 → **413**（不做图生图，用不着 32 MB） |

仍未纳入：缩略图磁盘缓存无上限；鉴权（本期明确不做，需要时上反向代理）。

---

## 关键实现约束（踩过的坑）

1. **产出图格式决定传输体积。**
   模板用 `SaveImagePlus`（节点 57）而非 `SaveImage`，可指定 `file_format` / `quality`：

   | 格式 | 实测（832×1216） | 相对 PNG |
   |------|-----------------|---------|
   | PNG | 1.48 MB | — |
   | **WEBP q80** | **99 KB** | **15× 更小** |
   | WEBP q70 | 75 KB | 20× |
   | JPEG q90 | 219 KB | 6.9× |

   两者的 history 输出结构**完全一致**（`outputs[nodeId].images`），
   所以换节点不需要改任何代码。

2. **`ws` 库把「文本帧」也以 `Buffer` 投递，不是 `string`。**
   早期用 `typeof raw !== 'string'` 过滤，导致**所有 WS 事件被静默丢弃**——
   HTTP 提交成功、出图也成功，但前端永远收不到进度。
   必须显式转字符串，并用第二个参数 `isBinary` 区分预览图二进制帧。
   （`src/comfy/real.ts`）

2. **ComfyUI 只有 WebSocket，没有 SSE。**
   浏览器侧由本服务转成 SSE。

3. **进度事件只投递给「提交时的 `client_id`」，不是广播。**
   因此本服务对**所有任务共用一个 `clientId`**（见 `src/index.ts`），
   再按 `prompt_id` 区分归属。若每次任务换 clientId，将收不到任何进度。

4. **任务状态的真相源是 `/history`，不是 WS。**
   `executing node=null` 与 history 落盘之间存在竞态，
   所以 `finalize()` 带短重试（`readHistorySettled`）；
   另有 10s 周期的**对账扫描**（`sweep()`）兜底 WS 丢事件与重启恢复。

5. **上游请求必须带超时。**
   否则一台不可达的 ComfyUI 会让健康检查与请求永久挂起。
   常规 30s，健康探测 3s（`AbortSignal.timeout`）。

6. **触发词走 WeiLin 节点原生注入，本服务不自行实现。**
   节点读取的是 Civitai/元数据/文件名，**不读**用户编辑的 `loraWorks`。
   详见 [`v1/v1-weilin.md`](./v1/v1-weilin.md) §5.3。

7. **LoRA 名含反斜杠**（如 `Anima\画师\x`），
   始终「先构造对象、再 `JSON.stringify`」，不要手写转义字符串。

---

## 已验证（真实 ComfyUI）

跑在 `10.2.3.22:8188`（ComfyUI 0.33.0，2608 个节点）：

- ✅ 三个 WeiLin 节点均已加载；WeiLin REST 可用（**288 个 LoRA**）
- ✅ 真实任务：`POST /api/jobs` → WS 收到 `progress 2/6 → 6/6`（采样器节点 26）
  → `completed` → 取回 512×768 真实出图
- ✅ LoRA 生效（`Anima Turbo LoRA-v0.2` 权重 0.9）
- ✅ 安全护栏：`steps=200`/`width=4096`/`height=1217`/`steps=6.5`/`width=8`/9 个 LoRA
  一律 422，300 KB 请求体 413；合法请求（默认 6 步、832×1216）照常出图；
  `GET /api/templates/:id` 下发 `steps.max=24`、`width.max=1216`
- ⚠️ `get_lora_list` 返回 **41 MB**，前端不可直接用，需走分页/搜索端点（M3 处理）

---

## 拆分式节点设计

模板沿用「每个节点只干一件事」的思路：

| 节点 | class_type | 职责 | 模板字段 |
|------|-----------|------|---------|
| `43` | `WeiLinPromptUI` | LoRA 加载 + **触发词注入** | `lora_str` / `positive`(仅标签) |
| `19` | `WeiLinPromptUIWithoutLora` | 主提示词 | `positive` |
| `28` | `CR Text` | 质量词（正） | `text` |
| `33` | `CLIPTextEncode` | 质量词（负） | `text` |

最终提示词顺序：`触发词 → 质量正向词 → 主提示词`，负向词独立。

> `WeiLinPromptUIOnlyLoraStack` **不做触发词注入**，这正是需要
> `WeiLinPromptUI`（全能组件）来承担 LoRA 加载的原因。

---

## 加新模板

1. 在 ComfyUI 里搭好工作流，用「导出 (API Format)」得到 `graph.json`
2. 新建 `templates/<id>/`，放入 `graph.json`
3. 写 `template.json`：`inputs`（表单）+ `bindings`（注入规则）
4. 启动时自动静态校验；binding 指向不存在的节点/字段会**直接启动失败**

无需改服务器代码。
