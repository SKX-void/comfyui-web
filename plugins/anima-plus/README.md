# @comfyui-web/anima-plus —— 文生图工作流

**前后端都在本包里**：12 个表单字段 → 模板渲染 → 显存护栏 → 提交 ComfyUI →
WS 收进度 → SSE 推浏览器 → 取图。不依赖 8086，也不依赖任何外部服务。

<!-- deps:start 由 scripts/gen-deps.mjs 从 template.json 的 requirements 生成；改声明后跑 pnpm --filter @comfyui-web/anima-plus deps:sync -->
依赖 ComfyUI 上装好这些自定义节点包。**地址由模板声明手写**（不用 ComfyUI-Manager 的
推测 —— 它会猜错，且不在 Manager 上的包查不到），机器可读清单见
[`readme.md`](./readme.md)，两者都由 `scripts/gen-deps.mjs` 从声明生成。

插件启动后拿 `/object_info` 对一遍：缺哪个节点、出自哪个包、去哪装，界面直接给出来，
缺依赖时还会拦住生成（不至于提交后才从 ComfyUI 拿到一句 node type not exist）。

| 节点包 | 提供的节点 | 安装地址 |
| --- | --- | --- |
| WeiLin | `WeiLinPromptUIOnlyLoraStack`、`WeiLinPromptUIWithoutLora` | <https://github.com/weilin9999/WeiLin-Comfyui-Tools.git> |
| Danbooru | `SaveImagePlus` | <https://github.com/Aaalice233/ComfyUI-Danbooru-Gallery.git> |
| TeaCache | `AnimaTeaCache` | <https://github.com/CocyNoric/ComfyUI-Anima-TeaCache.git> |
| Enhancer | `AnimaLayerReplayPatcher` | <https://github.com/AdamNizol/ComfyUI-Anima-Enhancer.git> |
| Comfyroll | `CR Text` | <https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes.git> |
| RES4LYF | `ClownsharKSampler_Beta` | <https://github.com/ClownsharkBatwing/RES4LYF.git> |

ComfyUI 自带（缺了说明版本太老，装插件包解决不了）：`CLIPLoader`、`CLIPTextEncode`、`EmptyLatentImage`、`UNETLoader`、`VAEDecode`、`VAELoader`。
<!-- deps:end -->

## 请求链路

```
浏览器 ── /w/anima-plus ──────────────→ 宿主外壳（tab 栏 + 本插件页面）
                 │
                 └─ /api/p/anima-plus/api/... → 本插件的路由（同进程）
                                                  ├─ 模板渲染 + 显存护栏
                                                  ├─ ComfyUI /prompt + /ws
                                                  └─ WeiLin /weilin/*（LoRA/标签）
```

**前端一行没改**：插件的路由挂在宿主的 `/api/p/<插件id>` 前缀下，而插件内部
照旧注册 `/api/*`，所以完整路径与旧服务逐字一致 —— `client/src/api.ts` 的
`API_BASE = '/api/p/anima-plus'` 保持不动就是对的。
（**不要**把它改成空串：那样会请求 `/api/template`、打到宿主源上 404。）

## 目录

```
plugins/anima-plus/
├── server/                 # 后端（从旧服务 apps/server 逐字搬来）
│   ├── index.ts            # 组装根：接线 + 生命周期
│   ├── host.ts             # 宿主句柄的最小类型 + fastify 适配层（createRouteHost / sendError）
│   ├── config.ts           # 本插件的配置（5 个设置项；填错回默认、越界收敛）
│   ├── comfy/              # ComfyUI 客户端：http.ts 传输 · ws.ts 连接/重连 · real.ts 业务方法
│   ├── templates/          # 模板加载 / 渲染 / 值变换（含 seed 随机：-1 → 具体种子）
│   ├── safety/             # 显存护栏 + 配额（limits 规则表 · scan 扫描 · hits 命中 · describe 断言 · effective 边界）
│   ├── jobs/               # 任务编排：manager.ts 状态机 + sweep/finalize/retention/event-bus/asset-id 等
│   ├── weilin/             # LoRA 目录/元数据/缩略图、标签树、翻译（client 入口 + http/normalize/mock/types）
│   │   └── thumb-codec.ts  # 缩略图编解码：纯 JS（purejsimage）、阈值透传、JPEG q74
│   ├── store/              # 插件私有 SQLite（预设）+ 自己的迁移
│   ├── state.ts            # 上次提交的参数快照（last-state.json）：读写 + 原子替换
│   ├── deps.ts             # 依赖检查：工作流要的节点类 vs 上游 /object_info（带缓存）
│   ├── help.ts             # 帮助文档：读包内 readme.md（读不到返回 text:null，界面降级）
│   └── http/routes.ts      # 薄装配层；各域实现在 http/routes/*.ts（含 SSE hijack、/api/deps、/api/help）
├── client/                 # 前端源码：App.vue（只做装配）+ 8 个组件 + composables/（状态与流程）
│   └── src/                # 每个组件的 scoped 样式在同名 .css（`<style scoped src>`），不塞在 .vue 里
├── assets/form.json        # 表单声明（inputs / bindings / outputs / requirements）
├── scripts/
│   ├── build-server.mjs    # esbuild 打包 → lib/server.js
│   ├── gen-deps.mjs        # 从 requirements 生成 readme.md / README 的依赖段
│   └── smoke.ts            # 自检：不需要 ComfyUI/网络（108 项）
├── workflow.json           # 工作流本体（唯一基准，与 package.json 并列）
└── lib/                    # 构建产物：server.js + client.js + client.css
```

> **`workflow.json` 就是唯一基准**（与 `package.json` 并列，`pack.mjs` 按名打包）。
> 表单声明在 `assets/form.json`，它只描述怎么把表单值注入这张图，不再持有图的副本 ——
> 所以不存在"两份图漂移"这种事故。**改图只改 `workflow.json`。**

## 依赖声明与检查

**声明**在 `assets/form.json` 的 `requirements`：

- `nodes`：**不写**，由 loader 从 `workflow.json` 的 `class_type` 推导（手写会漂）。
- `builtin`：ComfyUI 自带（`nodes` / `comfy_extras`），缺了说明版本太老。
- `packs[]`：`{ name, url, provides }`，**地址手写、不查 ComfyUI-Manager**
  （它的"类 → 包"推测会猜错，不在 Manager 上的包也查不到）。

**检查**：`GET /api/deps` 拿上游 `/object_info`（键 = 已注册节点类）对一遍，返回三态：

| `ok` | 含义 | 界面 |
| --- | --- | --- |
| `true` | 齐了 | 界面不提示（要核对清单走顶栏「帮助」） |
| `false` | 确实缺（含缺失节点 → 出自哪个包 → 装它的地址） | 红条 + **禁用「开始生成」** |
| `null` | **没查成**（ComfyUI 不可达） | 黄条「无法确认」，**不拦**提交 |

第三态是刻意的：把"连不上"当成"缺依赖"，会把用户引去装一堆本来就在的包。
提交前的检查也走这份缓存（object_info 约 9MB / 2s，默认缓存 5 分钟、设置页可改，`?refresh=1` 绕过）。

`readme.md` 与本节上方的依赖表都由 `scripts/gen-deps.mjs` 从声明生成
（`deps:sync` 写入、`deps:check` 校验，契约测试会拦下不同步）。

顶栏还有一个 **帮助** 按钮：把包内 `readme.md` 的**原文**渲染出来给使用者看
（`GET /api/help` + 前端一个零依赖的小渲染器 `client/src/md.ts`）。因为"文件即真源"，
`readme.md` 必须在 `package.json` 的 `files` 里（安装态也要读得到）；万一读不到，
面板退化成"按声明实时生成的清单"并说明原因，不留白屏。

## 构建与自检

```bash
pnpm --filter @comfyui-web/anima-plus build       # 后端 esbuild + 前端 vite → lib/
pnpm --filter @comfyui-web/anima-plus smoke       # 纯函数级自检（108 项，含护栏、触发词三态、参数快照回填、提示词整理、配置解析与缩略图转码）
pnpm --filter @comfyui-web/anima-plus typecheck
pnpm --filter @comfyui-web/anima-plus test:contract   # 产物契约（含依赖声明覆盖度、文档同步）
pnpm --filter @comfyui-web/anima-plus deps:sync       # 改过 requirements 后重新生成依赖清单

# 端到端（宿主跑起来、ComfyUI 可达时）
curl -s localhost:8087/api/p/anima-plus/api/system/health
curl -s -X POST localhost:8087/api/p/anima-plus/api/jobs \
  -H 'content-type: application/json' \
  -d '{"values":{"steps":4,"width":512,"height":512}}'
```

前端产物里 `vue` 必须保持**裸说明符**（由外壳页面的 import map 解析）：
`grep -o 'from "vue"' lib/client.js` 应命中。

## 数据（插件私有空间）

按包名分配，路径是 `data/plugins/@comfyui-web+anima-plus/`：

| 路径 | 内容 |
|---|---|
| `anima-plus.sqlite` | 4 类用户预设（`preset_prompt` / `preset_quality_pos` / `preset_quality_neg` / `preset_size`），`PRAGMA user_version` 记迁移版本 |
| `cache/loras-thumbs/` | 缩略图磁盘缓存；键里带引擎 tag（`purejs-jpeg-v1`），换引擎/阈值就换一套，直接删掉即可重建 |
| `last-state.json` | **上次提交的出图参数快照**：每次点「开始生成」覆盖一次（值 = 这次真正提交出去的那一份，含刚抽定的种子），页面加载时回填到表单。删掉 = 回到模板默认值 |

任务列表在**内存**里（与旧服务一致：重启丢历史，产图仍在 ComfyUI 的 output 目录）。
只有手工删掉 `data/plugins/@comfyui-web+anima-plus/` 才会清掉数据（宿主从不代管）。

### 参数快照（`last-state.json`）

「刷新页面就归零」这件事的解法：表单值不再只活在浏览器内存里。

- **写入时机是唯一的一个**：按下「开始生成」。中途改表单、套预设、复用历史参数都**不**写盘 ——
  所以回填出来的永远是"真正跑过的那一套"，而不是"你上次顺手改到一半的草稿"。
- **它不进 `settings.json`**：那是本插件的**配置**（改完要重挂才生效、在设置界面里编辑），
  这是**运行期状态**（随手覆盖、读坏了只该退回模板默认值）。两者生命周期不同，混一个文件里写状态会把配置一起重写。
- **回填有两道过滤**（`client/src/form.ts` 的 `restoreValues`）：只认当前模板还存在的字段；
  且按控件类型验一次 —— 手改过的文件里"字符串住进 switch"这种值宁可退回默认值，也不让界面显示得莫名其妙。
- 读写走 `GET/PUT /api/p/anima-plus/api/state`（`server/state.ts`，先写 `.tmp` 再 rename）。
  存快照失败**不拦出图**，只在运行日志里记一条。

## 配置

插件设置界面里能改的 5 项（值由插件自己持有：`data/plugins/<包名>/settings.json`，
保存后插件请求 `POST /api/tabs/anima-plus/reload` **就地重挂**）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `comfyuiBaseUrl` | `http://localhost:8188` | ComfyUI 地址（HTTP 与 WS 都由它推出）。留空 = 用内置默认值。**本插件不读宿主的「统一 ComfyUI 地址」**（D19：那个值只在宿主设置页里，不下发给插件）；要连别的 ComfyUI 就在这一项里填。只写 `host:port` 会自动补 `http://`。WeiLin 的 `/weilin/*` 路由注册在同一个 ComfyUI 上，所以标签/LoRA 面板跟着它走；ComfyUI 不可达时出图链路整体不可用（不是降级）。 |
| `maxQueueDepth` | `5` | 同一台 ComfyUI 上最多同时排多少条任务（范围 1~16）。8G 卡建议 2~3，24G 卡可以放飞。 |
| `maxJobsRetained` | `200` | 任务列表在内存里保留多少条（范围 10~5000）。 |
| `depsWarmupOnStart` | `true` | 激活时预热一次依赖检查，省掉首屏那次 9MB 拉取。 |
| `depsCacheTtlMinutes` | `5` | 依赖检查缓存时长（范围 0~1440 分钟）。**0 = 每次都重查上游**（约 9MB / 2s），刚在 ComfyUI 装完包时用；界面上的「重新检查」随时能绕过缓存。 |

取值原则是**填错不许炸**：非法值回默认、越界收敛进范围，`GET /api/p/anima-plus/config` 的
`configFiles` 会写明这次的值是从哪儿来的（`内置默认值` / `settings.json: <键>` / `越界已收敛到 N`）。

宿主跑在容器里时 `localhost` 是**容器自己**：同机 Docker 部署要么给容器加
`extra_hosts: host.docker.internal:host-gateway` 后填 `host.docker.internal:8188`，
要么直接填局域网地址（compose 现在没开 host 网络）。

## 缩略图

LoRA 预览图与产出图都走服务端缩略图，编解码是**纯 JS**（`purejsimage`，零原生模块，
所以能打进单文件 `lib/server.js`）。

**只在划算时转**（判定在 `server/weilin/thumb-codec.ts` 的 `shouldPassThrough`）：

| 输入 | 行为 |
|---|---|
| 源 ≤128KB 且边长 ≤ 目标 ×2 | 直接透传原图 —— 库里那些已预缩过的 20~30KB WebP 预览图走这条，**零 CPU** |
| 其余（新加的 LoRA、ComfyUI 产出图） | 解码 → `cover` 居中裁到 `w`×`h` → **JPEG progressive q74** |
| 源 >24MB / 格式不支持 / 解码失败 | 回退原图直出，**绝不 500** |

实测（ARM64 弱主机，3072×2048 PNG → 256×342）：

| 输出 | 耗时 | 产物 | RSS 增量 |
|---|---:|---:|---:|
| **JPEG q74（现用）** | 474 ms | 30 KB | +14 MB |
| WebP q74（对比后弃用） | 566 ms | 42 KB | +45 MB |

转码期间事件循环最长只阻塞 32 ms（编解码器内部按行/分块 `await`），**不需要 worker 线程**，
宿主界面与出图进度不会顿。

- 路由：`/api/loras/thumb?file=&w=&h=`、`/api/assets/:id/thumb?w=&h=`
- 磁盘缓存：`cache/loras-thumbs/`；键里带引擎 tag（`RESIZER_TAG`）——
  **换引擎/阈值/输出格式必须改 tag**，否则会复用旧缓存
- 排障：`GET /api/loras/thumb/stats` → 缓存统计 + `engine` / `quality` / `transcoded` / `passthrough` / `failed` / `lastError`
- 清缓存：删掉 `cache/loras-thumbs/` 即可（按需重建）
- 离线脚本 `scripts/resize-lora-previews.py` 从「必须」降为**可选**（老库想省 CPU 可以继续用）

## 与旧服务的关系（迁移记录）

旧 `apps/server`（端口 8086）的 14 个模块被**逐字**搬进 `server/`，
只改了四处（都不是业务逻辑）：

1. **`store/db.ts` 零改动**：它本来就只接受一个文件路径，改成传空间里的路径即可。
2. **`comfy/real.ts` 零改动**：仍然用 `ws` 包（打包时 bundle 进产物）。
3. **SSE 加 1 行**：`server/http/routes/jobs.ts` 里 SSE 前 `reply.hijack()`。宿主只用**一条** `/api/p/*`
   兜底路由接住所有插件请求，所以必须显式告诉 fastify「这个响应我自己写」。
4. **错误映射移到适配层**：旧服务在 fastify 的 `setErrorHandler` 里把 `AppError`
   映射成 404/413/422/429/502/503；插件不能碰宿主的全局错误处理，所以 `server/host.ts`
   造了一个"假 fastify"包住每个 handler —— 顺带让 462 行的路由表**原样可用**
   （`app.get<{Params…}>` 的泛型运行期不存在，适配层把它吃掉）。

后端之所以要打包（anima-example 也打包，区别只在它没有第三方依赖）：逐字搬运 2800 行比照着重写安全，
打包让这些文件保持原状（`.ts` + `.js` 后缀的相对导入），一行都不用为了"免构建"而改。

用户预设是从旧库 `data/comfyui-server.db` 迁过来的（1 条正向提示词 + 2 条宽高对），
迁移走的是插件自己的 `PUT /api/presets/:kind/:name`，没有直接写表。

## 已知取舍

- **没有原生模块**：缩略图用纯 JS 的 `purejsimage`（`.node` / wasm 都进不了单文件产物）。
  代价是转码慢一些，但只在「划算」时才转、且转一次就长期缓存 —— 详见下面的「缩略图」一节。
- **能力（comfy / weilin / jobs / quota）没有拆成独立包**：D19 之后不存在"库形态插件"，
  宿主也只 provide `routes` 与 `space` 两个句柄 —— 跨插件只有 HTTP 路由一条路。
  模块边界按旧服务的目录原样保留；将来要复用就抽成共享源码包、**构建时 bundle** 进各插件产物。
- **`safety/` 是唯一的安全收口**（`limits.ts` 规则表 · `scan.ts` 扫描/夹紧 · `describe.ts` 出口断言 ·
  `effective.ts` 生效边界）：改模板/加字段之后务必跑 `smoke`，
  里面 12 项断言专门盯护栏（越界拒绝、夹紧、数量超限、取值不明 fail closed）。
