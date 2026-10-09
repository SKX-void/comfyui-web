# 图片反推（`@comfyui-web/image-reverse-inference`）

图 → tags 文本。把图拖进 tab，插件在 ComfyUI 上跑一遍 WD14 Tagger，把反推出来的
提示词串回填到文本框里（可直接编辑、一键复制）。

- tab id：`image-reverse-inference`（`tabs/` 里的目录名）
- 前端：`client/`（Vue SFC + 压缩逻辑）→ `tabs/image-reverse-inference/client.js`
- 后端：`server/`（多文件，esbuild 打成单文件）→ `tabs/image-reverse-inference/server.js`
- 工作流：`workflow.json`（ComfyUI **API 格式**导出）→ 作为运行期资产拷进 tab 根

## 它为什么长这样（两个实测结论，改之前先看）

**① 图片只能由插件后端上传，浏览器直传必挂。**
本机 ComfyUI（0.33.0）不带任何 CORS 响应头：带 `Origin` 的 GET 没有
`Access-Control-Allow-Origin`，`OPTIONS /upload/image` 只有 `200` + 空 body。
所以前端 → `POST /api/p/image-reverse-inference/infer`（JSON）→ 后端组 multipart 打
`/upload/image`。

**② 前端送的必须是 base64 JSON，不能是 multipart。**
宿主的 fastify 只注册了 `application/json` 与 `text/plain` 两个解析器，`multipart/form-data`
与 `application/octet-stream` 在**进 handler 之前**就被 415 挡掉 —— 插件拿不到原始流。
代价是 base64 膨胀 4/3：宿主 `bodyLimit` 是 4MB，所以前端把图压到 ≤1MB（目标 500KB），
后端再兜一道 2MB（`server/meta.ts` 的 `MAX_IMAGE_BYTES`）。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/p/image-reverse-inference/settings` | 盘上的原始值 + 本次装载的生效值 + 文件路径 |
| PUT | `/api/p/image-reverse-inference/settings` | 写设置（`{ values: {...} }`，只收认识的键；整体替换，要重挂才生效） |
| GET | `/api/p/image-reverse-inference/model` | 工作流指定的模型 + 本机装没装（插件**不提供**选模型） |
| GET | `/api/p/image-reverse-inference/status` | ComfyUI 连没连上（`/system_stats`） |
| POST | `/api/p/image-reverse-inference/infer` | `{ dataUrl, filename, params }` → `{ tags, promptId, elapsedMs, uploaded }` |

## 工作流绑定：不写死节点号

`server/workflow.ts` 靠 `class_type` 现找节点：`LoadImage`、以 `WD14Tagger` 开头的节点
（认前缀而不是 `WD14Tagger|pysssss`，换个署名后缀不该让插件当场坏掉）、可选的 `PreviewAny`。
所以你在 ComfyUI 里拖节点、重新导出 `workflow.json`，**只要这三类节点还在**，绑定就不会失效。

`LoadImage.image` 要填的是 `subfolder/name`（实测：`subfolder` 非空时只写 `name`
会被 combo 校验挡下），插件上传时固定放进 `input/image-reverse-inference/`。

**`model` 只读不写**：插件不往 tagger 节点写 `model`，用的是 `workflow.json` 里那个值 ——
模型是工作流的事实（`WorkflowBindings.taggerModel`），换模型 = 在 ComfyUI 里改完重新导出
`workflow.json`，插件一行都不用动。`GET /model` 会告诉你当前是哪个、以及本机装没装
（`installed: false` 时界面上会直接提示，不必等 `/prompt` 报错）。

取文本先看 `outputs[<tagger>].tags`（`WD14Tagger` 的 `output_is_list=true`，整串在数组第 0 项），
拿不到再退到 `outputs[<PreviewAny>].text`。

## 设置

设置由插件自己持有（D15）：`data/plugins/@comfyui-web+image-reverse-inference/settings.json`。
`comfyuiBaseUrl` 没配过时读宿主 `data/host.json` 的 `globals.comfyuiBaseUrl` 当只读默认值
（D19：宿主不会把统一地址写进插件）。

**只有一条写盘路径**：设置面板「保存并重挂」→ `PUT /settings`（整体替换）→
`POST /api/tabs/<id>/reload`。保存只是落盘，值要**重挂后**才进 `ComfyClient`（D20）。

主页面参数行（两个阈值滑动条 / 两个开关 / 排除标签）**不落盘**：它只是这一次反推的入参，
随请求送给后端。想改默认值就在设置面板里改 —— 曾经试过"点反推时把参数写回设置文件"，
写是写进去了，但 `GET /settings` 给的是**挂载时读的快照**，不重挂就看不到，
用户视角就是"没生效"，所以去掉了。

## 开发

```bash
pnpm --filter @comfyui-web/image-reverse-inference build      # → tabs/image-reverse-inference/
pnpm --filter @comfyui-web/image-reverse-inference dev        # 常驻 watch（产物变了仍要人点「重新扫描」）
pnpm --filter @comfyui-web/image-reverse-inference typecheck
pnpm --filter @comfyui-web/image-reverse-inference test:contract
```

契约测试（`scripts/contract-test.mjs`）在没有浏览器的情况下走一遍：前端产物能不能被外壳加载、
清单字段、后端 `apply()` 能不能解析 `workflow.json`、`/settings`（白名单与重挂标记）、
`/model` 的形状与 `/infer` 的入参闸门。
**它挡不住真出图那一跳** —— 上传 → `/prompt` → `/history` 要对着真 ComfyUI 跑：

```bash
# 需要一张本机的图；dataUrl 用 base64 塞进 JSON（原因见上）
curl -s -X POST localhost:8087/api/p/image-reverse-inference/infer \
  -H 'Content-Type: application/json' \
  -d "{\"dataUrl\":\"data:image/webp;base64,$(base64 -w0 /tmp/x.webp)\"}"
```
