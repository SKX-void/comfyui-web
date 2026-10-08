import type { Graph, Job, JobProgress } from '@comfyui-web/shared';

/**
 * 执行计划：把 ComfyUI 的「节点号」翻译成「在干什么」，并算出**整条工作流**的总进度。
 *
 * 为什么要有这一层：
 * - 上游事件只带节点号（`executing 27`），照原样显示就是「节点 27」，用户看不出那是在
 *   VAE 解码还是在采样；
 * - 上游的 `progress` 只覆盖**当前节点内部**（采样步），VAE 解码这类节点压根没有进度事件，
 *   直接拿单节点的 value/max 画条，就会"每换一个节点归零一次"。
 *
 * 所以进度按整张图算：**已完成节点的权重 + 当前节点内部比例**。节点号一个都不写死 ——
 * 计划从 workflow.json 推导；权重是经验比例，只求"采样占大头"这个形状对。
 */

/** class_type -> 人话。查不到的见 nodeLabel 的兜底（绝不退回节点号） */
const LABELS: Record<string, string> = {
  UNETLoader: '加载 UNet 模型',
  CheckpointLoaderSimple: '加载模型',
  CLIPLoader: '加载 CLIP 文本编码器',
  DualCLIPLoader: '加载双 CLIP 编码器',
  VAELoader: '加载 VAE',
  WeiLinPromptUIOnlyLoraStack: '加载 LoRA',
  WeiLinPromptUIWithoutLora: '处理提示词',
  'CR Text': '拼接质量词',
  CLIPTextEncode: '提示词编码',
  CLIPTextEncodeSDXL: '提示词编码',
  EmptyLatentImage: '创建空白潜空间',
  AnimaTeaCache: '启用 TeaCache 加速',
  AnimaLayerReplayPatcher: '应用 Anima 增强',
  VAEDecode: 'VAE 解码',
  VAEDecodeTiled: 'VAE 分块解码',
  VAEEncode: 'VAE 编码',
  SaveImage: '保存图片',
  SaveImagePlus: '保存图片',
  PreviewImage: '预览图片',
};

/** class_type -> 进度权重（相对值，只看比例）。表外的按 1 算 */
const WEIGHTS: Record<string, number> = {
  UNETLoader: 6,
  CheckpointLoaderSimple: 6,
  CLIPLoader: 6,
  DualCLIPLoader: 6,
  VAELoader: 6,
  WeiLinPromptUIOnlyLoraStack: 2,
  WeiLinPromptUIWithoutLora: 2,
  VAEDecode: 15,
  VAEDecodeTiled: 15,
  VAEEncode: 6,
  SaveImage: 2,
  SaveImagePlus: 2,
};

/** 采样节点一律给这个权重：一次出图的时间基本都花在它身上 */
const SAMPLER_WEIGHT = 60;

const isSampler = (classType: string): boolean => /sampler/i.test(classType);

/**
 * 节点的可读描述。表里没有就退回类型名（至少能看出是什么节点），名字里带 Sampler 的
 * （KSampler / ClownsharKSampler_Beta / SamplerCustomAdvanced…）统一叫「K 采样」。
 */
export function nodeLabel(classType: string): string {
  return LABELS[classType] ?? (isSampler(classType) ? 'K 采样' : classType);
}

function nodeWeight(classType: string): number {
  return WEIGHTS[classType] ?? (isSampler(classType) ? SAMPLER_WEIGHT : 1);
}

export interface Stage {
  nodeId: string;
  classType: string;
  label: string;
  weight: number;
}

export interface StagePlan {
  stages: Map<string, Stage>;
  /** 权重合计（分母）；至少 1，避免除零 */
  total: number;
}

export function buildPlan(graph: Graph): StagePlan {
  const stages = new Map<string, Stage>();
  let total = 0;
  for (const [nodeId, node] of Object.entries(graph)) {
    const classType = String(node.class_type);
    const weight = nodeWeight(classType);
    stages.set(nodeId, { nodeId, classType, label: nodeLabel(classType), weight });
    total += weight;
  }
  return { stages, total: Math.max(total, 1) };
}

/** 按图缓存：事件回调每条都要问一次计划，别每条都遍历整张图 */
const planCache = new WeakMap<Graph, StagePlan>();

export function planFor(graph: Graph): StagePlan {
  let plan = planCache.get(graph);
  if (!plan) {
    plan = buildPlan(graph);
    planCache.set(graph, plan);
  }
  return plan;
}

/**
 * 某个任务的进度追踪器。
 *
 * 状态挂在 Job 对象上（WeakMap）：任务从 jobs 表里淘汰后由 GC 一并回收，
 * 不必再去 retention / sweep / finalize 每条清理路径上手动删一遍。
 */
const trackers = new WeakMap<Job, ProgressTracker>();

export function trackerFor(job: Job, plan: StagePlan): ProgressTracker {
  let tracker = trackers.get(job);
  if (!tracker) {
    tracker = new ProgressTracker(plan);
    trackers.set(job, tracker);
  }
  return tracker;
}

export class ProgressTracker {
  /** 已经跑完的节点（含被上游缓存跳过的） */
  private readonly done = new Set<string>();
  private running: string | null = null;
  /** 当前节点内部的比例 0~1；这个节点没有进度事件时为 null */
  private fraction: number | null = null;
  private ended = false;

  constructor(private readonly plan: StagePlan) {}

  /** 当前正在跑的节点号（上游个别事件不带 node，得靠它兜） */
  get node(): string | null {
    return this.running;
  }

  get label(): string | null {
    return this.running ? (this.plan.stages.get(this.running)?.label ?? null) : null;
  }

  /** 开始跑某个节点；上一个还没被认领完成的，此刻就算完成（执行是串行的） */
  start(nodeId: string): void {
    if (this.running && this.running !== nodeId) this.done.add(this.running);
    this.running = nodeId;
    this.fraction = null;
    this.ended = false;
  }

  /** 节点内部的步进（采样那种）；上游没给 max 时保持"算不出来" */
  step(value: number, max: number): void {
    this.fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : null;
  }

  /** 上游说这个节点结束了 / 被缓存跳过了 */
  finish(nodeId: string): void {
    this.done.add(nodeId);
    if (this.running === nodeId) {
      this.running = null;
      this.fraction = null;
    }
  }

  /** 整条任务结束（executing=null）：漏了谁的收尾事件都无所谓，一律收在 100% */
  finishAll(): void {
    if (this.running) this.done.add(this.running);
    this.running = null;
    this.fraction = null;
    this.ended = true;
  }

  /** 0~100。没结束前最多 99 —— 不许任务还在跑就显示 100% */
  get overall(): number {
    if (this.ended) return 100;
    let weight = 0;
    for (const nodeId of this.done) weight += this.plan.stages.get(nodeId)?.weight ?? 0;
    const running = this.running ? (this.plan.stages.get(this.running)?.weight ?? 0) : 0;
    const pct = ((weight + running * (this.fraction ?? 0)) / this.plan.total) * 100;
    return Math.max(0, Math.min(99, Math.round(pct)));
  }

  /** 写进 `Job.progress` 的那一份：value/max 是**当前节点**自己的步数 */
  snapshot(value: number, max: number): JobProgress {
    return { value, max, node: this.running, label: this.label, overall: this.overall };
  }
}
