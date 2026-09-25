# @comfyui-web/anima-example —— 默认Anima

**第一个「真」插件**：后端逻辑住在插件里，不反代任何旧服务。

工作流是插件自带的 `workflow.json`（11 个**原生**节点，不依赖任何自定义节点包），
源自仓库里那份 `workflow/anima.simple.json` —— 那个目录已经随旧服务一起删了。
插件是安装单元，不能去引用插件目录之外的文件，所以它自带一份。

它比 `anima-plus` 简单：只有 9 条路由、上游节点全是原生的。
`anima-plus` 现在也是"后端逻辑住在插件里"的，区别在于它带着一整套 v1 资产
（模板/渲染/显存护栏/LoRA/标签/预设，2800 行）。

## 一条链路

```
浏览器表单
   │  POST /api/p/anima-example/jobs      {description, positive, negative, steps, cfg, seed, 尺寸, LoRA…}
   ▼
插件 server.js
   │  ⓪ 拼接提示词：描述词 + ", " + 正向词 → 写进正向 CLIPTextEncode
   │  ① 把表单值写进 workflow.json 的图（derive 出来的节点号）
   │  ② POST {comfyui}/prompt            → prompt_id
   │  ③ 订阅 {comfyui}/ws                → execution_start / progress / executing / executed
   │  ④ GET  {comfyui}/history/<id>      → 产出图清单
   │  ⑤ GET  {comfyui}/view?…            → 图片字节（原样落盘，不重编码）
   ▼
data/plugins/@comfyui-web+anima-example/   ← 核只给这一个目录，里面全由插件安排
  ├─ anima-example.sqlite                 作业与产出记录（自建库 + PRAGMA user_version）
  └─ images/<jobId>/<idx>.png             图片（用户资产，谁都不许自动清）
   │  SSE  /api/p/anima-example/jobs/:id/events
   ▼
浏览器进度条 → 结果图
```

## 三个提示词框与拼接

| 表单 | 默认值 | 说明 |
|---|---|---|
| **描述提示词**（主输入框） | 空（占位符给个示例） | 画什么。工作流里那串文本是质量/风格词，不适合塞在这里，所以留空 |
| **正向提示词**（折叠） | 工作流自带的正向文本 | 质量 / 风格串，与负向提示词的默认来源对称 |
| **负向提示词**（折叠） | 插件设置 `negativePrompt` | 原样写入负向节点 |

两边**手工拼接**成一个字符串后才写进正向 `CLIPTextEncode`：

```
拼接结果 = 描述词 + ", " + 正向词
```

- 拼接发生在**后端**（`server.js` 的 `joinPrompt()`），因为它和"改图"是同一件事，且
  API 直接调用时也走同一条规则；前端只做**同样规则的预览**（`App.vue` 的 `joinedPrompt`），
  让你在提交前就能看到真正发出去的那串文本。**两处必须同步改**。
- 拼接前会清掉两侧的空格与逗号：工作流自带的正向文本末尾就有一个逗号，
  直接连会出现 `, ,`。
- 两个框可以只填一个，但不能同时为空（否则 400）。
- 库里 `description` 与 `positive` **分开存**，所以历史记录能把两个框分别回填。

## 绑定：一个节点号都没写死

表单字段要落到哪个节点，是**从图里推导**出来的（`resolveBindings()`）：

| 字段 | 怎么找到 |
|---|---|
| 正向文本（描述词+正向词拼接后） | `KSampler` 节点 → 顺着 `inputs.positive` 的连线找到上游 `CLIPTextEncode`，写入它的 `text` |
| 负向提示词 | `KSampler` 节点 → 顺着 `inputs.negative` 的连线找到上游 `CLIPTextEncode` |
| 宽高 / 批量 | `KSampler.inputs.latent_image` → 若是 `LatentRotate` 再往上游一层 → `EmptyLatentImage` |
| 旋转 | 上面那条链上的 `LatentRotate` |
| LoRA | `KSampler.inputs.model` 往上游找第一个 `LoraLoader` |
| 模型 | 按 `class_type` 找 `UNETLoader` / `CLIPLoader` / `VAELoader` |
| 采样参数 | `KSampler` 自身的 `seed/steps/cfg/sampler_name/scheduler` |

所以在 ComfyUI 里拖动节点、重新导出、甚至换成同构的另一个工作流，这里都不会失效。
`GET /options` 会把推导结果（`bindings`）一起返回，排障时一眼能看到哪根线接错了。

解析失败时 `apply()` 直接抛错 —— 宿主会把插件标成 broken 并显示原因，
比带着半个坏绑定跑出一张废图强。

## 表单下拉的选项从哪来

全部来自 ComfyUI 自己的 `GET /object_info`（缓存 60 秒），不写死枚举：

- `UNETLoader.unet_name` / `CLIPLoader.clip_name` / `VAELoader.vae_name` / `LoraLoader.lora_name`
- `KSampler.sampler_name` / `KSampler.scheduler`
- `LatentRotate.rotation`

拉不到也不影响用：下拉变空，表单退回工作流里的当前值，照样能提交。
服务端**按同一份列表校验**（`validate()`）：越界或不在枚举里的值直接 400，
不会把一个非法值打到 GPU 上。

## 接口

前缀由宿主统一加：`/api/p/anima-example`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/options` | 下拉选项 + 工作流默认值 + 绑定表 |
| GET | `/status` | ComfyUI 版本/设备/队列 + WS 连接状态 |
| POST | `/jobs` | 提交作业（body: `description` / `positive` / `negative` / `steps` / `cfg` / `seed` / `width` / `height` / `batch` / `sampler` / `scheduler` / `rotation` / `lora` / `loraStrength` / `unet` / `clip` / `vae`）→ `{jobId, promptId, status}`。旧字段名 `prompt` 仍接受，等价于 `description` |
| GET | `/jobs?limit=` | 历史（内存里的在跑作业优先于库里的记录） |
| GET | `/jobs/:id` | 单个作业 |
| GET | `/jobs/:id/events` | **SSE**：`snapshot → started → progress… → node… → completed/error/canceled` |
| POST | `/jobs/:id/cancel` | 排队中→从队列删；在跑→`/interrupt` |
| DELETE | `/jobs` | 清空记录（**不动** `buffer.files` 里的图片） |
| GET | `/assets/:jobId/:idx` | 产出图（`?download=1` 加下载头） |

SSE 是**连接即发 snapshot**，所以断线重连不需要回放历史；终态时服务端主动关流，
前端收到终态事件必须自己 `close()`，否则 `EventSource` 会自动重连成死循环。

## 数据

库是**插件自己建的**，就放在自己的空间里（`anima-example.sqlite`）：

| 表 | 内容 |
|---|---|
| `jobs` | 作业 + 全部参数 + `prompt_id` + 状态 + 错误 |
| `assets` | 产出图：`job_id, idx, file, mime, bytes`（`file` 是**相对空间根**的路径） |

表名不加前缀，版本用 `PRAGMA user_version`，迁移数组写在 `server.js` 里（只追加不回改）。
`assets` 对 `jobs` 有真外键（`ON DELETE CASCADE`）。卸载 = 把 `tabs/anima-example/` 目录删掉；
数据留在 `data/plugins/@comfyui-web+anima-example/`，宿主不代管 —— 要删自己删。

图片落在空间里的 `images/<jobId>/`。**没有任何自动清理** ——
那是用户资产。清空历史只删记录，不删文件。

## 配置

`package.json` 的 `plugin.settings[]` 只是**元数据**（字段形状）；值由插件自己持有
（`data/plugins/<包名>/settings.json`，见 `settings.ts`），在插件自己的设置界面里改，
存完由插件请求 `POST /api/tabs/anima-example/reload` 就地重挂：

| key | 默认 | 说明 |
|---|---|---|
| `comfyuiBaseUrl` | `http://localhost:8188` | ComfyUI 地址（HTTP 与 WS 都由它推出）。留空 = 用内置默认值。**本插件不读宿主的「统一 ComfyUI 地址」**（D19：那个值只在宿主设置页里，不下发给插件）；要连别的 ComfyUI 就在这一项里填 |
| `negativePrompt` | 工作流里的负向词 | 表单初始值，留空即不预填 |
| `defaultSteps` / `defaultCfg` | 6 / 1 | 表单初始值 |
| `defaultWidth` / `defaultHeight` | 832 / 1216 | 表单初始值 |
| `historyLimit` | 50 | 列表默认取多少条 |

## 换成别的工作流

1. 把新工作流（ComfyUI 的 **API 格式**，不是界面导出的 workflow 格式）放到
   `plugins/anima-example/workflow.json`；
2. 重启宿主。绑定是推导的，只要节点类型是上面那套，一行代码都不用改；
3. 若新图里没有 `LatentRotate` / `LoraLoader`，对应表单项会自动隐藏
   （`hasRotateNode` / `hasLoraNode`）。

`GET /options` 的 `bindings` 字段会告诉你每根线接去了哪个节点。

## 安全护栏

参考实现也要有护栏 —— 从这份样板抄走的，不该是一个能把 200 步 / 4096×4096 直接打到
GPU 上的裸奔版本。ComfyUI 不会替你拦，显存打满就是整个队列卡死（见 `plugins/anima-plus/docs/safety.md`）。

| 参数 | 上下限 | 说明 |
|---|---|---|
| 步数 | 1 ~ **32** | 弱主机上步数是最容易把一次出图拖到几分钟的旋钮 |
| 宽 / 高 | 64 ~ **1216** | 工作流自带的 832×1216 正好压在上限；再大就该上放大/分块，而不是硬出 |
| CFG | 0 ~ 30 | |
| 批量 | 1 ~ 8 | |
| 提示词长度 | ≤ 8000 字符 | |

上下限常量只有一份（`server.js` 末尾的 `SAFETY`），三道闸都用它：

1. **请求校验**：越界直接 **400**（`INVALID_INPUT`），**不夹紧** —— 静默改小会让用户
   以为出的是自己要的那张图。
2. **设置默认值收敛**：设置里配的 `defaultSteps` / `defaultWidth` / `defaultHeight`
   超界会被收敛到边界并打日志；否则"不传参数"就绕过了上限。
3. **提交前看图**：`assertGraphSafe()` 不看请求，只查**真正要发出去的图**，
   拦得住工作流模板自带的数值和以后改坏的绑定；越界返回 400（`UNSAFE_GRAPH`）。

上下限随 `GET /options` 一起下发，前端把输入框的 `min`/`max` 直接绑上
（尺寸快捷预设也都落在界内）。

## 构建与验证

```bash
pnpm --filter @comfyui-web/anima-example build          # → lib/client.js + lib/client.css
pnpm --filter @comfyui-web/anima-example typecheck      # vue-tsc
pnpm --filter @comfyui-web/anima-example test:contract  # 产物契约测试（无浏览器时用）
```

后端不加构建步骤：`server.js` 是纯 ESM，宿主直接 import。它**只 import node 内置模块**，
不 import cordis —— 宿主已经把 cordis 打进自己的产物，插件再引一份就是两个实例。
WebSocket 用的是 node 自带的全局 `WebSocket`，所以本插件没有任何运行时依赖。
