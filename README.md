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
pnpm build            # 先构建前端产物，server 会直接托管
COMFY_MODE=mock pnpm --filter @comfyui-server/server start
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
pnpm smoke
```

---

## 目录结构

```
comfyui-server/
├── api.example.json          # 原始导出工作流（参考）
├── v1/                       # 规划文档
├── templates/                # 工作流模板
│   └── txt2img-basic/
│       ├── template.json     # inputs + bindings（不含 graph）
│       └── graph.json        # API 格式工作流（从 ComfyUI 导出）
├── packages/shared/          # 前后端共享 TS 类型
└── apps/
    ├── server/               # Node-TS BFF
    │   ├── src/comfy/        # ComfyUI 客户端（real = HTTP+WS，mock = 内置模拟器）
    │   ├── src/templates/    # 模板加载 / 渲染 / 变换器
    │   ├── src/jobs/         # 任务编排 + 事件总线
    │   └── src/http/         # 路由层
    └── web/                  # Vue 3 SPA
```

---

## 配置

配置从 **`config.json`**（仓库根，支持 `//` 与 `/* */` 注释）读取：

```jsonc
{
  "host": "127.0.0.1",
  "port": 8080,
  "comfyui": {
    "baseUrl": "10.2.3.22:8188",   // 可省协议，自动补 http://
    "mode": "real"                  // real | mock
  },
  "templatesDir": "templates",
  "logLevel": "info",
  "mockStepDelayMs": 120
}
```

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
库文件在 `dataDir/comfyui-server.db`（默认 `.data/`，已 gitignore）。

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
