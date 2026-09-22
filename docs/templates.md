# 工作流模板设计

> 状态：**讨论稿**（待用户确认）
> 上游文档：[v1-plan](./v1-plan.md) · [v1-architecture](./v1-architecture.md) · [v1-api](./v1-api.md)

本项目与工作流**高度定制化绑定**（决策 D5）。本文定义"模板"这一层抽象：
它把 `api.example.json` 这类原始 API 格式工作流，变成**可参数化的表单 + 渲染规则**。

---

## 1. 为什么需要模板层

原始的 API 格式工作流（如 `api.example.json`）直接就是 ComfyUI 的 graph：

```jsonc
{
  "17": { "inputs": { "unet_name": "Anima\\0.26.9.12...safetensors" }, "class_type": "UNETLoader" },
  "19": { "inputs": { "positive": "1girl, solo, ...", "opt_text": ["43",0], "opt_clip": ["43",2] }, "class_type": "WeiLinPromptUIWithoutLora" },
  "21": { "inputs": { "filename_prefix": "anima", "images": ["27",0] }, "class_type": "SaveImage" }
}
```

它包含大量**不该让用户填**的东西：节点 ID、连线、`_meta`、工作流内部中间节点。
模板层负责：

1. 把「该给用户填的」抽出来 → `inputs`（前端的表单）
2. 把「该怎么填进 graph」记下来 → `bindings`（服务器的渲染规则）
3. 保留原始 graph 作为 `graph`（模板骨架）

---

## 2. 模板文件格式

存放：`templates/<id>/template.json`

```jsonc
{
  "$schema": "../template.schema.json",
  "id": "txt2img-basic",
  "name": "基础文生图",
  "description": "单模型 + WeiLin 提示词 + SaveImage",
  "version": "1.0.0",

  "source": {
    "file": "api.example.json",       // 来源工作流（便于追溯/更新）
    "capturedAt": "2026-09-18T16:46:00Z"
  },

  "requirements": {
    "nodes": ["UNETLoader", "WeiLinPromptUIWithoutLora", "SaveImage"],
    "weilin": true
  },

  "inputs": [
    { "key": "prompt",     "label": "正向提示词", "type": "tag-selector", "required": true, "default": "" },
    { "key": "negative",   "label": "负向提示词", "type": "textarea",     "required": false, "default": "lowres, bad anatomy" },
    { "key": "unet_name",  "label": "模型",       "type": "model-select", "required": true,
      "source": { "kind": "comfy", "folder": "diffusion_models" } },
    { "key": "loras",      "label": "LoRA",       "type": "lora-select",  "required": false, "default": [] },
    { "key": "seed",       "label": "种子",       "type": "seed",         "required": false, "default": -1 },
    { "key": "width",      "label": "宽",         "type": "number",       "required": false, "default": 832 },
    { "key": "height",     "label": "高",         "type": "number",       "required": false, "default": 1216 },
    { "key": "autoRandom", "label": "随机提示词", "type": "switch",       "required": false, "default": false }
  ],

  "bindings": [
    { "target": "17.inputs.unet_name", "from": "unet_name" },
    { "target": "6.inputs.text",       "from": "negative" },
    { "target": "3.inputs.seed",       "from": "seed", "transform": "seed" },
    { "target": "5.inputs.width",      "from": "width" },
    { "target": "5.inputs.height",     "from": "height" },
    { "target": "19.inputs.auto_random","from": "autoRandom" }
  ],

  "promptBinding": {
    "node": "19",
    "positiveField": "positive",
    "tempStrField": "temp_str",
    "loraField": null
  },

  "outputs": {
    "nodes": ["21"],
    "type": "image"
  },

  "graph": { /* 完整 API 格式 graph，同 api.example.json */ }
}
```

---

## 3. 字段参考

### 3.1 `inputs[]`

| 字段 | 必填 | 说明 |
|------|------|------|
| `key` | ✅ | 唯一标识，binding 引用它 |
| `label` | ✅ | 前端显示名 |
| `type` | ✅ | 控件类型（见 §3.2） |
| `required` | | 是否必填 |
| `default` | | 默认值 |
| `source` | | 选项来源：`{kind:"comfy"\|"weilin"\|"static", ...}` |
| `ui` | | 控件细节：`rows`、`placeholder`、`min`、`max`、`step`、`multiple`、`row`、`swap` |

#### `ui.row` 与 `ui.swap`（前端布局）

| 键 | 作用 |
|----|------|
| `ui.row` | **同行布局**。`row` 值相同的字段排在同一行（按首次出现顺序）。用于「种子 / 步数 / CFG」这类短数值字段。未声明则独占一行。 |
| `ui.swap` | **一键交换**。点击 ⇄ 时把本字段的值与 `swap` 指向的字段互换。典型用法：`width` 声明 `swap: "height"`，⇄ 按钮渲染在 `width` 之后。 |

```jsonc
// 短数值字段并排
{ "key": "seed",  "type": "seed",   "ui": { "row": "sampling" } },
{ "key": "steps", "type": "number", "ui": { "row": "sampling", "min": 1, "max": 200 } },
{ "key": "cfg",   "type": "number", "ui": { "row": "sampling", "min": 0, "max": 30, "step": 0.1 } },

// 宽高同行 + 一键交换
{ "key": "width",  "type": "number", "ui": { "row": "size", "swap": "height", "min": 64, "max": 4096, "step": 8 } },
{ "key": "height", "type": "number", "ui": { "row": "size", "min": 64, "max": 4096, "step": 8 } }
```

> 布局是**纯前端关注点**：`ui.row` / `ui.swap` 不影响 graph 渲染，
> 后端只做透传。窄屏（< 520px）下同行字段会自动换行，避免挤成一团。

> **移除字段时记得同步删 `bindings`**：`binding.from` 指向不存在的 input 会导致
> 模板静态校验失败、服务启动报错（这是有意为之的快速失败）。
> 反过来，删掉 `binding` 而不删 input 只是让该字段无效；
> 若字段本就不该暴露，直接删 input + binding，graph 会保留原值。
| `visibleIf` | | 条件显示：`{ "key": "autoRandom", "equals": true }` |
| `description` | | 帮助文本 |

### 3.2 `type` 取值

| type | 控件 | 值类型 |
|------|------|--------|
| `text` | 单行输入 | `string` |
| `textarea` | 多行输入 | `string` |
| `number` | 数字输入 | `number` |
| `slider` | 滑块 | `number` |
| `select` | 下拉 | `string` |
| `switch` | 开关 | `boolean` |
| `seed` | 种子输入（-1 = 随机） | `number` |
| `model-select` | 模型下拉（按 folder 分组） | `string` |
| `lora-select` | LoRA 选择器（含权重） | `LoraRef[]` |
| `tag-selector` | 标签选择器（WeiLin 标签库） | `string` 或 `Token[]` |
| `image-upload` | 图片上传 | `{name,subfolder,type}` |

### 3.3 `bindings[]`

| 字段 | 说明 |
|------|------|
| `target` | graph 中的写入路径：`"<nodeId>.inputs.<field>"` |
| `from` | 取哪个 input 的值；省略则用 `const` |
| `const` | 常量写入 |
| `transform` | 值变换（见 §4） |
| `when` | 条件绑定：不满足则跳过（保留 graph 原值） |

**校验规则（静态）**：
- `target` 指向的 node 必须存在于 `graph`
- 写入字段必须存在于该 node 的 `inputs`（或标记 `"create": true` 允许新增）
- `from` 必须存在于 `inputs[]`

### 3.4 `promptBinding` — **WeiLin 专用**

这是与 WeiLin 节点对接的核心配置（详见 [v1-weilin.md](./v1-weilin.md)）。

| 字段 | 说明 |
|------|------|
| `node` | WeiLin 提示词节点的 ID（如 `"19"`） |
| `positiveField` | 正向提示词字段名，通常 `"positive"` |
| `tempStrField` | 富文本/临时提示词字段，通常 `"temp_str"` |
| `loraField` | LoRA 字段名；`WeiLinPromptUIOnlyLoraStack` 用 `"lora_str"` |

### 3.5 `outputs`

| 字段 | 说明 |
|------|------|
| `nodes` | 哪些节点产出结果（通常是 `SaveImage`/`PreviewImage` 节点） |
| `type` | `image` \| `video` \| `audio` \| `file` |

---

## 4. `transform` 变换器

| 名称 | 作用 |
|------|------|
| `seed` | `-1` → 随机 `0..2^32`；否则原值 |
| `join` | 数组 → 字符串，分隔符由 `args.sep` 指定 |
| `json` | 值 → JSON 字符串（**WeiLin 的 `positive`/`lora_str` 需要**） |
| `weilinTokens` | `Token[]` → WeiLin `temp_str` 格式的 JSON 字符串 |
| `weilinLora` | `LoraRef[]` → WeiLin `lora_str` 格式的 JSON 数组字符串 |
| `weilinLoraTags` | `LoraRef[]` → `<wlr:名:模型权重:CLIP权重:触发词权重>` 标签串 |
| `prefixComma` | 与固定前缀拼接：`opt_text + ", " + value` |
| `clamp` | 数值钳制到 `args.min`/`args.max` |

### 关键：`weilinTokens`

把前端标签选择器的 token 列表，转成 WeiLin 的 `temp_str` 格式：

```jsonc
// 前端值
[
  { "text": "black bodystocking", "translate": "黑色 全身袜", "color": "rgba(230, 84, 128, .4)" }
]
```

```jsonc
// 渲染进 graph 的字符串（注意是 JSON 字符串）
"[{\"id\":\"token_1_1789573777842\",\"text\":\"black bodystocking\",\"translate\":\"黑色 全身袜\",\"isPunctuation\":false,\"isEditing\":false,\"isHidden\":false,\"color\":\"rgba(230, 84, 128, .4)\",\"isLoraTag\":false}]"
```

> `id` 由服务器生成（`token_<seq>_<epochMs>`），格式与 WeiLin 前端一致。

### 关键：`weilinLora`

```jsonc
// 前端值
[{ "name": "Anima\\style_v2.safetensors", "weight": 0.8, "clipWeight": 0.8 }]
```

```jsonc
// 渲染进 graph（JSON 字符串）—— 实测自 api.example.json 节点 43
"[{
   \"name\":\"Anima\\\\画师\\\\taffy-style\",
   \"lora\":\"Anima\\\\\\\\画师\\\\\\\\taffy-style.safetensors\",
   \"weight\":0.9,
   \"text_encoder_weight\":1,
   \"trigger_weight\":1,
   \"display_name\":\"taffy-style - v1.0\",
   \"loraWorks\":\"@bantan\",
   \"hidden\":false
}]"
```

> **字段映射**：`name`→`lora`（补 `.safetensors`）、`weight`→`weight`、
> `clipWeight`→`text_encoder_weight`。
> 节点实际读取 `lora`/`weight`/`text_encoder_weight`/`trigger_weight`；
> `display_name`/`loraWorks`/`hidden` 仅供 UI（`__init__.py:437-445`）。
>
> ⚠️ **反斜杠转义是本项目最易出错处**：LoRA 名含 `\`（如 `Anima\画师\x`），
> 在 JSON 字符串里要写成 `\\`，再作为 JSON 字符串嵌入 graph 又要再转义一层。
> **建议在实现时用「先构造对象、再 `JSON.stringify` 一次」的方式，绝不手写字符串。**

### 关键：`weilinLoraTags`

生成内嵌标签串（写进 `positive`），与 `weilinLora` 二选一或并用：

```jsonc
// LoraRef[] →
"<wlr:Anima\\画师\\taffy-style:0.9:1:1>"
```

> 名称**不含** `.safetensors`（节点自动补），格式见 [v1-weilin.md](./v1-weilin.md) §4.2。

---

## 5. 渲染流程

```
render(template, values):
  1. clone = deepClone(template.graph)
  2. 校验 values 对 template.inputs（必填、类型、范围）
  3. for b in template.bindings:
       if b.when 且不满足 → continue
       raw   = b.const ?? values[b.from]
       value = applyTransform(b.transform, raw, b.args)
       setPath(clone, b.target, value)
  4. 应用 promptBinding（见下）
  5. return clone
```

### 5.1 `promptBinding` 的渲染细节

依据 WeiLin 节点源码，有两条路径：

**路径 A：把提示词放进 `positive`（纯文本）**

```python
# WeiLin 节点 encode()
if is_json(positive): text_dec = json.loads(positive).get("prompt","")
else:                text_dec = positive
if len(opt_text) > 0: text_dec = opt_text + ", " + text_dec
```

→ 直接 `node.inputs.positive = userPrompt` 即可，最简路径。

**路径 B：富文本 + 标签着色**

→ `node.inputs.positive = json.dumps({"prompt": userPrompt})`
→ `node.inputs.temp_str = <weilinTokens 序列化结果>`

> **v1 建议**：默认走**路径 A**（简单可靠），把路径 B 作为可选增强（保留标签翻译/着色体验）。
> 这是一个**待你决策的点（Q9）**。

### 5.2 前置注入 `opt_text`

在示例中，节点 `19` 的 `opt_text` 是**连线输入** `["43", 0]`（取节点 `43` 的 STRING 输出）。
若要注入固定前缀（质量词、画师串），有两种做法：

- **做法 1（推荐）**：模板图中放一个文本节点（如 `CR Text`／`String`）提供文本，
  服务器改**那个节点**的值 —— 不破坏连线，最稳。
- **做法 2**：`opt_text` 类型是 `ANY`，理论上可直传字面量字符串。

> 源码 `opt_text: (ANY, {"default": ""})` 且判定为 `len(opt_text) > 0`，
> **做法 2 可能可行**（传字符串字面量），但需**冒烟验证（H5）**。
> 示例中 `33`（负向）已经从 `["43", 2]` 取 CLIP，说明链路复用是常规做法。

### 5.3 LoRA 与触发词（见 [v1-weilin.md](./v1-weilin.md) §4–5）

**结论：只需写节点的字符串字段，节点自行完成加载与触发词注入。**

| 写到哪 | 内容 | transform |
|--------|------|-----------|
| `43` `WeiLinPromptUI.lora_str` | 富格式 JSON 数组 | `weilinLora` |
| `43` `WeiLinPromptUI.positive` | **只放** `<wlr:name:mw:cw:tw>` 标签（无正文） | `weilinLoraTags` |
| `19` `WeiLinPromptUIWithoutLora.positive` | 主提示词正文 | 直接写 |
| `WeiLinPromptUIOnlyLoraStack.lora_str` | 同上（**但不注入触发词**） | `weilinLora` |

**`<wlr:...>` 标签格式**（`lora_stack.vue:302`）：

```
<wlr:LoRA名:模型权重:CLIP权重:触发词权重>     ← 新格式(4参)
<wlr:LoRA名:模型权重:CLIP权重>                ← 旧格式(3参)
```

#### 本项目的拆分式模板约定（重要）

沿用示例工作流的**单一职责拆分**，模板应保持：

```
43  WeiLinPromptUI             → 只装 LoRA + 触发词，positive 只放标签（无正文）
19  WeiLinPromptUIWithoutLora  → 只装主提示词，不加载 LoRA、不注入
28/33 质量词节点                → 只装质量词
```

**为什么 `43.positive` 必须"只有标签、没有正文"**：
节点会把标签剥离后再注入触发词，若 `positive` 里有正文，
触发词就会和主提示词在**同一个节点**混合，失去拆分意义。

> **触发词来源的两种模式（Q15）**：
> - **用 `WeiLinPromptUI`** → 节点自动注入，来源 Civitai/元数据/文件名（**不读用户编辑的 `loraWorks`**）
> - **用 `OnlyLoraStack`** → 不注入，触发词由我们按 `loraWorks` 拼（**用户编辑生效**）
>
> 本拆分设计**不会重复注入**（43 无正文、19 不注入）。
> 详见 [v1-weilin.md](./v1-weilin.md) §5.3 的方案 A/B/C。
> 若选方案 B，模板 `promptBinding` 需记录 LoRA 节点与触发词注入目标节点。

---

## 6. 模板制作工作流

### 6.1 如何从 ComfyUI 导出的工作流得到模板

```
1. 在 ComfyUI 原生界面搭好工作流，用「导出 (API Format)」得到 api.json
2. 放到 templates/<id>/api.json
3. 写 template.json：
   - graph 字段 = api.json 内容
   - 对照 api.json 找出「想暴露给用户」的字段
   - 为每个字段写 inputs[] 条目 + bindings[] 条目
4. 运行 `pnpm template:validate <id>` 校验
5. 运行 `pnpm template:preview <id> --values values.json` 查看渲染结果 diff
```

### 6.2 辅助工具（v1 计划实现）

| 命令 | 作用 |
|------|------|
| `template:validate` | 静态校验：binding 路径存在、类型匹配 |
| `template:preview` | 渲染并 diff，展示哪些字段被改动 |
| `template:init <api.json>` | 从 api.json 生成 template.json 骨架（自动列出可绑定字段） |
| `template:check-live` | 用 `/object_info` 在线校验 graph 合法性 |

> `template:init` 能大幅降低手工成本：解析 graph，把每个 scalar input 列成候选 binding。

---

## 7. 校验与错误

### 7.1 静态校验（服务器启动时）

- `id` 唯一、必填字段齐全
- `bindings[].target` 的 node 存在于 `graph`
- `bindings[].target` 的字段存在于 `graph[node].inputs`（除非 `create:true`）
- `bindings[].from` 存在于 `inputs[]`
- `promptBinding.node` 存在于 `graph`
- `outputs.nodes` 存在于 `graph`

失败 → **启动即报错**（快速失败，不静默降级）。

### 7.2 动态校验（每次提交）

- 渲染后的 graph 对 `/object_info` 校验：
  - `class_type` 存在
  - 必填 input 齐全
  - 类型匹配（尤其 COMBO 的 enum 值有效）
- `requirements.nodes` 全部可用（探测 WeiLin 是否加载）

失败 → `422 GRAPH_VALIDATION_FAILED`，附 `node_errors` 明细。

---

## 8. 版本化

- 模板有 `version`；任务记录保存**当时的模板快照 hash**
  → 复现历史任务时使用历史快照，不受模板后续修改影响
- 模板目录纳入 git；`source.file` 记录来源工作流

---

## 9. 示例：完整的 `txt2img-basic` 模板

见 §2 的 JSON。对应原始 `api.example.json` 的映射关系：

| 原始节点 | 原始字段 | 模板 input | 说明 |
|----------|----------|-----------|------|
| `17` `UNETLoader` | `unet_name` | `unet_name` | 模型选择 |
| `19` `WeiLinPromptUIWithoutLora` | `positive` | `prompt` | 提示词（核心） |
| `19` | `temp_str` | （由 `prompt` 派生） | 标签富文本 |
| `19` | `auto_random` | `autoRandom` | 随机提示词开关 |
| `19` | `random_template` | （保留原值） | 随机模板路径 |
| `21` `SaveImage` | `filename_prefix` | `prefix`（可选） | 输出前缀 |

---

## 10. 待确认

| # | 问题 |
|---|------|
| Q2 | 模板格式是否采用本文的 **`inputs` + `bindings` + `graph`** 结构？还是倾向更薄的方案（如仅 `inputs` + JSON Pointer 映射）？ |
| Q9 | `positive` 走**纯文本**（路径 A）还是**JSON 富文本**（路径 B）？ |
| **Q18** | **LoRA 写入载体**：`lora_str`（富 JSON）还是 `positive` 内嵌 `<wlr:>` 标签？（可并用） |
| **Q19** | 触发词方案（Q15）若选 B，触发词**由服务器拼**还是**由前端拼**后再提交？ |
| Q10 | 是否需要 `template:init` 这类自动生成工具（会增加 v1 工作量）？ |
| Q11 | 同一模板是否需要**多套预设（preset）**（如"写实/动漫"切换一组默认值）？ |
