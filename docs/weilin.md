# WeiLin 对接方案

> 状态：**讨论稿**（待用户确认）
> 上游文档：[v1-plan](./v1-plan.md) · [v1-template](./v1-template.md)
> 源码：`/workspace/WeiLin-Comfyui-Tools`

你的诉求：**要 WeiLin 的 LoRA 选择 + 自动提示词注入**，但不确定怎么和「自己填 API JSON」的模式对接。
本文给出结论与方案。

---

## 1. 结论先行

**最好的对接方式：把 WeiLin 当作"上游服务"复用它的 REST API，而不是重新实现它的逻辑。**

原因：
1. WeiLin **已经在 ComfyUI 的 aiohttp 上注册了完整的 REST 路由**（前缀 `/weilin/prompt_ui/api/`），
   我们**零改造成本**即可调用。
2. 标签库/翻译/LoRA 元数据的逻辑与数据都在插件侧（SQLite at `/workspace/user_data/*.db`），
   重新实现 = 高成本 + 强耦合 + 跟随上游更新。
3. 提示词注入发生在**执行期**（节点 `encode()` 内部），服务器**不需要理解**其内部逻辑，
   只要往正确的字段写值。

---

## 2. 调用链路全景

```
[SPA] 标签选择 / LoRA 选择
   │
   │  GET /api/tags, /api/loras          ← 我们的适配层
   ▼
[server: weilin/]  ──代理──▶  ComfyUI :8188 /weilin/prompt_ui/api/*
   │                                    ├── get_lora_list
   │                                    ├── prompt/get_group_tags_paginated
   │                                    ├── prompt/local/translate
   │                                    ├── random_template/*
   │                                    └── lorainfo/api/loras/info
   │
   │  用户点「生成」→ 渲染模板 graph（写入 WeiLin 节点字段）
   ▼
[server: comfy/]  ──POST /prompt──▶  ComfyUI 执行
                                        │
                                        └─▶ [WeiLin 节点] 执行期注入
                                              ├── positive / opt_text 拼接
                                              ├── auto_random 抽随机标签
                                              └── lora_str 施加 LoRA 堆叠
```

**关键认知**：WeiLin 的"自动提示词注入"是**节点执行期行为**，
我们只要正确设置字段（`positive`、`temp_str`、`auto_random`、`random_template`），
注入逻辑由插件自己完成。

---

## 3. 适配层设计（`server/src/weilin/`）

### 3.1 三种可选模式

| 模式 | 做法 | 优点 | 缺点 | v1 |
|------|------|------|------|-----|
| **A. 代理模式** | HTTP 转发到 `/weilin/prompt_ui/api/*`，再精简成我们的 DTO | 零耦合、跟随上游 | 依赖插件在线、接口可能变 | ✅ **采用** |
| B. 直读模式 | 直接读 `user_data/*.db` | 快、不依赖 HTTP | 与表结构强耦合、绕过插件逻辑 | ⛔ 后备 |
| C. 重实现 | 自己建标签库 | 完全可控 | 成本极高、数据不同步 | ⛔ 不做 |

> **建议**：v1 用 A；若发现某接口性能不足，对**只读**接口（如标签检索）局部切到 B。

### 3.2 能力探测与降级

启动时探测：

```
GET /weilin/prompt_ui/api/get_lora_load_status   → WeiLin 是否就绪
GET /object_info/WeiLinPromptUIWithoutLora       → 节点是否加载
```

- 任一失败 → `weilin.available = false`
- 降级行为：标签/LoRA 面板隐藏，`tag-selector` 退化为 `textarea`，
  LoRA 选择退化为"手填文件名下拉"（用 ComfyUI `/models/loras`）

> **重要**：降级后**出图链路仍须可用**（这是 v1 的硬要求 —— WeiLin 是增强而非依赖）。

### 3.3 缓存

| 数据 | 策略 |
|------|------|
| LoRA 列表 | 内存缓存 5 分钟；`lorainfo/refresh` 后失效 |
| 标签分组 | 内存缓存 10 分钟 |
| 自动补全 | 不缓存（或 30s 短缓存） |
| LoRA 预览图 | 磁盘缓存 |

---

## 4. LoRA 应用：**可直接改 API JSON**（已由源码确认）

### 4.1 结论

**不需要复杂实现。** WeiLin 的节点在执行期自行完成 LoRA 加载与触发词注入，
服务器**只需把值写进节点的两个字符串字段**：

| 字段 | 写什么 | 适用 |
|------|--------|------|
| `positive` | 内嵌 `<wlr:...>` 标签的提示词文本 | 文本驱动，直观 |
| `lora_str` | 富格式 JSON 数组（UI 产物） | 结构驱动，字段全 |

**两个字段可以同时用**，节点会做去重合并（`__init__.py:397-410`）。

### 4.2 `<wlr:...>` 标签格式（源码 `lora_stack.vue:302`）

```
新格式(4参数)： <wlr:LoRA名:模型权重:CLIP权重:触发词权重>
旧格式(3参数)： <wlr:LoRA名:模型权重:CLIP权重>

# 示例（来自 api.example.json 节点 43）
<wlr:Anima\Anima Turbo LoRA-v0.2:0.9:1:1>, <wlr:Anima\画师\taffy-style:0.9:1:1>
```

> 注意：**先匹配新格式，再匹配旧格式**（源码注释明确说明，避免旧格式误匹配新格式）。
> LoRA 名**不含 `.safetensors` 后缀**，节点会自动补上（`lora_path.strip() + ".safetensors"`）。
> 标签会从提示词文本中**移除**，并清理多余逗号。

### 4.3 `lora_str` 富格式（源码 `prompt_index.vue` / 实测 `api.example.json`）

```jsonc
[{
  "name": "Anima\\画师\\taffy-style",              // 不含扩展名
  "lora": "Anima\\画师\\taffy-style.safetensors",  // 含扩展名（节点用这个）
  "weight": 0.9,                    // 模型权重
  "text_encoder_weight": 1,         // CLIP 权重
  "trigger_weight": 1,              // 触发词权重
  "display_name": "taffy-style - v1.0",
  "loraWorks": "@bantan",           // 用户编辑的触发词
  "hidden": false                   // 隐藏则不参与（前端过滤）
}]
```

节点实际读取的键：`lora`、`weight`、`text_encoder_weight`、`trigger_weight`
（`__init__.py:437-445`）；`display_name`/`loraWorks`/`hidden` 供 UI 使用。

### 4.4 三个 WeiLin 节点如何选

| 节点 | 提示词 | LoRA | **触发词注入** | 本项目用途 |
|------|--------|------|----------------|-----------|
| `WeiLinPromptUI` | ✅ | ✅ | ✅ **会自动注入** | **节点 43**：当"纯 LoRA 加载器"用（`positive` 只放标签） |
| `WeiLinPromptUIWithoutLora` | ✅ | ❌ | ❌ | **节点 19**：主提示词（数据库选词） |
| `WeiLinPromptUIOnlyLoraStack` | ❌ | ✅ | ❌ **不注入** | 备选（若选 Q15 方案 B 则改用它） |

> **重要（已双重验证）**：
> 1. `OnlyLoraStack` **不做触发词注入**——`__init__.py:553-655` 内 grep `trigger` **零命中**。
>    你的观察正确，这正是你选全能组件 `WeiLinPromptUI` 的原因。
> 2. `WeiLinPromptUI` 的注入条件是 `opt_model is not None and lora_list is not None`
>    （`__init__.py:410`），注入语句 `text_dec = ", ".join(all_trigger_words) + ", " + text_dec`（`__init__.py:476`）。

### 4.5 为什么不用服务器改图插 `LoraLoader`

- ❌ 需要实现图拓扑改写（插节点 + 重连 MODEL/CLIP），复杂且易错
- ❌ 无法获得触发词能力（那正是你要的）
- ✅ 唯一优势是不依赖 WeiLin —— 但已决定强依赖（Q4），故放弃

> **最终方案**：模板保留 WeiLin 节点，服务器只写 `positive` / `lora_str`。

---

## 5. 触发词自动注入：完整机制（源码级）

### 5.1 执行期发生了什么（`WeiLinPromptUI.load_lora_ing`，`__init__.py:305-560`）

```
1. 解析提示词
   ├─ positive 是 JSON ? → prompt = obj["prompt"], lora_list = obj.get("lora")
   └─ 否则              → text_dec = positive
   若 opt_text 非空      → text_dec = opt_text + ", " + text_dec

2. auto_random ?
   └─ 从 random_template 抽标签 → 覆盖 positive

3. 从 text_dec 提取 <wlr:...> 标签（新格式优先，再旧格式）
   ├─ 构建/合并 lora_list（与 JSON 来源去重）
   └─ 从 text_dec 中移除标签、清理逗号

4. 若 opt_model 非空 且 lora_list 非空：
   for each lora:
     ├─ 加载 LoRA，施加 weight / text_encoder_weight
     ├─ trigger_word = get_lora_trigger_words(lora_path, lora_name)   ← 触发词来源见 5.2
     └─ 收集 f"{trigger_word}:{trigger_weight}"
   ★ 注入： text_dec = ", ".join(all_trigger_words) + ", " + text_dec   ← 拼到最前面

5. opt_clip 非空 → tokenize(text_dec) → conditioning
```

**最终提示词形态**：

```
<触发词1>:<w1>, <触发词2>:<w2>, <opt_text>, <用户提示词>
```

### 5.2 触发词的四个来源与优先级（`trigger_words.py:get_trigger_words`）

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | **Civitai API** `trainedWords` | 按文件 SHA256 查询；缓存于 `./loras_tags.json`（相对 ComfyUI 进程 CWD） |
| 2 | 元数据 `ss_tag_frequency` | 按训练频次降序；**智能过滤**通用标签（`_is_common_tag`，约 120 个常见 tag） |
| 3 | 元数据 `ss_output_name` | 去掉 `-v1`/`_v2` 类版本后缀 |
| 4 | 文件名 | 最后的回退 |

命中即返回（不继续往下找），只取**第一个**触发词（`get_first_trigger_word`）。

> ⚠️ 当前 `/workspace/ComfyUI/loras_tags.json` **不存在** → Civitai 缓存为空，
> 首次会尝试联网查询 Civitai（`timeout=10s`），失败则回退到元数据/文件名。

### 5.3 拆分式设计：为什么它天然避免重复注入

> **修正**：早期分析曾担心"前端插 `loraWorks` + 节点再注入"导致触发词重复。
> 经核对 `api.example.json` 的实际结构，**本项目的拆分式设计不存在这个问题**——
> 该风险只存在于 WeiLin 原生的"单节点同时装提示词和 LoRA"用法。

#### 本项目的实际链路（实测自 `api.example.json`）

```
28  CR Text                    ← 「质量正向词」"dramatic angle,ultra-detailed,..."
24  CLIPLoader                 ← 提供 CLIP
17  UNETLoader                 ← 提供 MODEL

43  WeiLinPromptUI              ← 「纯 LoRA 加载 + 触发词注入」
    positive    = "<wlr:Anima\Anima Turbo LoRA-v0.2:0.9:1:1>,
                   <wlr:Anima\画师\taffy-style:0.9:1:1>"     ← 只有标签，无正文
    lora_str    = [ ...2 个 LoRA 的富 JSON... ]
    opt_text    = ["28", 0]   ← 质量正向词
    opt_clip    = ["24", 0]   ← CLIP
    opt_model   = ["17", 0]   ← MODEL（注入条件要求非空）
    执行：text_dec = opt_text + ", " + positive
                    = "dramatic angle,..., <wlr:...>, <wlr:...>"
          → 剥离标签、清理 ", ," → text_dec = "dramatic angle,ultra-detailed,..."
          → 加载 LoRA（2 个）
          → 注入触发词 → text_dec = "<触发词1>:1, <触发词2>:1, dramatic angle,..."
    ├─ output[0] STRING ─────────┐
    └─ output[2] CLIP ─────────┐ │
                               │ │
19  WeiLinPromptUIWithoutLora  ◀┘ │   ← 「数据库选词」，不加载 LoRA、不注入
    opt_text = ["43", 0]  ←──────┘
    opt_clip = ["43", 2]
    positive = "1girl, solo, tight black bunny leotard, ..."
    执行：text_dec = opt_text + ", " + positive
                    = "<触发词1>:1, <触发词2>:1, dramatic angle,..., 1girl, solo, ..."

33  CLIPTextEncode             ← 「质量负向词」，clip 取自 ["43", 2]
```

**最终提示词顺序**：`触发词 → 质量正向词 → 主提示词`，负向词独立。

**因为这个拆分**：

| 关注点 | 结果 |
|--------|------|
| 提示词正文在哪 | 只在节点 19（`WithoutLora` → **不注入**） |
| LoRA 加载与触发词在哪 | 只在节点 43（`WeiLinPromptUI` → **注入**） |
| 43 会不会产出正文 | ❌ 不会：`positive` 只有标签，剥离后只剩来自 28 的质量词 |
| 会不会重复注入 | ❌ **不会**：19 根本不注入 |
| 职责是否单一 | ✅ 每个节点只干一件事 |

> **这正是拆分式设计的价值**：把「LoRA 加载 + 触发词注入」和「数据库选词」
> 放到两个节点，注入只发生一次，且不会污染主提示词。
> 前端设计应当**镜像这个拆分**（见 §6.6）。

#### ⚠️ 但仍然存在的真实缺口：`loraWorks` 不被节点读取

拆分解决了"重复"，但没解决"**用户编辑的触发词能否生效**"：

| | 用户编辑的触发词 | 节点自动注入用的触发词 |
|---|---|---|
| 存储 | `lora_userdatas/`（`lorainfo` REST） | `./loras_tags.json` + safetensors 元数据 |
| 字段 | `trainedWords[].word`、`loraWorks` | `get_first_trigger_word()` 的返回值 |
| 谁在用 | **只有前端 UI**（插入输入框） | **只有节点**（注入提示词） |

**证据（双重确认）**：
1. `grep -n "loraWorks" __init__.py` → **零命中**。节点读取的键只有
   `lora` / `weight` / `text_encoder_weight` / `trigger_weight`（`__init__.py:416-438`）。
2. 节点走 `get_lora_trigger_words` → `get_first_trigger_word` → `get_trigger_words`，
   只查 Civitai 缓存 / 元数据 / 文件名，**完全没有**读 `lora_userdatas/` 的逻辑。

**后果**：你的示例里 `taffy-style` 的 `loraWorks: "@bantan"` **不会**被注入。
实际注入的会是：

- 若 Civitai 缓存有记录 → Civitai 的第一个 `trainedWords`
- 否则 safetensors `ss_tag_frequency` 中训练频次最高的词（已过滤通用标签）
- 否则 `ss_output_name`
- 否则**文件名**（`taffy-style`）← 这个结果多半不是你想要的

> 也就是说：**"自动注入"确实生效，但注入的是元数据猜的词，不是你编辑的词。**
> M0 冒烟时 ComfyUI 控制台会打印 `添加触发词到提示词开头: ...`，
> 那条日志就是判据——**先看它实际注入了什么，再决定下面选哪个方案。**

#### 三个方案（需决策 **Q15**）

| 方案 | 做法 | 触发词来源 | 用户编辑生效 | 额外代码 |
|------|------|-----------|-------------|---------|
| **A 沿用现状** | 保持节点 43 = `WeiLinPromptUI`，我们只写 `lora_str` | Civitai/元数据/文件名 | ❌ | **0** |
| **B 我们注入**（推荐，若需精确控制） | 节点 43 改用 `WeiLinPromptUIOnlyLoraStack`（不注入），触发词由我们按 `loraWorks`/`trainedWords` 拼进节点 19 | 标签数据库（**你编辑的词**） | ✅ | 中 |
| **C 双注入** | 保持 `WeiLinPromptUI`，再把自定义词写进 `positive` 正文 | 两者都有 | ⚠️ 部分 | 低 |

**方案 A vs B 的取舍**：

- **A 的优势 = 零代码**。如果 M0 实测发现你的 LoRA 元数据质量好（注入的词正确），
  那就直接用 A，最省事，且完全复用插件逻辑。
- **B 的优势 = 确定性**。触发词在**提交前**就确定了，可以：
  - 在前端**预览**最终提示词（"你将发送：@bantan, 1girl, solo..."）
  - 让"编辑触发词"这个功能**真正有意义**
  - 不依赖 Civitai 网络与元数据质量
  - 代价：从"节点执行期自动"变成"我们组装"，且需把 43 换成 `OnlyLoraStack`

> **建议**：**先看 M0 的注入日志**。
> 若元数据命中且词正确 → 选 **A**（零成本）；
> 若回退到文件名或词不对 → 选 **B**（否则"编辑触发词"是死功能）。

### 5.4 `auto_random` 的重要副作用（对前端很有用）

```python
if auto_random:
    return { "ui": {"positive": [str(positive)]}, "result": (...) }
```

- `auto_random=true` 时节点返回 `{"ui": ..., "result": ...}` 包装
  → **WS `executed` 消息会回传本次实际使用的提示词**
- 前端可展示"这次到底随机到了什么"
- `IS_CHANGED` 返回 `NaN` → **强制每次重跑**（随机模式无法命中缓存，符合预期）

### 5.5 `random_template` 从哪来

- `random_template/get_template_list` 列出可用模板
- 用户选择后写入节点 `random_template` 字段

### 5.6 其它"自动"能力

| 能力 | 字段 | 语义 |
|------|------|------|
| 前置注入 | `opt_text` | `text_dec = opt_text + ", " + positive`（**注意在触发词之后**） |
| 随机提示词 | `auto_random` + `random_template` | 覆盖 `positive` |
| 标签翻译/着色 | `temp_str` | 仅前端编辑态，**不影响出图** |

> **层叠顺序**（§5.1 第 5 步合并后）：
> `触发词 → opt_text → (随机标签 | 用户提示词)`

---

## 6. 前端组件搬运方案（回答"能否直接搬"）

### 6.1 可行性结论：**可以搬**

WeiLin 的前端**本身就是 Vue 3 应用**，且与 ComfyUI **零耦合**：

| 检查项 | 结果 |
|--------|------|
| 依赖 `window.app` / `app.graph` / `LiteGraph` / `ComfyApp` | ❌ **全仓库无命中** |
| 数据来源 | `axios` + `baseURL = '/weilin/prompt_ui/api'`（`src/api/request.js:3`） |
| 宿主通信 | `window.postMessage({type:'weilin_prompt_ui_*'})` |
| 挂载方式 | `createApp(App).mount(div)`（`src/main.js:21-27`） |
| 技术栈 | Vue 3.5 + pinia 3 + vue-i18n 11 + axios + interactjs + pako |
| 构建 | Vite `lib` 模式，UMD → `dist/javascript/main.entry.js` |

**关键洞察**：WeiLin 的 Vue 应用**已经是一个"通过 HTTP 取数、通过 postMessage 与宿主对话"的独立应用**。
它不知道 ComfyUI 的存在——那层适配全在 `js_node/weilin_prompt_ui_node.js`（ComfyUI 扩展侧）。
**我们要做的就是替换那个适配层**，把 postMessage 换成我们自己的状态绑定。

### 6.2 三种搬运策略

| 策略 | 做法 | 优点 | 缺点 | 建议 |
|------|------|------|------|------|
| **A. 搬源码** | 把 `src/src/` 的 `.vue` 组件复制进 `apps/web`，改 `api/request.js` 指向我们的 server | 可深度定制、类型可控、能改样式 | 需处理 pinia/i18n/interactjs 依赖；跟随上游更新需手动合并 | ✅ **推荐** |
| **B. 嵌 UMD** | 直接加载 `dist/javascript/main.entry.js`（UMD），当黑盒挂载 | 最快见效、跟随上游 | 定制困难、样式隔离麻烦、postMessage 契约要照抄 | 备选（快速验证） |
| **C. 照着重写** | 只参考交互，自己实现 Vue 组件 | 完全可控、依赖最小 | 工作量最大、丢掉 WeiLin 积累的细节 | ❌ 不划算 |

### 6.3 策略 A 的改造点（预估）

```
WeiLin 现状                              我们的目标
─────────────────────────────────────    ──────────────────────────────
api/request.js  baseURL='/weilin/...'    → 改指向我们 server 的 /api/*
postMessage 收发节点值                    → 改为 pinia store 双向绑定
window.parent.postMessage(...)           → 删除，改为 store action
节点输入框 UI（ComfyUI widget 内嵌）      → 改为我们的表单组件
i18n（vue-i18n，已有 zh_CN）              → 保留复用 ✅
标签/LoRA 数据请求                        → 保留（端点语义一致）✅
```

**可大量复用的部分**（价值最高）：
- `view/prompt_box/prompt_index.vue` —— 提示词编辑器主组件（标签着色、翻译、补全）
- `view/prompt_box/components/lora_stack.vue` —— LoRA 选择器（权重/触发词/`<wlr:>` 生成）
- `view/lora_manager/*` —— LoRA 卡片/详情/预览图
- `view/tag_manager/*` —— 标签库管理与分组
- `i18n/locales/zh_CN.js` —— 中文文案

### 6.4 依赖评估

| 依赖 | 必要性 | 处置 |
|------|--------|------|
| `vue` 3.5 | 必需 | 我们的前端也是 Vue 3，直接复用 |
| `pinia` 3 | 必需 | 采用 |
| `vue-i18n` 11 | 有用 | 采用（已有中文包） |
| `axios` | 可替换 | 改用我们统一的 fetch 封装 |
| `interactjs` | 拖拽 | 按需（标签拖拽排序时有） |
| `pako` | 压缩 | 按需（历史/云数据压缩时） |
| `vue3-json-viewer` | 调试视图 | 可裁剪 |
| `uuidv7` | ID 生成 | 可裁剪 |

### 6.5 注意：搬运的**不是** ComfyUI 节点 UI

需要区分两件事：

- ❌ **不搬** `js_node/weilin_prompt_ui_node.js` —— 它是 ComfyUI 扩展，负责在节点上开 iframe
- ✅ **搬** `src/src/` 的 Vue 应用 —— 它是真正的内容

我们把 Vue 应用直接作为**我们 SPA 的一个页面/组件**运行，不再需要 iframe 与 postMessage。

### 6.6 前端应镜像节点的"单一职责"拆分

你采用的节点拆分（每个节点只干一件事）**应当在 UI 层同样体现**，
否则前端会退化成 WeiLin 原生那种"所有东西堆在一个提示词框里"的形态。

**建议的前端分区（与节点一一对应）**：

| 前端面板 | 对应节点 | 数据来源 | 写入字段 |
|---------|---------|---------|---------|
| **LoRA 管理器** | `43` `WeiLinPromptUI` | `get_lora_list*`、`lorainfo` | `43.lora_str` + `43.positive`(仅标签) |
| **质量正向词** | `28` `CR Text` | 本地预设 | `28.text` |
| **提示词编辑器** | `19` `WeiLinPromptUIWithoutLora` | 标签库 DB | `19.positive` |
| **质量负向词** | `33` `CLIPTextEncode` | 本地预设 | `33.text` |

> 注意 `28` 是**独立节点**，通过 `43.opt_text` 进入链路 —— 这正是"质量词不混进主提示词"的实现方式。

**为什么要这样分**：

1. **职责不混**：LoRA 面板不碰主提示词，提示词面板不管 LoRA
2. **注入只发生一次**：触发词由 LoRA 面板负责（§5.3），不会混进提示词框
3. **映射清晰**：每个面板 → 模板里一个 `input` → 一个节点字段，`bindings` 一一对应
4. **可分别搬运**：WeiLin 的 `lora_stack.vue` 与 `prompt_index.vue` 本就是两个组件，
   搬过来各归其位即可

**对应的模板 `inputs` 设计**：

```jsonc
{
  "inputs": [
    { "key": "loras",  "type": "lora-select",  "label": "LoRA",     "bindTo": "43" },
    { "key": "prompt", "type": "tag-selector", "label": "提示词",   "bindTo": "19" },
    { "key": "qualityPos", "type": "textarea", "label": "质量词+",  "bindTo": "28" },
    { "key": "qualityNeg", "type": "textarea", "label": "质量词-",  "bindTo": "33" }
  ]
}
```

> 这个"面板 ↔ 节点"的对应关系，就是 [v1-template.md](./v1-template.md) 里
> `bindings` 的天然组织方式。**一个面板绑一个节点，不交叉。**

---

## 7. WeiLin 接口映射表（我们的 API ↔ WeiLin API）

| 我们的端点 | WeiLin 端点 | 备注 |
|-----------|------------|------|
| `GET /api/loras` | `POST get_lora_list_by_search` / `POST get_lora_list_by_range` / `GET get_lora_list` | ⚠️ **必须用分页/搜索端点**，见下 |
| `GET /api/loras/folders` | `POST get_lora_folder_list` | |
| `GET /api/loras/:name/meta` | `GET lorainfo/api/loras/info` | 触发词、备注、预览图 |
| `GET /api/loras/:name/preview` | `GET lorainfo/api/loras/img` | |
| `GET /api/tags` | `GET prompt/get_group_tags_paginated` | |
| `GET /api/tags/autocomplete` | `GET prompt/fast/autocomplete` | |
| `GET /api/tags/groups` | `POST prompt/get_groups_list` | |
| `POST /api/tags/translate` | `GET prompt/local/translate` | |
| `GET /api/tags/random-template` | `GET random_template/get_template_list` | |
| `GET /api/system/health` (weilin 段) | `GET get_lora_load_status` | 探活 |

### ⚠️ 实测：`get_lora_list` 返回 41 MB

2026-09-18 在真机（288 个 LoRA）实测：

```
GET /weilin/prompt_ui/api/get_lora_list   →   41,500,353 字节
GET /weilin/prompt_ui/api/get_lora_load_status
     → {"isLoading": false, "progress": 100, "total": 288, "current": 288}
```

**后果**：直接把 `get_lora_list` 转发给浏览器会导致前端卡死/内存暴涨。
M3 实现时必须：

1. 默认走 **`get_lora_list_by_range`**（分页）或 **`get_lora_list_by_search`**（按关键词）
2. 若确需全量，在**服务端**缓存并按需切片，绝不整体下发
3. 首屏只返回精简字段（`name`/`displayName`/`folder`/`previewUrl`），
   触发词等元数据按需再查 `lorainfo/api/loras/info`

> 具体请求参数形状仍需在 M3 逐个确认（部分端点是 POST 但语义为查询）。


---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| WeiLin 接口无版本号，随插件更新静默变更 | 适配层失效 | 启动探活 + 契约快照测试 + 记录上游 commit |
| 部分端点参数名不明确 | 集成返工 | **先写冒烟脚本实测**（M0） |
| **触发词注入的词不对**（元数据缺失→回退文件名） | 提示词污染、出图偏差 | 先看 M0 注入日志，再定 Q15 方案 |
| **用户编辑的触发词不生效**（§5.3） | 功能与预期不符 | 方案 B：我们自己注入 |
| **搬组件带来的依赖膨胀**（§6.4） | 构建体积、维护成本 | 按需裁剪，见 Q16 |
| `user_data/*.db` 未初始化 | 标签接口 500 | 探活失败即降级（**当前确实为空**） |
| `loras_tags.json` 未初始化 | 触发词回退到元数据/文件名 | 可接受；或提供预填充 |
| WeiLin 节点在图中但插件被禁用 | graph 校验失败 | `requirements.nodes` 前置校验，明确报错 |
| 中文/转义路径（`Anima\\画师\\...`） | 文件名处理出错 | **原样透传**，不做路径规范化 |

---

## 9. 待确认

| # | 问题 |
|---|------|
| Q3 | LoRA 写入方式：**`lora_str`（富 JSON）** vs **`positive` 内嵌 `<wlr:>`**？（可同时用） |
| Q4 | ✅ **已决：强依赖 WeiLin** |
| **Q15** | **触发词来源**（见 §5.3）——先看 M0 注入日志：词对→方案 A（零代码）；词错→方案 B |
| **Q16** | 前端搬运策略 A 搬源码 / B 嵌 UMD / C 重写（见 §6.2）——建议 **A** |
| Q12 | 是否需要**标签管理写操作**（增删改标签），还是 v1 只做只读选择？ |
| Q13 | 是否把 WeiLin **提示词历史**（`prompt/history/*`）接入图库页？ |
| Q14 | `auto_random` 模式下是否需要"预览本次随机结果"（依赖 `ui.positive` 回传）？ |
| **Q17** | 是否需要**触发词编辑 UI**（写入 `lorainfo` 的 `trainedWords`/`loraWorks`）？ |

---

## 10. 建议的验证顺序（M0 冒烟）

1. 启动 ComfyUI，确认 `/object_info` 含 `WeiLinPromptUI`、`WeiLinPromptUIWithoutLora`、`WeiLinPromptUIOnlyLoraStack`
2. `curl` 实测 WeiLin REST：`get_lora_load_status`、`get_lora_list`、`prompt/get_groups_list`、`prompt/fast/autocomplete?q=blue`
3. 用 `api.example.json` **原样** POST 到 `/prompt`，确认能出图
4. **验证进度**：连 `/ws?clientId=X`，POST 时带同一 `client_id=X`，确认收到 `progress` 事件 → **H1**
5. 改 `43.inputs.positive` 为纯文本，确认提示词生效
6. 改 `43.inputs.lora_str` 的 `weight`，确认出图变化 → LoRA 生效
7. **验证触发词注入**：观察 ComfyUI 控制台的 `添加触发词到提示词开头: ...` 日志 → **H6**
8. 测试 `auto_random=true` + `random_template`，观察 WS `executed.ui.positive` 回传

> 第 7 步的日志能直接确认触发词内容，是判定 Q15 方案的关键证据。
