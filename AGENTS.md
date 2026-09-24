# AGENTS.md —— 在这个仓里干活前先读这一页

ComfyUI 的**轻前端 + 工作流插件宿主**。三个概念：

- **宿主** `apps/server/`（:8087）：只做框架 —— 装载插件、分发路由、托管前端、设置页。**不含业务功能**
- **外壳** `apps/web/`：tab 栏 + 插件页面 + 设置页；Vue 由 `index.html` 的 import map 提供
- **插件**（业务全在这里）：`plugins/*`（npm 包形态，profile 管清单）+ `tabs/<id>/`（**目录即插件**，热重载）

## 先看哪份文档（**不要通读 `docs/`**）

| 要改什么 | 先看 |
|---|---|
| 跑起来 / 装插件 / 写插件 / 目录约定 | `docs/README.md` |
| 插件契约、句柄（`ctx.routes`/`ctx.space`）、决策 D1–D14 | `docs/architecture.md` §4 / §5 / §2 |
| 某个配置该写进哪个文件、入不入库 | `docs/config.md`（五层表） |
| profile 清单字段、`plugins.yml` 为什么不入库 | `profiles/default/README.md` |
| 目录型插件（`tabs/`）怎么写、热到什么程度 | `tabs/README.md` |
| 历史（v1 单体、v2 落地过程） | `docs/archive/` —— **只作来龙去脉参考，别照着实现** |

## 命令

```bash
pnpm dev:host                          # 宿主 :8087（node --watch-path=src）
pnpm dev:web                           # 外壳（vite :5173，代理 /api 与 /plugins）
pnpm build                             # 插件 + 宿主 → dist/host/host.mjs + dist/host/web/
pnpm verify                            # typecheck → smoke → build → contract（日志 .cache/verify/）
pnpm -r typecheck
pnpm plugin list | add | remove | enable | disable | snapshot
```

## 这个环境的坑（都踩过）

- **bash 输出会被吞**：可能产生大量输出的命令（build/typecheck/curl 循环）必须
  `setsid nohup <cmd> > /tmp/x.log 2>&1 < /dev/null &`，然后读 `/tmp/x.log`。
- **后端 dev 不是 `tsx watch`**：cordis 每次启动会重写 `profiles/<name>/.cordis/resolve.mjs`，
  tsx 盯整仓 → 自己写自己看 → 无限重启。用 `node --watch-path=src`（`pnpm dev:host` 已经这么配了）。
- **跨 bash 调用起的后台进程杀不掉**（PID namespace 限制）：验证请"同一次调用内起进程 + kill"，
  或换个空闲端口再起，别指望后面 `kill` 掉它。
- 端口：宿主 `8087`，外壳 vite dev **固定 5173**（`strictPort`，被占就直接失败；换端口用 `COMFYUI_WEB_DEV_PORT`），`/api`、`/plugins` 由它代理到宿主。
- 生产态宿主**自己就能送前端**（`dist/host/web`），不需要 vite；但改了 `apps/web` 要重新 `pnpm build:web`。

## 硬规矩

- 插件后端**不要 `import` cordis 运行时**（宿主已经把 cordis 打进自己的产物，再引一份就是两个实例）；
  插件前端**不要**把 `vue` / `vue-router` 打进 bundle（import map 提供，与宿主同一份）。
- 插件只拿 `ctx.routes` / `ctx.space`（按需 `inject`），**存储形态自管**（SQLite？JSON？随便），
  数据写进 `ctx.space`（→ `data/plugins/<包名>/`），宿主不代管、不迁移、不清理。
- 目录型 tab（`tabs/<id>/`）：**自包含 bundle、无 `node_modules`**、目录名即 id、配置自己持有
  —— 宿主的 `PUT /api/plugins/:id/config` 对它返回 400，`PUT enabled` 只在本次运行期生效。
- **改代码即热重挂**（说明符带 `?v=` 换 URL）：收尾写在 `ctx.effect(() => () => 收尾)`，
  内存状态一律归零，要活下来的写 `ctx.space`。
- `profiles/<name>/plugins.yml` **不入库**（本机部署状态，设置页会重写、注释会丢）；
  要更新基线跑 `pnpm plugin snapshot`，说明写 `profiles/<name>/README.md`。
- 装插件 / 加 tab **不需要重新构建宿主**（`sha256(dist/host/**)` 前后逐字节一致）；这条是方案的核心主张，
  别用"构建期拷贝插件"之类的做法破坏它。
- 前端共享代码放 `packages/shared`（纯类型/常量）。

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
`pnpm verify`；只改 `/tabs` 时至少 `curl -s localhost:8087/api/plugins` 看 phase 与 specifier。
