# comfyui-web

## 项目说明

在agent时代，将ComfyUI工作流开发为前端页面不再是一项费时费力的不划算工程。 
工作流一旦搭建完毕，一般不会经常更改，此事主要精力都聚焦在ai出图上。 
将工作流编写为前端页面，走api调用，ai就可以轻松增加各种辅助功能，这比编写改动ComfyUI插件轻松多了。 
意外之喜，项目结构使用Vue3构建为前端单网页应用，解决了手机等弱主机浏览器环境下，ComfyUI难以加载的问题。 
所以我设计了以下软件架构，并让ai负责实现。我的架构思路见[架构思路](./架构思路.md)。 

## 介绍

ComfyUI 的**轻前端 + 工作流插件宿主**：用一个网页表单调用 ComfyUI 出图，业务逻辑全部住在插件里。

| 角色     | 位置              | 干什么                 |
| -------- | --------------- | ---------------- |
| **宿主** | `apps/server/`（:8087）                | 只做框架：装载插件、按前缀分发路由、托管前端产物、提供设置页。**自己不含业务功能**                                               |
| **外壳** | `apps/web/`                            | tab 栏 + 插件页面 + 设置页；Vue 由 `index.html` 的 import map 提供                                                               |
| **插件** | `tabs/<id>/`（源码在 `plugins/<id>/`） | 全部业务。**插件 = `tabs/<id>/`**（目录即插件，宿主唯一装载来源）；`plugins/*` 是它的源码工程，`pnpm build:plugins` 写进 `tabs/` |

## 跑起来

```bash
pnpm install

# 开发态
pnpm dev                                  # 一条命令：先 build:plugins 垫一次产物，再起宿主 + 外壳
pnpm dev:host                             # 宿主 :8087（tsx watch，改 src/ 自动重启）
pnpm dev:web                              # 外壳（vite :5173，把 /api 与 /plugins 代理到后端）
pnpm dev:plugins                          # 插件产物 watcher（改 plugins/* 源码边写边出 tabs/）

# 生产态：构建出完整可搬的 dist/
pnpm build                                # → dist/app/server.mjs + dist/app/web/ + dist/tabs/ + dist/data/
node dist/app/server.mjs                  # 一个进程同时提供 API 与前端
```

打开 `http://127.0.0.1:8087`。没装插件时只有一个欢迎页和设置页 —— 这是设计如此。

装插件 = 把编译好的目录放进 `tabs/<id>/`（**目录名即 id**），然后在设置页点一次
「重新扫描插件目录」—— 宿主**不监听**目录，装载只发生在启动与这次点击（D20）。
**不需要重新构建宿主**（验收口径：`sha256(dist/app/**)` 前后逐字节一致）：

```bash
pnpm build:plugins            # 插件源码（plugins/<id>/）→ tabs/<id>/
# 手写 tab：直接把目录丢进 tabs/，没有构建这一步（见 tabs/README.md）
```

## 文档

| 想知道                                           | 看                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| 怎么跑、怎么装插件、怎么自己写一个插件、目录约定 | **[`docs/README.md`](docs/README.md)**（唯一入口）                |
| 架构与决策（D1–D21）、插件契约、句柄 API         | [`docs/architecture.md`](docs/architecture.md)                    |
| 十几个"配置"文件分别属于哪一层、谁能改、入不入库 | [`docs/config.md`](docs/config.md)                                |
| 目录型插件（`tabs/`）怎么用、热到什么程度        | [`tabs/README.md`](tabs/README.md)                                |
| 某个插件的设置项与内部结构                       | 那个插件自己的 `README.md`                                        |
| v1 单体时代的文档、v2 落地过程记录               | [`docs/archive/`](docs/archive/README.md)（**历史，别照着实现**） |

> **用智能体开发这个仓**：先让它读 [`AGENTS.md`](AGENTS.md) —— 命令、环境坑、硬规矩、文档纪律都在那一页，
> 不必通读 `docs/`。

## 自检

```bash
pnpm verify          # typecheck + 构建 + 冒烟；日志与产物在 .cache/verify/
pnpm -r typecheck
```
