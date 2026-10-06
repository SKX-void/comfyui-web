/**
 * 硬件安全护栏（plugins/anima-plus/docs/safety.md）。
 *
 * 目的：**任何**离开本进程、发往 ComfyUI 的图，都不允许含有会打爆显存/显存带宽的取值。
 * 服务要给别人用，所以这里不信任任何上游（模板、transform、预设、未来的新入口）。
 *
 * 三层防线（越靠后越"绝对"）：
 *   1. 表单值：`coerceValues` 用策略推导出的边界直接拒绝（错误信息友好，指向具体字段）
 *   2. 渲染结果：`guardGraph` 扫描**最终图**；能追溯到用户输入的 → 拒绝，
 *      只来自模板的 → 夹紧到安全值并告警（模板作者的错误不该拖垮服务）
 *   3. 出口：`ComfyClient.submit` 前的 `assertGraphSafe`，纯断言、不改图。
 *      走到这一步还有越界，说明前面有 bug —— 宁可提交失败，也不许打到 GPU。
 *
 * 规则只按**节点输入字段名**匹配，与模板解耦：模板改了、换了、加了新的，
 * 只要字段名还是 `width`/`height`/`steps`，照样被管住。
 */

// ---------------------------------------------------------------------------
// 上限常量（要调就改这里，别改模板）
// ---------------------------------------------------------------------------

/**
 * 采样步数上限。
 *
 * 比 anima-example 的 32 更紧，是本插件工作流的特性决定的：这里是**多 LoRA 叠加**的系统，
 * 配套的 Turbo 工作流 6 步就能出图 —— 步数往上走收益很小，代价却是每次都要重算全部 LoRA
 * 权重。每个插件管自己的上限（核不管业务），所以这个数字只属于本插件。
 */
export const MAX_STEPS = 24;

/** 图像单边最大像素 */
export const MAX_SIDE = 1216;

/** 图像单边最小像素（挡住 1×1 这类退化输入） */
export const MIN_SIDE = 64;

/** 单个任务里 LoRA 堆叠的数量上限（每个 LoRA 都要常驻一份权重） */
export const MAX_LORAS = 8;

/** 批量张数上限。1 表示"一次只出一张"——显存随张数线性增长 */
export const MAX_BATCH = 1;

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/** 数值规则：命中节点的数值字段，越界可夹紧 */
export interface NumericLimit {
  id: string;
  /** 中文名，出现在报错与告警里 */
  label: string;
  /** 命中的节点输入字段名（小写精确匹配） */
  fields: readonly string[];
  min?: number;
  max?: number;
  /** 必须是整数（不是整数时向下取整） */
  integer?: boolean;
  /** 豁免值（例如 steps_to_run = -1 表示"跑满 steps"） */
  exempt?: readonly number[];
}

/**
 * 数量规则：命中节点的**字符串字段**（JSON 数组），超量一律拒绝、不截断。
 *
 * 为什么不夹紧：截断 LoRA 堆等于悄悄丢掉用户选的 LoRA，
 * 出来的图不对还查不出原因，不如直接报错。
 */
export interface CountLimit {
  id: string;
  label: string;
  fields: readonly string[];
  max: number;
  /** 字段值的形态，目前只有 JSON 数组字符串 */
  format: 'json-array';
}

export const DEFAULT_LIMITS: readonly NumericLimit[] = [
  {
    id: 'steps',
    label: '采样步数',
    fields: ['steps'],
    min: 1,
    max: MAX_STEPS,
    integer: true,
  },
  {
    // 与 steps 分开列，因为 `-1` 这个哨兵只对 steps_to_run 有意义
    //（表示"跑满 steps"）；对 steps 而言 -1 是非法值，必须被 min 拦住。
    id: 'steps_to_run',
    label: '实际执行步数',
    fields: ['steps_to_run'],
    min: 1,
    max: MAX_STEPS,
    integer: true,
    exempt: [-1],
  },
  {
    id: 'size',
    label: '图像尺寸',
    fields: ['width', 'height', 'target_width', 'target_height'],
    min: MIN_SIDE,
    max: MAX_SIDE,
    integer: true,
  },
  {
    id: 'batch',
    label: '批量张数',
    fields: ['batch_size'],
    min: 1,
    max: MAX_BATCH,
    integer: true,
  },
  {
    // 采样器（ClownsharKSampler_Beta）把 seed 声明成 INT，上界 ≈ 2^64。
    // 不设这条，1e20 这种超范围值会原样落图，提交后才在 ComfyUI 侧报错。
    // exempt 里的 -1 是"每次随机"的占位值，在 render 里就已经被换成具体数了。
    id: 'seed',
    label: '随机种子',
    fields: ['seed'],
    min: -1,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
    exempt: [-1],
  },
];

export const DEFAULT_COUNT_LIMITS: readonly CountLimit[] = [
  {
    // 只盯 lora_str / temp_lora_str：它们是 LoRA 数组的**源头**。
    // 19.inputs.positive 是主提示词、28.inputs.text 是质量词（触发词前缀也落在它上面），
    // 都不能按这个规则数。
    id: 'loras',
    label: 'LoRA 数量',
    fields: ['lora_str', 'temp_lora_str'],
    max: MAX_LORAS,
    format: 'json-array',
  },
];

/** 字段名 → 规则（同一字段命中多条规则时取第一条；本表内不会重复） */
export function limitForField(
  field: string,
  limits: readonly NumericLimit[] = DEFAULT_LIMITS,
): NumericLimit | undefined {
  const key = field.toLowerCase();
  return limits.find((r) => r.fields.includes(key));
}

export function countLimitForField(
  field: string,
  limits: readonly CountLimit[] = DEFAULT_COUNT_LIMITS,
): CountLimit | undefined {
  const key = field.toLowerCase();
  return limits.find((r) => r.fields.includes(key));
}

// ---------------------------------------------------------------------------
// 扫描结果
// ---------------------------------------------------------------------------

