import { computed, reactive, type Ref } from 'vue';

import type { Job, JobValues, PluginOptions } from '../api';

/**
 * 护栏上下限的兜底值：`/options` 还没回来时就用它渲染输入框的 min/max。
 * 必须与后端 `SAFETY` 一致 —— 契约测试会核对渲染出来的 max。
 */
const LIMIT_FALLBACK = { minSteps: 1, maxSteps: 32, minSide: 64, maxSide: 1216 };

export const SIZE_PRESETS = [
  { label: '832×1216', width: 832, height: 1216 },
  { label: '1216×832', width: 1216, height: 832 },
  { label: '1024²', width: 1024, height: 1024 },
  { label: '768×1024', width: 768, height: 1024 },
  { label: '512×768', width: 512, height: 768 },
];

/** 表单状态与它的派生值（作业状态与请求在 useJob.ts） */
export function useForm(options: Ref<PluginOptions | null>) {
  const form = reactive({
    description: '',
    positive: '',
    negative: '',
    randomSeed: true,
    seed: 0,
    steps: 20,
    cfg: 7,
    sampler: 'euler',
    scheduler: 'simple',
    width: 1024,
    height: 1024,
    batch: 1,
    rotation: 'none',
    lora: '',
    loraStrength: 1,
    unet: '',
    clip: '',
    vae: '',
  });

  const limits = computed(() => options.value?.limits ?? LIMIT_FALLBACK);

  /**
   * 与后端 `joinPrompt()`（plugins/anima-example/server/util.js）**逐字一致**的拼接预览。
   * 两边必须同步改，否则这里显示的不是真正发出去的东西。
   */
  const joinedPrompt = computed(() =>
    [form.description, form.positive]
      .map((text) => String(text ?? '').trim().replace(/^[,\s]+/, '').replace(/[,\s]+$/, ''))
      .filter((text) => text !== '')
      .join(', '),
  );

  /** 把 ComfyUI 报回来的工作流默认值灌进表单 */
  function applyDefaults(o: PluginOptions): void {
    const d = o.defaults;
    form.description = d.description ?? '';
    form.positive = d.positive;
    form.negative = d.negative;
    form.seed = d.seed;
    form.steps = d.steps;
    form.cfg = d.cfg;
    form.sampler = d.sampler;
    form.scheduler = d.scheduler;
    form.width = d.width;
    form.height = d.height;
    form.batch = d.batch;
    form.rotation = d.rotation ?? 'none';
    form.lora = d.lora ?? '';
    form.loraStrength = d.loraStrength ?? 1;
    form.unet = d.unet ?? '';
    form.clip = d.clip ?? '';
    form.vae = d.vae ?? '';
  }

  /** 把作业的参数灌回表单 */
  function loadValues(job: Job): void {
    form.description = job.values.description;
    form.positive = job.values.positive;
    form.negative = job.values.negative;
    form.randomSeed = false;
    form.seed = job.values.seed;
    form.steps = job.values.steps;
    form.cfg = job.values.cfg;
    form.sampler = job.values.sampler;
    form.scheduler = job.values.scheduler;
    form.width = job.values.width;
    form.height = job.values.height;
    form.batch = job.values.batch;
    if (job.values.rotation) form.rotation = job.values.rotation;
    if (job.values.lora) form.lora = job.values.lora;
    if (job.values.loraStrength !== null) form.loraStrength = job.values.loraStrength;
    if (job.values.unet) form.unet = job.values.unet;
    if (job.values.clip) form.clip = job.values.clip;
    if (job.values.vae) form.vae = job.values.vae;
  }

  function rollSeed(): void {
    form.seed = Math.floor(Math.random() * 2 ** 53);
    form.randomSeed = false;
  }

  /** 提交体：`seed: -1` 表示让后端每次随机 */
  function toPayload(): Partial<JobValues> {
    return {
      description: form.description,
      positive: form.positive,
      negative: form.negative,
      seed: form.randomSeed ? -1 : Number(form.seed),
      steps: Number(form.steps),
      cfg: Number(form.cfg),
      sampler: form.sampler,
      scheduler: form.scheduler,
      width: Number(form.width),
      height: Number(form.height),
      batch: Number(form.batch),
      rotation: form.rotation,
      lora: form.lora,
      loraStrength: Number(form.loraStrength),
      unet: form.unet,
      clip: form.clip,
      vae: form.vae,
    };
  }

  return { form, limits, joinedPrompt, applyDefaults, loadValues, rollSeed, toPayload };
}
