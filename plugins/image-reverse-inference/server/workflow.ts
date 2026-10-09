/**
 * 工作流：载入 `workflow.json` + 把「上传的文件 / 本次参数」写进对应节点。
 *
 * 产物在 tab 根，所以 `import.meta.url` 定位到的 `./workflow.json` 就是
 * `tabs/image-reverse-inference/workflow.json`（pack.mjs 拷过去的运行期资产）。
 */
import fs from 'node:fs';

import type { Graph, GraphNode, TaggerParams, UploadedImage, WorkflowBindings } from './model.js';

export const WORKFLOW_FILE = new URL('./workflow.json', import.meta.url);

export function loadWorkflow(): Graph {
  const raw: unknown = JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('workflow.json 不是一个「节点号 → 节点」的 JSON 对象');
  }
  return raw as Graph;
}

function findNode(
  graph: Graph,
  match: (node: GraphNode) => boolean,
  label: string,
): [string, GraphNode] {
  for (const [nodeId, node] of Object.entries(graph)) {
    if (node && typeof node.class_type === 'string' && match(node)) return [nodeId, node];
  }
  throw new Error(`工作流里找不到 ${label} 节点`);
}

/**
 * 解析绑定：**全部靠 class_type 现找，一个节点号都不写死** ——
 * 在 ComfyUI 里拖动节点、重新导出，这里都不会失效。
 *
 * 认 `WD14Tagger*` 前缀而不是写死 `WD14Tagger|pysssss`：同一个节点包换个后缀
 * （`|pysssss` 是作者署名）不该让插件当场坏掉。
 */
export function resolveBindings(graph: Graph): WorkflowBindings {
  const [loadImageId] = findNode(graph, (node) => node.class_type === 'LoadImage', 'LoadImage');
  const [taggerId, taggerNode] = findNode(
    graph,
    (node) => node.class_type.startsWith('WD14Tagger'),
    'WD14Tagger（ComfyUI-WD14-Tagger / pysssss 节点包）',
  );
  // 模型只**读**不写：它是工作流的事实，换模型 = 换 workflow.json（重新导出）
  const taggerModel =
    typeof taggerNode.inputs?.model === 'string' ? taggerNode.inputs.model.trim() : '';
  let previewId: string | null = null;
  try {
    [previewId] = findNode(graph, (node) => node.class_type === 'PreviewAny', 'PreviewAny');
  } catch {
    // PreviewAny 只是兜底的取文本来源，没有它也能从 tagger 自己的输出里拿
    previewId = null;
  }
  return { loadImageId, taggerId, taggerModel, previewId };
}

/**
 * `LoadImage.image` 要填的值。
 *
 * 实测：`subfolder` 非空时必须写成 `subfolder/name`，只写 `name` 会被
 * ComfyUI 的 combo 校验判为「不在 input/ 里」。
 */
export function imageInputValue(uploaded: UploadedImage): string {
  return uploaded.subfolder === '' ? uploaded.name : `${uploaded.subfolder}/${uploaded.name}`;
}

/** 生成本次要提交的图：原图不动（浅拷一层节点 + 深拷 inputs） */
export function renderGraph(
  graph: Graph,
  bindings: WorkflowBindings,
  uploaded: UploadedImage,
  params: TaggerParams,
): Graph {
  const out: Graph = {};
  for (const [nodeId, node] of Object.entries(graph)) {
    out[nodeId] = { ...node, inputs: { ...node.inputs } };
  }

  const loadImage = out[bindings.loadImageId];
  const tagger = out[bindings.taggerId];
  if (loadImage === undefined || tagger === undefined) {
    throw new Error('工作流绑定失效：节点在这次提交里不见了');
  }

  loadImage.inputs.image = imageInputValue(uploaded);
  // 输入名就是 WD14Tagger 的 INPUT_TYPES（object_info 实测）：model / threshold /
  // character_threshold / replace_underscore / trailing_comma / exclude_tags。
  // `model` **故意不写**：它是工作流的事实，插件覆盖它就会让「升级工作流顺带换模型」失效。
  tagger.inputs.threshold = params.threshold;
  tagger.inputs.character_threshold = params.characterThreshold;
  tagger.inputs.replace_underscore = params.replaceUnderscore;
  tagger.inputs.trailing_comma = params.trailingComma;
  tagger.inputs.exclude_tags = params.excludeTags;

  return out;
}
