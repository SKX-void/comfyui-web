# API 契约

> ⚠️ **历史文档（v1 单体时代）**：描述的是已被取代的单体服务与当时的规划，只作来龙去脉参考，**不要照着实现**。现行文档索引见 [`docs/README.md`](../README.md)。
> 上游文档：[计划](./v1-plan.md) · [单体架构](./v1-architecture.md)

本文分两部分：
- **Part A**：本服务器**对外**（给 SPA）的 API —— 我们自己的契约
- **Part B**：本服务器**对内**（调 ComfyUI）的规范 —— 上游契约与注意事项

---

# Part A — 对外 API

Base URL：`http://127.0.0.1:8080/api`
所有响应：`application/json`，错误统一格式（见 A.6）。

## A.1 模板

### `GET /api/templates`

列出可用模板（供首页/下拉）。

```jsonc
{
  "items": [
    {
      "id": "txt2img-basic",
      "name": "基础文生图",
      "description": "单模型 + 提示词 + 出图",
      "thumbnail": "/api/templates/txt2img-basic/thumb",
      "version": "1.0.0"
    }
  ]
}
```

### `GET /api/templates/:id`

取模板完整定义，**含输入 schema**，前端据此渲染动态表单。

```jsonc
{
  "id": "txt2img-basic",
  "name": "基础文生图",
  "version": "1.0.0",
  "inputs": [
    {
      "key": "prompt",
      "label": "正向提示词",
      "type": "tag-selector",
      "required": true,
      "default": "",
      "ui": { "rows": 6, "placeholder": "输入提示词" }
    },
    {
      "key": "negative",
      "label": "负向提示词",
      "type": "textarea",
      "required": false,
      "default": "lowres, bad anatomy"
    },
    {
      "key": "unet_name",
      "label": "模型",
      "type": "model-select",
      "required": true,
      "source": { "kind": "comfy", "folder": "diffusion_models" }
    },
    {
      "key": "loras",
      "label": "LoRA",
      "type": "lora-select",
      "required": false,
      "default": [],
      "ui": { "multiple": true, "max": 5 }
    },
    {
      "key": "seed",
      "label": "种子",
      "type": "seed",
      "required": false,
      "default": -1
    }
  ],
  "presets": { "autoRandom": false }
}
```

> `inputs[].type` 取值见 [单体架构](./v1-architecture.md) §4.2。
> `source` 描述选项数据来源，前端按 `kind` 调对应接口。

## A.2 数据源（标签 / LoRA / 模型）

> 这一组是 **WeiLin 适配层** 的对外出口，内部转发到 `/weilin/prompt_ui/api/*`。
> 详见 [weilin.md](../../plugins/anima-plus/docs/weilin.md)。

### `GET /api/loras/browse`

**LoRA 目录浏览**。一次只返回**一层**：当前目录的直属 LoRA + 可进入的子目录。

> 刻意**不提供搜索**，也**不递归**子目录 —— 由子目录逐层进入。
> 这样每层响应都是 KB 级，且符合"只加载当前目录内容"的预期。
> 注意子目录的 `count` 是**直属**数量，不含更深层。

```jsonc
// query: ?path=Anima        （省略或空表示根目录）
{
  "path": "Anima",
  "breadcrumbs": [
    { "name": "全部", "path": "" },
    { "name": "Anima", "path": "Anima" }
  ],
  "folders": [
    { "path": "Anima\\画师", "name": "画师", "count": 31 },
    { "path": "Anima\\人物", "name": "人物", "count": 14 }
  ],
  "items": [
    {
      "name": "Anima\\Anima Turbo LoRA-v0.2",
      "lora": "Anima\\Anima Turbo LoRA-v0.2.safetensors",
      "displayName": "Anima Turbo LoRA-v0.2",
      "folder": "Anima"
    }
  ],
  "total": 1
}
```

> 触发词与预览图不在列表里返回（单条 71KB），选中后再查
> [`GET /api/loras/meta`](#)。
> 列表里的缩略图走 [`GET /api/loras/thumb`](#)。

### `GET /api/loras/thumb`

**服务端生成的 LoRA 预览缩略图。**

> 为什么必须服务端做：WeiLin 的预览图是原始尺寸 —— 实测单张 1664×2432 PNG = **4.87 MB**。
> 一个 31 个 LoRA 的目录若直接下发就是上百 MB。
> 缩到 80~112px WebP 后约 **1.8 KB/张**（整目录 55 KB）。

```jsonc
// query: ?file=Anima%5C画师%5Ctaffy-style.safetensors&w=180&h=240
// 200 → image/webp（带 Cache-Control: max-age=604800, immutable）
// 204 → 该 LoRA 没有预览图，前端显示占位块
```

| 参数 | 说明 |
|------|------|
| `file` | LoRA 完整路径（含扩展名），必填 |
| `w` | 目标宽，默认 112，范围 32–640 |
| `h` | 目标高，省略则等于 `w`（正方形），范围 32–640 |

> **支持非正方形是有意设计**：LoRA 预览图多为竖构图（实测 1664×2432 ≈ 2:3），
> 一律切成正方形会丢掉大半画面。卡片式列表用 `w=180&h=240`（3:4）。

> **v2 现状**：缩略图实现已换 —— 纯 JS `purejsimage`（无原生模块）+ 「只在划算时转」的
> 阈值透传 + JPEG progressive q74，缓存键里带引擎 tag。见 `plugins/anima-plus/README.md`
> 的「缩略图」与 `docs/architecture.md` §14.1g。

实现要点：
- （v1 计划）`sharp` 解码 + `position: 'attention'`（人像图裁剪偏向主体）
- 磁盘缓存 `<repo>/.cache/loras-thumbs/<sha1(file|WxH)>.webp` —— key 含尺寸
- 同一 LoRA 的并发请求会合并，避免重复解码 5 MB 原图
- 判断"有无预览图"不能只看 HTTP 状态码：WeiLin 无图时返回的是
  `200 + JSON`（`{"status":"404",...}`），需检查 content-type

### `GET /api/tags`

标签检索，支持分页与搜索。

```jsonc
// query: ?q=blue+hair&groupId=&page=1&pageSize=50
{
  "items": [
    {
      "id": 1234,
      "tag": "blue hair",
      "translate": "蓝色头发",
      "groupId": 12,
      "groupName": "发型",
      "count": 98234,
      "previewUrl": "/api/tags/1234/preview"
    }
  ],
  "total": 4512
}
```

### `GET /api/tags/autocomplete?q=blu`

轻量补全接口，前端输入时调用（对应 WeiLin `prompt/fast/autocomplete`）。

```jsonc
{ "items": [{ "tag": "blue hair", "translate": "蓝色头发" }] }
```

### `GET /api/models?folder=diffusion_models`

模型枚举（对应 ComfyUI `/models/{folder}`）。

```jsonc
{ "items": ["Anima\\model_v23.safetensors"] }
```

### `POST /api/tags/translate`

```jsonc
// req
{ "texts": ["blue hair", "smirk"] }
// res
{ "items": [{ "source": "blue hair", "target": "蓝色头发" }] }
```

### `GET /api/tags/random-template`

列出随机提示词模板（对应 WeiLin `random_template/get_template_list`）。

## A.3 任务

### `POST /api/jobs`

提交一次生成。

```jsonc
// req
{
  "templateId": "txt2img-basic",
  "values": {
    "prompt": "1girl, solo, blue hair",
    "negative": "lowres",
    "unet_name": "Anima\\model_v23.safetensors",
    "loras": [
      { "name": "Anima\\style_v2.safetensors", "weight": 0.8, "clipWeight": 0.8 }
    ],
    "seed": -1
  },
  "options": { "autoRandom": false, "clientToken": "web-1" }
}
```

```jsonc
// res 202
{
  "jobId": "j_01HXYZ...",
  "promptId": "8f3a...",          // ComfyUI 侧
  "status": "queued",
  "queuePosition": 2,
  "createdAt": "2026-09-18T16:00:00Z"
}
```

错误情况：
- `400` 参数校验失败（含字段级错误）
- `422` 渲染后 graph 未通过 `/object_info` 校验
- `503` ComfyUI 不可达 / 显存不足

### `GET /api/jobs`

```jsonc
// query: ?status=&page=1&pageSize=20&templateId=
{
  "items": [
    {
      "jobId": "j_01HXYZ...",
      "templateId": "txt2img-basic",
      "status": "succeeded",
      "progress": { "value": 20, "max": 20, "node": "19" },
      "createdAt": "...",
      "finishedAt": "...",
      "assets": [{ "assetId": "a_...", "url": "/api/assets/a_.../raw", "width": 832, "height": 1216 }]
    }
  ],
  "total": 42
}
```

### `GET /api/jobs/:jobId`

同上单条。任务值快照：`"values": {...}`，便于"复用参数"。

### `GET /api/jobs/:jobId/events`（SSE）

**核心进度通道**。

```
Content-Type: text/event-stream

event: snapshot
data: {"status":"running","progress":{"value":3,"max":20}}

event: progress
data: {"value":4,"max":20,"node":"19"}

event: node
data: {"node":"21","displayNodeId":"21","title":"保存图像"}

event: completed
data: {"status":"succeeded","assets":[{"assetId":"a_...","url":"/api/assets/a_.../raw"}]}

event: error
data: {"code":"EXECUTION_FAILED","message":"...","node":"19"}
```

事件类型：`snapshot` · `queued` · `started` · `progress` · `node` · `completed` · `error` · `canceled`

行为约定：
- 连接即发 `snapshot`（断线重连可恢复，**无需回放**）
- 任务已终态时发 `snapshot` 后立即发对应终态事件并关闭
- 心跳：每 15s 发注释行 `:ping`

### `POST /api/jobs/:jobId/cancel`

```jsonc
// res 200
{ "jobId": "j_...", "status": "canceled" }
```

> 内部：若该任务正在执行 → ComfyUI `/interrupt`；若仍在队列 → 从 `/queue` 移除。

### `DELETE /api/jobs/:jobId`

删除记录（若在队列中则一并取消）。

## A.4 资源（图片）

### `GET /api/assets/:assetId/raw`

返回图片二进制。内部代理 ComfyUI `/view`。
支持 `?thumb=1` 返回缩略图（服务器缓存）。

### `GET /api/assets/:assetId/meta`

```jsonc
{
  "assetId": "a_...",
  "jobId": "j_...",
  "filename": "anima_00042_.png",
  "subfolder": "",
  "type": "output",
  "width": 832, "height": 1216,
  "bytes": 1234567,
  "sha256": "...",
  "createdAt": "..."
}
```

### `POST /api/uploads`

上传图片（img2img / 参考图）。

- `multipart/form-data`，字段 `file`，可选 `subfolder`、`overwrite`
- 内部转发 ComfyUI `/upload/image`
- 返回 `{ "name": "...", "subfolder": "", "type": "input" }`

## A.5 系统

### `GET /api/system/health`

```jsonc
{
  "server": "ok",
  "comfyui": { "reachable": true, "version": "0.36.0" },
  "weilin": { "available": true, "version": "..." },
  "ws": { "connected": true }
}
```

### `GET /api/system/stats`

代理 ComfyUI `/system_stats`：显存、设备、队列长度。

### `GET /api/system/queue`

```jsonc
{
  "running": [{ "promptId": "...", "jobId": "j_..." }],
  "pending": [{ "promptId": "...", "jobId": "j_..." }]
}
```

## A.6 错误格式

```jsonc
{
  "error": {
    "code": "TEMPLATE_VALIDATION_FAILED",
    "message": "字段 seed 必须是整数",
    "details": [{ "path": "values.seed", "message": "Expected integer" }],
    "requestId": "req_..."
  }
}
```

| code | HTTP | 含义 |
|------|------|------|
| `BAD_REQUEST` | 400 | 请求体不合法 |
| `TEMPLATE_NOT_FOUND` | 404 | 模板不存在 |
| `TEMPLATE_VALIDATION_FAILED` | 422 | 值不符合输入 schema |
| `GRAPH_VALIDATION_FAILED` | 422 | 渲染后 graph 未通过校验 |
| `JOB_NOT_FOUND` | 404 | 任务不存在 |
| `COMFYUI_UNREACHABLE` | 503 | 上游不可达 |
| `COMFYUI_ERROR` | 502 | 上游返回错误 |
| `EXECUTION_FAILED` | 200(SSE) | 执行期错误（通过 SSE 下发） |
| `WEILIN_UNAVAILABLE` | 503 | WeiLin 接口不可用 |

---

# Part B — 对 ComfyUI 的调用规范

## B.1 提交任务

```
POST http://127.0.0.1:8188/prompt
Content-Type: application/json
```

```jsonc
{
  "prompt": { /* 完整 graph，node_id -> {inputs, class_type, _meta} */ },
  "client_id": "uuid-v4",
  "extra_data": {
    "extra_pnginfo": { "workflow": { /* 可选，回填到 PNG */ } }
  }
}
```

响应：`{ "prompt_id": "...", "number": 3, "node_errors": {} }`

**注意**：`node_errors` 非空时表示部分节点校验失败，需映射为 `GRAPH_VALIDATION_FAILED`。

## B.2 WebSocket（**ComfyUI 无 SSE**）

```
ws://127.0.0.1:8188/ws?clientId=<uuid>
```

> 已确认：ComfyUI **只提供 WebSocket**，全仓库无 `text/event-stream`。
> 服务器侧必须用 WS 连上游，再用 SSE 转发给浏览器。

消息信封：`{ "type": "<event>", "data": {...} }`

| type | data | 映射到领域事件 | 投放目标 |
|------|------|----------------|----------|
| `status` | `{status:{exec_info:{queue_remaining}}, sid}` | `snapshot` | 广播 |
| `execution_start` | `{prompt_id}` | `started` | 广播 |
| `execution_cached` | `{nodes:[]}` | （忽略/记录） | 广播 |
| `executing` | `{node, prompt_id}` | `node`（`node=null` 表示结束） | 广播 |
| **`progress`** | `{value, max, prompt_id, node}` | `progress` | ⚠️ **仅提交者** |
| **`progress_state`** | `{prompt_id, nodes:{<id>:{value,max,state,...}}}` | `progress` | ⚠️ **仅提交者** |
| `executed` | `{node, output:{images:[...]}, prompt_id}` | 收集输出 | 广播 |
| `execution_error` | `{prompt_id, node_id, exception_message, traceback}` | `error` | 广播 |
| `execution_interrupted` | `{prompt_id, node_id}` | `canceled` | 广播 |

### ⚠️ 两个必须注意的坑

**坑 1：进度只投递给提交者。**
`progress` / `progress_state` 通过
`send_sync(..., server_instance.client_id)` 发送（`main.py:436`、`progress.py:184`），
`client_id` 是**提交该 prompt 的那个客户端**。

→ **服务器必须用提交 `/prompt` 时的同一个 `client_id` 去连 `/ws`**，否则收不到任何进度。

**坑 2：其余事件是广播。**
`status`/`executing`/`executed` 等对所有 sid 可见，
所以**仍必须用 `prompt_id` 过滤**出属于自己的任务，不能假设"我连了就是我的"。

### 进度事件选型建议

- **优先用 `progress`**：`{value, max}` 直接对应"第 n / m 步"，是进度条的标准数据源。
- 需要**多节点/多阶段**进度（如放大 + 采样）时，用 `progress_state` 的 `nodes` 映射。
- 上游有节流：`PROGRESS_THROTTLE_MIN_INTERVAL=0.1s`、`MIN_PERCENT=0.5%`；
  首帧/末帧/带预览**立即发送**。
- 上游可能推送**预览图**（二进制帧 `BinaryEventTypes.PREVIEW_IMAGE_WITH_METADATA`）；
  如需"边画边看"，服务器要把二进制帧转成 base64 经 SSE 下发。**v1 可选**。

## B.3 取历史与产出

```
GET /history/{prompt_id}
```

```jsonc
{
  "<prompt_id>": {
    "prompt": [0, "<prompt_id>", { /* graph */ }, { /* extra_data */ }, ["21"]],
    "outputs": {
      "21": { "images": [{ "filename": "anima_00042_.png", "subfolder": "", "type": "output" }] }
    },
    "status": {
      "status_str": "success",
      "completed": true,
      "messages": [["execution_start", {...}], ["execution_success", {...}]]
    }
  }
}
```

## B.4 取图片

```
GET /view?filename=anima_00042_.png&subfolder=&type=output
```

服务器应：
- 校验 `filename` 不含路径穿越（`..`、绝对路径）
- 可选缓存缩略图到本地

## B.5 上传图片

```
POST /upload/image      (multipart)
POST /upload/mask       (multipart)
```

## B.6 节点定义（用于校验与动态选项）

```
GET /object_info              # 全量，通常数百 KB —— 服务器缓存
GET /object_info/{node_class} # 单个
```

用途：
1. 校验渲染后 graph 的字段名/类型/必填
2. 生成 `model-select` 的候选项（从 `enum` 或 `folder_paths` 来源推断）
3. 探测 WeiLin 节点是否已加载（`WeiLinPromptUIWithoutLora` 是否存在）

## B.7 其它

| 端点 | 用途 |
|------|------|
| `POST /interrupt` | 中断当前执行 |
| `POST /queue` `{"clear":true}` | 清空队列 |
| `POST /queue` `{"delete":["<prompt_id>"]}` | 删除单个排队任务 |
| `GET /system_stats` | 显存/设备 |
| `GET /models` `/models/{folder}` | 模型枚举 |
| `GET /features` | 特性开关 |

---

## B.8 待确认

- **Q7**：是否需要把 `extra_pnginfo.workflow` 回填进 PNG，让 ComfyUI 原生前端也能打开我们的产出？
  （推荐**是**，成本低、互操作性高）
- **Q8**：`/view` 的图片是否需要服务器本地缓存归档？
  （ComfyUI 的 output 目录会被用户清理）
