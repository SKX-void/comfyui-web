# AGENTS.md —— 在这个仓里干活前先读这一页

ComfyUI 的**轻前端 + 工作流插件宿主**。三个概念：

- **宿主** `apps/server/`（:8087）：只做框架 —— 装载插件、分发路由、托管前端、设置页。**不含业务功能**
- **外壳** `apps/web/`：tab 栏 + 插件页面 + 设置页；Vue 由 `index.html` 的 import map 提供
- **插件**（业务全在这里）：`tabs/<id>/`（**目录即插件**，宿主唯一装载的东西，热重载）
  源码工程在 `plugins/<id>/`，构建把它写进 `tabs/`（D16，见 `docs/architecture.md` §4.1/§14.5）

## 先看哪份文档（**不要通读 `docs/`**）

| 要改什么 | 先看 |
|---|---|
| 跑起来 / 装插件 / 写插件 / 目录约定 | `docs/README.md` |
| 插件契约、句柄（`ctx.routes`/`ctx.space`）、决策 D1–D26 | `docs/architecture.md` §4 / §5 / §2 |
| 某个配置该写进哪个文件、入不入库 | `docs/config.md`（五层表） |
| 插件源码放哪、产物怎么来（`plugins/*` → `tabs/*`） | `docs/architecture.md` §4.1 + `tabs/README.md` |
| 从 0 写一个插件（路由/存储/前端 tab/构建/调 ComfyUI） | `plugins/README.md` |
| 目录型插件（`tabs/`）怎么写、什么时候生效 | `tabs/README.md` |
| 历史（v1 单体、v2 落地过程） | `docs/archive/` —— **只作来龙去脉参考，别照着实现** |

## 命令

```bash
pnpm dev:host                          # 宿主 :8087（tsx watch，排除 .cordis/data/dist/tabs/web）
pnpm dev:web                           # 外壳（vite :5173，代理 /api 与 /plugins）
pnpm dev:plugins                       # 插件产物 watcher（pack.mjs --watch → tabs/）：改源码边写边出产物
pnpm dev                               # 先 build:plugins 垫一次产物，再 apps/* dev（新克隆用这个）
pnpm build                             # → dist/app/{server.mjs,web/} + dist/tabs/ + dist/data/（完整可搬，不入库）
pnpm verify                            # typecheck → isolation → smoke → build → tabs-sync → contract（日志 .cache/verify/）
pnpm -r typecheck
```

## 这个环境的坑（都踩过）

- **bash 输出会被吞**：可能产生大量输出的命令（build/typecheck/curl 循环）必须
  `setsid nohup <cmd> > /tmp/x.log 2>&1 < /dev/null &`，然后读 `/tmp/x.log`。
- **`tsx watch` 会盯整仓，必须带 `--exclude`**：cordis 启动时会在「`baseUrl` 往上最近的那个
  `package.json`」旁写 `.cordis/resolve.mjs`。现在 `baseUrl` 是 `tabs/`，于是它落在**仓库根** ——
  不排除就是每 2s 重启一次的活锁（宿主永远起不来）；改 `tabs/`、`data/` 也会连带重启宿主。
  `pnpm dev:host` 已经排除 `.cordis/data/dist/tabs/web`：改 `src/` 才重启，改 tab 由人点「重新扫描」生效。
- **跨 bash 调用起的后台进程杀不掉**（PID namespace 限制）：验证请"同一次调用内起进程 + kill"，
  或换个空闲端口再起，别指望后面 `kill` 掉它。
- 端口：宿主 `8087`，外壳 vite dev **固定 5173**（`strictPort`，被占就直接失败；换端口用 `COMFYUI_WEB_DEV_PORT`），`/api`、`/plugins` 由它代理到宿主。
- 生产态宿主**自己就能送前端**（`dist/app/web`），不需要 vite；但改了 `apps/web` 要重新 `pnpm build:web`。
  交付物是 `dist/` 整包（D18）：`node dist/app/server.mjs` 就能跑，`repoRoot` = `dist/`。

## 硬规矩

- 插件后端**不要 `import` cordis 运行时**（宿主已经把 cordis 打进自己的产物，再引一份就是两个实例）；
  插件前端**不要**把 `vue` / `vue-router` 打进 bundle（import map 提供，与宿主同一份）。
- 插件只拿 `ctx.routes` / `ctx.space`（按需 `inject`），**存储形态自管**（SQLite？JSON？随便），
  数据写进 `ctx.space`（→ `data/plugins/<包名>/`），宿主不代管、不迁移、不清理。
- tab（`tabs/<id>/`）：**交付物**（编译完、自包含、无 `node_modules`）、目录名即 id、配置自己持有
  —— 宿主**没有**写它配置的端点，插件把设置写进自己的 `ctx.space` 后请求 `POST /api/tabs/:id/reload`；
  `PUT enabled` 是**宿主的部署事实**：写 `data/host.json` 的 `disabled`（重启后仍停用，D21）。
  源码在 `plugins/<id>/`，改完要 `pnpm build:plugins`（或常驻 `pnpm dev:plugins`）。`tabs/` **不入库**，
  仓库只留 `tabs/README.md`；**手写 tab：把目录直接丢进 `tabs/`**；`tabs-sync` 只查「产物能不能装载」。
- **重挂靠手动触发（D20）**：宿主不监听、不轮询目录 —— 装进去 / 改完在设置页点一次「重新扫描插件目录」
  （`POST /api/tabs/rescan`）才装载或重挂；重挂 = 新 fiber（说明符带 `?v=` 换 URL），收尾写在
  `ctx.effect(() => () => 收尾)`，内存状态一律归零，要活下来的写 `ctx.space`。
- **profile 机制已删除（D19）**：`profiles/`、Include 装配、清单落盘、契约 patch 层、`pnpm plugin`、
  `fallback`/`following` 全没了 —— `tabs/` 是唯一的插件来源，别在这上面加新东西。
  统一 ComfyUI 地址只剩「只读默认值」一条语义（`data/host.json` 的 `globals`）。
- **标签页常驻是用户偏好（D26）**：`data/host.json` 偏好段的 `keepAlive`（设置页每个插件的「切走不卸载」，
  默认关 = 切走即卸载）。插件**不许假设切 tab 会触发 `onUnmounted`** —— 长命资源（SSE、定时器）用
  `onActivated` / `onDeactivated` 按可见性决定去留。
- 装插件 / 加 tab **不需要重新构建宿主**（`sha256(dist/app/**)` 前后逐字节一致）；这条是方案的核心主张，
  别用"构建期拷贝插件"之类的做法破坏它。
- 前端共享代码放 `packages/shared`（纯类型/常量）。

## 工程实践（模块化）

- **单个源文件 ≤ 300 行**：手写 TS 源码（`apps/*/src/`、`packages/shared/src/`、`plugins/*/src/`、`plugins/*/server/`）
  超了就拆成多个文件，按什么维度拆由你自己判断。
- 不约束：测试与脚本（`scripts/`、`*-test.ts`、`plugins/*/scripts/`）、构建产物（`lib/`、`tabs/`、`dist/`）、vendor。
- 既有超 300 行的文件不要求立刻重构，**动到它时顺手拆**；新写的文件直接守住这条。

## 文档与注释纪律（这一条就是为了让下一个智能体少读几千行）

- `docs/` 只放**现行**结论：`README.md`（索引）· `architecture.md`（设计与决策）· `config.md`（配置分层）。
- **过程叙事不写进现行文档**：走过的弯路、当时的实测、一次性的迁移记录 → `docs/archive/`。
  现行文档只留"结论 + 状态"，决策追加到 `architecture.md` §2，落地状态追加到 §14。
- **注释只写"为什么"和"坑"**，不要复述 `architecture.md` 里的机制 —— 复述必然腐烂，
  而且会让检索和阅读变慢。引用文档写现名（`docs/architecture.md §5.3`），别写旧名（`v2-architecture`）。
- 新增一个"配置"文件 → 必须在 `docs/config.md` 的五层表里登记；新增一个插件来源 → `architecture.md` §2 加决策行。
- 移动/删除文档时**顺手修链接**：逐个 grep 出 `](./x.md)` 这类目标，确认文件真的存在（本轮整理就是靠这个兜住的）。

## 完成前

跑验证，并把证据写进回复（命令 + 观察到的输出）。**没跑验证就不要说"完成"**：
`pnpm verify`；只改 `/tabs` 时至少 `curl -s localhost:8087/api/plugins` 看 phase 与 entry。
