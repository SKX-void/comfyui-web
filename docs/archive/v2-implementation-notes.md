# 实施记录：v2 第一批落地（历史）

> ⚠️ **历史文档**：这是从 [`architecture.md`](../architecture.md) 拆出来的**落地过程记录**
> （三步交付计划、14.1b–14.1h 每条的来龙去脉、当时的实测证据）。结论已经并入主文档 §11–§14，
> 本文只回答"当时为什么这么做、怎么验证的"。编号沿用当时主文档 §14 的编号。

---

## 交付计划（当时全文）

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

## 实施过程

### 14.1 三处实施期偏离

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

---

## 验收证据（当时实测）

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
