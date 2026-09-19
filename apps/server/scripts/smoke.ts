/**
 * 冒烟测试：不依赖外部服务，验证「模板 → 渲染 → 提交 → 进度 → 出图」链路。
 *
 * 运行：pnpm --filter @comfyui-server/server smoke
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, normalizeBaseUrl, parseJsonc } from '../src/config.js';
import { TemplateRegistry, validateTemplate } from '../src/templates/loader.js';
import { renderTemplate, coerceValues } from '../src/templates/render.js';
import {
  MAX_BATCH,
  MAX_LORAS,
  MAX_SIDE,
  MAX_STEPS,
  assertGraphSafe,
  effectiveBounds,
  guardGraph,
  narrowTemplateBounds,
  scanGraph,
} from '../src/safety/limits.js';
import {
  MAX_BODY_BYTES,
  MAX_JOBS_RETAINED,
  MAX_QUEUE_DEPTH,
} from '../src/safety/quota.js';
import { MockComfyClient } from '../src/comfy/mock.js';
import { JobManager, decodeAssetId } from '../src/jobs/manager.js';
import { browseLoras } from '../src/weilin/browse.js';
import { openDatabase, closeDatabase, userVersion } from '../src/store/db.js';
import { PresetStore, LOCAL_UID, PRESET_KINDS } from '../src/store/presets.js';
import type { WeilinLoraEntry } from '../src/weilin/client.js';
import type { JobEvent } from '@comfyui-server/shared';

let failures = 0;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? '✔' : '✘';
  console.log(`${mark} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

/** 跑一段可能抛错的逻辑，返回错误信息；没抛错返回 null */
function errMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** 等任务到终态（任务表淘汰只对终态任务生效，测试需要它先跑完） */
async function waitTerminal(jobs: JobManager, jobId: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.get(jobId);
    if (j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled') return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内到达终态（当前 ${j.status}）`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  // ---------------------------------------------------------------------
  section('0. 配置文件解析');
  const cfg = loadConfig();
  check(
    'config.json 已加载',
    cfg.configFiles.some((f) => f.endsWith('config.json')),
    cfg.configFiles.map((f) => path.basename(f)).join(', ') || '(无)',
  );
  check('comfyBaseUrl 已归一化（含协议）', /^https?:\/\//.test(cfg.comfyBaseUrl), cfg.comfyBaseUrl);
  check('comfyBaseUrl 无尾斜杠', !cfg.comfyBaseUrl.endsWith('/'));

  // 注释应被正确剥离，且字符串里的 // 不能被误伤
  const parsed = parseJsonc(`{
    // 行注释
    "a": 1, /* 块注释 */
    "url": "http://x:1//y",
    "b": { "c": true }
  }`);
  check('JSONC 行注释被剥离', parsed.a === 1);
  check('JSONC 块注释被剥离', (parsed.b as { c: boolean }).c === true);
  check('字符串内的 // 未被误伤', parsed.url === 'http://x:1//y', String(parsed.url));

  // 地址归一化
  const cases: Array<[string, string]> = [
    ['10.2.3.22:8188', 'http://10.2.3.22:8188'],
    ['http://10.2.3.22:8188', 'http://10.2.3.22:8188'],
    ['http://10.2.3.22:8188/', 'http://10.2.3.22:8188'],
    [' 10.2.3.22:8188 ', 'http://10.2.3.22:8188'],
    ['https://comfy.example.com:8443', 'https://comfy.example.com:8443'],
    ['http://a.b:80', 'http://a.b'],
  ];
  for (const [input, expected] of cases) {
    let got = '';
    try {
      got = normalizeBaseUrl(input);
    } catch (err) {
      got = `抛错: ${(err as Error).message}`;
    }
    check(`归一化 "${input}"`, got === expected, `→ ${got}`);
  }
  let rejectedNoPort = false;
  try {
    normalizeBaseUrl('10.2.3.22');
  } catch {
    rejectedNoPort = true;
  }
  check('缺端口被拒绝', rejectedNoPort);

  // ---------------------------------------------------------------------
  section('1. 模板加载与静态校验');
  const registry = new TemplateRegistry(config.templatesDir);
  await registry.load();
  const tpl = registry.get('txt2img-basic');
  check('模板加载成功', true, `${registry.list().length} 个模板`);
  check('graph 节点数 > 0', Object.keys(tpl.graph).length > 0, `${Object.keys(tpl.graph).length} 节点`);
  check('inputs 非空', tpl.def.inputs.length > 0, `${tpl.def.inputs.length} 个输入`);
  check('bindings 非空', tpl.def.bindings.length > 0, `${tpl.def.bindings.length} 条绑定`);

  // ---------------------------------------------------------------------
  section('2. 渲染：表单值注入 graph');
  const { graph, values } = renderTemplate(tpl, {
    prompt: 'a cat sitting on a chair',
    qualityPos: 'masterpiece, best quality',
    qualityNeg: 'lowres, bad anatomy',
    unet_name: 'Anima\\0.26.9.12.NAI.RDBT  Anima.b1V23Base_fp16.safetensors',
    loras: [
      { name: 'Anima\\画师\\taffy-style', weight: 0.8, clipWeight: 0.9, triggerWeight: 1 },
      { name: 'Anima\\Anima Turbo LoRA-v0.2', weight: 0.6, clipWeight: 1 },
    ],
    seed: -1,
    steps: 12,
    cfg: 1.5,
    width: 768,
    height: 1152,
  });
  check('19.positive 已注入主提示词', graph['19']!.inputs.positive === 'a cat sitting on a chair');
  check('28.text 已注入质量正向词', graph['28']!.inputs.text === 'masterpiece, best quality');
  check('33.text 已注入质量负向词', graph['33']!.inputs.text === 'lowres, bad anatomy');
  check('32.width 已注入', graph['32']!.inputs.width === 768);
  check('32.height 已注入', graph['32']!.inputs.height === 1152);
  check('49.value(steps) 已注入', graph['49']!.inputs.value === 12);
  check('46.value(cfg) 已注入', graph['46']!.inputs.value === 1.5);

  // 已按需求移除的字段：不应再出现在 inputs/bindings 中，且图里保留原值
  const inputKeys = tpl.def.inputs.map((i) => i.key);
  check('已移除 autoRandom 字段', !inputKeys.includes('autoRandom'));
  check('已移除 prefix 字段', !inputKeys.includes('prefix'));

  // 保存节点：示例图已从 SaveImage(21) 换成 SaveImagePlus(57)，
  // 后者可指定 file_format/quality，是降低传输体积的关键（PNG 1.5MB → WEBP q80 约 100KB）
  const saveNodeId = tpl.def.outputs.nodes[0]!;
  check('输出节点存在', !!graph[saveNodeId], saveNodeId);
  check(
    '输出节点是 SaveImagePlus',
    graph[saveNodeId]!.class_type === 'SaveImagePlus',
    graph[saveNodeId]!.class_type,
  );
  // 不硬编码具体值（模板会变），改为校验不变量：渲染后这些字段应与模板原值一致
  check(
    '未暴露字段保留 graph 原值',
    graph[saveNodeId]!.inputs.filename_prefix ===
      tpl.graph[saveNodeId]!.inputs.filename_prefix &&
      graph['19']!.inputs.auto_random === tpl.graph['19']!.inputs.auto_random,
    `filename_prefix=${JSON.stringify(graph[saveNodeId]!.inputs.filename_prefix)}`,
  );
  const fmt = String(graph[saveNodeId]!.inputs.file_format);
  const quality = Number(graph[saveNodeId]!.inputs.quality);
  check('保存格式为压缩格式（非 PNG）', fmt === 'WEBP' || fmt === 'JPEG', fmt);
  check('保存质量在合理区间', quality > 0 && quality <= 100, String(quality));
  check(
    '旧 SaveImage 节点已不在图中',
    !Object.values(graph).some((n) => n.class_type === 'SaveImage'),
  );

  // 同行布局与一键交换的 schema 声明
  const widthInput = tpl.def.inputs.find((i) => i.key === 'width');
  const seedInput = tpl.def.inputs.find((i) => i.key === 'seed');
  check('seed/steps/cfg 声明同一 ui.row', seedInput?.ui?.row === 'sampling');
  check('width 声明 swap 指向 height', widthInput?.ui?.swap === 'height');
  check('width/height 声明同一 ui.row', widthInput?.ui?.row === 'size');

  const seed = graph['47']!.inputs.seed as number;
  check('seed=-1 已随机化', typeof seed === 'number' && seed !== -1, `seed=${seed}`);

  const tags = String(graph['43']!.inputs.positive);
  check(
    '43.positive 生成 <wlr:> 标签（4 参数）',
    tags.includes('<wlr:Anima\\画师\\taffy-style:0.8:0.9:1>'),
    tags,
  );

  const loraStr = String(graph['43']!.inputs.lora_str);
  let loraJson: Array<Record<string, unknown>> = [];
  try {
    loraJson = JSON.parse(loraStr) as Array<Record<string, unknown>>;
  } catch {
    /* 下面断言会失败 */
  }
  check('43.lora_str 是合法 JSON', loraJson.length === 2, `${loraJson.length} 项`);
  check(
    'lora_str 含反斜杠路径且往返无损',
    loraJson[0]?.lora === 'Anima\\画师\\taffy-style.safetensors',
    String(loraJson[0]?.lora),
  );
  check(
    'lora_str 字段名映射正确',
    loraJson[0]?.text_encoder_weight === 0.9 && loraJson[0]?.weight === 0.8,
  );

  // 前端不再暴露 CLIP / 触发词权重：只给 weight 时，两者应各补 1（不是跟随 weight）
  const weightOnly = renderTemplate(tpl, {
    prompt: 'x',
    unet_name: 'm',
    loras: [{ name: 'Anima\\x', lora: 'Anima\\x.safetensors', weight: 0.5 }],
  });
  const woJson = JSON.parse(String(weightOnly.graph['43']!.inputs.lora_str)) as Array<
    Record<string, unknown>
  >;
  check(
    '只给 weight 时 clipWeight 补 1（不跟随 weight）',
    woJson[0]?.text_encoder_weight === 1,
    `text_encoder_weight=${String(woJson[0]?.text_encoder_weight)}`,
  );
  check('只给 weight 时 trigger_weight 补 1', woJson[0]?.trigger_weight === 1);
  check(
    '标签里的 CLIP 权重也是 1',
    String(weightOnly.graph['43']!.inputs.positive) === '<wlr:Anima\\x:0.5:1:1>',
    String(weightOnly.graph['43']!.inputs.positive),
  );
  check('模板未被修改（深拷贝）', tpl.graph['19']!.inputs.positive !== 'a cat sitting on a chair');
  check('values 已归一化', values['steps'] === 12);

  // 前端 LoraSelector 从 /api/loras 拿到的形状：name 不带扩展名、lora 带完整路径
  const fromApiShape = renderTemplate(tpl, {
    prompt: 'x',
    unet_name: 'm',
    loras: [
      {
        name: 'Anima\\画师\\taffy-style',
        lora: 'Anima\\画师\\taffy-style.safetensors',
        weight: 0.75,
        clipWeight: 1,
        triggerWeight: 1,
        loraWorks: '@bantan',
        hidden: false,
      },
    ],
  });
  const apiLoraJson = JSON.parse(String(fromApiShape.graph['43']!.inputs.lora_str)) as Array<
    Record<string, unknown>
  >;
  check(
    'API 形状的 lora 全路径被原样透传',
    apiLoraJson[0]?.lora === 'Anima\\画师\\taffy-style.safetensors',
    String(apiLoraJson[0]?.lora),
  );
  check('loraWorks 被保留（仅供展示）', apiLoraJson[0]?.loraWorks === '@bantan');
  check(
    'API 形状生成正确的 <wlr:> 标签',
    String(fromApiShape.graph['43']!.inputs.positive) ===
      '<wlr:Anima\\画师\\taffy-style:0.75:1:1>',
    String(fromApiShape.graph['43']!.inputs.positive),
  );

  // ---------------------------------------------------------------------
  section('3. 校验失败应当报错');
  let rejected = false;
  try {
    renderTemplate(tpl, { prompt: 'x', unet_name: 'm', steps: 'abc' });
  } catch (err) {
    rejected = true;
    check('非法 steps 被拒绝', true, (err as Error).message);
  }
  if (!rejected) check('非法 steps 被拒绝', false);

  // 用合成定义测"必填且无 default"这条规则本身，避免依赖某个模板恰好没有默认值
  let rejectedNoDefault = false;
  try {
    coerceValues(
      { ...tpl.def, inputs: [{ key: 'must', label: '必填项', type: 'text', required: true }] },
      {},
    );
  } catch {
    rejectedNoDefault = true;
  }
  check('必填且无 default 的字段被拒绝', rejectedNoDefault);

  // 有 default 的必填项，缺失时应回落到 default 而不是报错
  const withDefaults = renderTemplate(tpl, {});
  check(
    '必填但有 default 的 prompt 回落到默认值',
    withDefaults.graph['19']!.inputs.positive ===
      tpl.def.inputs.find((i) => i.key === 'prompt')?.default,
  );
  check(
    '必填但有 default 的 unet_name 回落到默认值',
    withDefaults.graph['17']!.inputs.unet_name ===
      tpl.def.inputs.find((i) => i.key === 'unet_name')?.default,
  );
  check(
    'loras 默认值让开箱即可生成（非空）',
    String(withDefaults.graph['43']!.inputs.lora_str).length > 2,
    String(withDefaults.graph['43']!.inputs.positive).slice(0, 60),
  );

  // ---------------------------------------------------------------------
  section('3b. 硬件安全护栏（v1-safety.md）');

  check('步数上限常量 = 24', MAX_STEPS === 24, String(MAX_STEPS));
  check('单边像素上限常量 = 1216', MAX_SIDE === 1216, String(MAX_SIDE));

  // 启动期：模板自身的图必须扫得干净，否则 registry.load 早就抛错了
  const tplScan = scanGraph(tpl.graph);
  check('模板自带 graph 无越界值', tplScan.hits.length === 0, JSON.stringify(tplScan.hits));
  check(
    '模板自带 graph 取值全部可判定',
    tplScan.unresolved.length === 0,
    JSON.stringify(tplScan.unresolved),
  );

  // 表单边界 = 模板 ui 提示 ∩ 安全策略（steps 的绑定写在上游常量节点，
  // 必须顺着连线往下游追踪才能找到被管控的 `26.inputs.steps`）
  const stepsInput = tpl.def.inputs.find((i) => i.key === 'steps')!;
  const stepsMaxBefore = stepsInput.ui?.max;
  const stepsBounds = effectiveBounds(tpl.def, tpl.graph, stepsInput);
  check(
    'steps 的有效上限来自策略（24），不是模板里的 ui.max',
    stepsBounds.max === 24 && stepsBounds.fromPolicy,
    `模板 ui.max=${stepsMaxBefore} / 有效=${stepsBounds.max}`,
  );
  const widthBounds = effectiveBounds(
    tpl.def,
    tpl.graph,
    tpl.def.inputs.find((i) => i.key === 'width')!,
  );
  check('width 的有效上限被收窄到 1216', widthBounds.max === MAX_SIDE, String(widthBounds.max));

  // 下发模板时同步收窄（前端滑块不会再给出"填了必被拒"的区间），且不改动原对象
  const narrowed = narrowTemplateBounds(tpl.def, tpl.graph);
  const narrowedSteps = narrowed.inputs.find((i) => i.key === 'steps')!;
  check('下发的 steps.ui.max 已收窄到 24', narrowedSteps.ui?.max === 24, String(narrowedSteps.ui?.max));
  check(
    '收窄是浅拷贝，不改动原模板对象',
    tpl.def.inputs.find((i) => i.key === 'steps')!.ui?.max === stepsMaxBefore,
    String(tpl.def.inputs.find((i) => i.key === 'steps')!.ui?.max),
  );

  // —— 表单值越界：直接拒（错误信息要指出上限）——
  const overSteps = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', steps: 200 }));
  check('steps=200 被拒绝且提示 24', overSteps !== null && overSteps.includes('24'), overSteps ?? '(未抛错)');
  const zeroSteps = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', steps: 0 }));
  check('steps=0 被拒绝', zeroSteps !== null, zeroSteps ?? '(未抛错)');
  const fracSteps = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', steps: 6.5 }));
  check('steps=6.5 被拒绝（要求整数）', fracSteps !== null && fracSteps.includes('整数'), fracSteps ?? '(未抛错)');
  const bigW = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', width: 4096 }));
  check('width=4096 被拒绝且提示 1216', bigW !== null && bigW.includes('1216'), bigW ?? '(未抛错)');
  const bigH = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', height: 1217 }));
  check('height=1217 被拒绝', bigH !== null && bigH.includes('1216'), bigH ?? '(未抛错)');
  const tinyW = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', width: 8 }));
  check('width=8 被拒绝（下限 64）', tinyW !== null, tinyW ?? '(未抛错)');

  // —— 边界值：等于上限必须放行 ——
  const edge = errMessage(() =>
    renderTemplate(tpl, { prompt: 'x', unet_name: 'm', steps: 24, width: 1216, height: 1216 }),
  );
  check('边界值（24 / 1216×1216）放行', edge === null, edge ?? '');
  const edgeGraph = renderTemplate(tpl, { prompt: 'x', unet_name: 'm', steps: 24 });
  check('边界值原样落图（未被夹紧）', edgeGraph.graph['49']!.inputs.value === 24);
  check('边界值没有产生夹紧记录', edgeGraph.safety.clamped.length === 0);

  // 护栏只管"会不会打爆硬件"，不管 8 的倍数这类图像质量问题
  const odd = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', width: 1000 }));
  check('非 8 倍数不拦（不在硬件安全范围内）', odd === null, odd ?? '');

  // —— 模板自带越界值：夹紧而不是拒服务 ——
  const tplWide = {
    ...tpl,
    graph: structuredClone(tpl.graph),
    // 断掉宽高绑定 → 这两个值只可能来自模板本身
    def: { ...tpl.def, bindings: tpl.def.bindings.filter((b) => !b.target.startsWith('32.')) },
  };
  tplWide.graph['32']!.inputs.width = 4096;
  tplWide.graph['32']!.inputs.height = 2160;
  tplWide.graph['26']!.inputs.steps_to_run = 512;
  const clamped = renderTemplate(tplWide, { prompt: 'x', unet_name: 'm' });
  check('模板自带 width=4096 被夹到 1216', clamped.graph['32']!.inputs.width === 1216);
  check('模板自带 height=2160 被夹到 1216', clamped.graph['32']!.inputs.height === 1216);
  check('模板自带 steps_to_run=512 被夹到 24', clamped.graph['26']!.inputs.steps_to_run === 24);
  check('夹紧记录逐条进入 safety.clamped', clamped.safety.clamped.length === 3, `${clamped.safety.clamped.length} 条`);

  // —— 哨兵值豁免：steps_to_run=-1 不能被夹成 1（那会只跑一步）——
  const runAll = renderTemplate(tpl, { prompt: 'x', unet_name: 'm' });
  check('steps_to_run=-1 被豁免', runAll.graph['26']!.inputs.steps_to_run === -1, String(runAll.graph['26']!.inputs.steps_to_run));
  check('正常渲染无夹紧记录', runAll.safety.clamped.length === 0);

  // —— 取值无法判定：fail closed ——
  const tplAmbiguous = { ...tpl, graph: structuredClone(tpl.graph) };
  tplAmbiguous.graph['49'] = { class_type: 'INTConstant', inputs: { value: 6, other: 8 } };
  const ambiguous = errMessage(() => renderTemplate(tplAmbiguous, { prompt: 'x', unet_name: 'm' }));
  check(
    'steps 取值无法判定时拒绝提交',
    ambiguous !== null && ambiguous.includes('无法校验'),
    ambiguous ?? '(未抛错)',
  );

  // —— 直接测夹紧函数与出口断言 ——
  const directGraph = structuredClone(tpl.graph);
  directGraph['32']!.inputs.width = 3000;
  const directScan = guardGraph(directGraph);
  check('guardGraph 就地夹紧', directGraph['32']!.inputs.width === 1216 && directScan.hits.length === 1);

  const unsafeGraph = structuredClone(tpl.graph);
  unsafeGraph['32']!.inputs.width = 5000;
  check('assertGraphSafe 拦住越界图', errMessage(() => assertGraphSafe(unsafeGraph)) !== null);
  check(
    'assertGraphSafe 放行安全图',
    errMessage(() => assertGraphSafe(structuredClone(tpl.graph))) === null,
  );

  // —— LoRA 数量上限（MAX_LORAS = 8）——
  const mkLora = (n: number): Array<{ name: string; weight: number }> =>
    Array.from({ length: n }, (_, i) => ({ name: `Anima\\x\\lora-${i}`, weight: 0.8 }));
  const eight = errMessage(() =>
    renderTemplate(tpl, { prompt: 'x', unet_name: 'm', loras: mkLora(8) }),
  );
  check('8 个 LoRA 放行（边界含等号）', eight === null, eight ?? '');
  const nine = errMessage(() => renderTemplate(tpl, { prompt: 'x', unet_name: 'm', loras: mkLora(9) }));
  check('9 个 LoRA 被拒绝（上限 8）', nine !== null && nine.includes('最多 8'), nine ?? '(未抛错)');
  const eightGraph = renderTemplate(tpl, { prompt: 'x', unet_name: 'm', loras: mkLora(8) });
  check(
    '8 个 LoRA 全部落进 lora_str',
    JSON.parse(String(eightGraph.graph['43']!.inputs.lora_str)).length === 8,
  );

  // 图层的数量校验（绕过表单也没用）
  const loraScan = scanGraph(eightGraph.graph);
  check('8 个 LoRA 的图扫描无超量', loraScan.overCount.length === 0);
  const loraOver = structuredClone(eightGraph.graph);
  loraOver['43']!.inputs.lora_str = JSON.stringify(mkLora(9));
  check(
    '图层 9 个 LoRA 被出口断言拦住',
    errMessage(() => assertGraphSafe(loraOver)) !== null,
  );
  const loraBad = structuredClone(tpl.graph);
  loraBad['43']!.inputs.lora_str = '不是 JSON';
  check('lora_str 不是 JSON 数组 → 判定失败（fail closed）', errMessage(() => assertGraphSafe(loraBad)) !== null);
  const loraEmpty = structuredClone(tpl.graph);
  loraEmpty['43']!.inputs.lora_str = '';
  check('lora_str 空串按 0 个算（不误拦）', errMessage(() => assertGraphSafe(loraEmpty)) === null);

  // —— batch_size 上限 1 ——
  const batchGraph = structuredClone(tpl.graph);
  batchGraph['32']!.inputs.batch_size = 4;
  const batchScan = guardGraph(batchGraph);
  check(
    'batch_size=4 被夹到 1',
    batchGraph['32']!.inputs.batch_size === 1 && batchScan.hits.some((h) => h.ruleId === 'batch'),
  );
  check('模板自带 batch_size=1 合规', scanGraph(tpl.graph).hits.length === 0);

  // —— 启动期模板校验 ——
  const badDefault = {
    ...tpl.def,
    inputs: tpl.def.inputs.map((i) => (i.key === 'steps' ? { ...i, default: 100 } : i)),
  };
  check(
    '模板 default 越界 → 启动期校验失败',
    errMessage(() => validateTemplate(badDefault, tpl.graph, 'smoke')) !== null,
  );
  const manyLoras = structuredClone(tpl.graph);
  manyLoras['43']!.inputs.lora_str = JSON.stringify(mkLora(9));
  check(
    '模板写死 9 个 LoRA → 启动期校验失败',
    errMessage(() => validateTemplate(tpl.def, manyLoras, 'smoke')) !== null,
  );
  const warnGraph = structuredClone(tpl.graph);
  warnGraph['32']!.inputs.width = 2048;
  const loadWarnings = validateTemplate(tpl.def, warnGraph, 'smoke');
  check(
    '模板自带越界只告警不阻断启动',
    loadWarnings.length === 1 && loadWarnings[0]!.includes('1216'),
    loadWarnings.join(' | ') || '(无告警)',
  );

  // ---------------------------------------------------------------------
  section('3c. 资源配额：队列 / 任务表 / 请求体');

  check('LoRA 数量上限常量 = 8', MAX_LORAS === 8, String(MAX_LORAS));
  check('批量张数上限常量 = 1', MAX_BATCH === 1, String(MAX_BATCH));
  check('队列深度上限常量 = 5', MAX_QUEUE_DEPTH === 5, String(MAX_QUEUE_DEPTH));
  check('任务表保留条数 = 200', MAX_JOBS_RETAINED === 200, String(MAX_JOBS_RETAINED));
  check('请求体上限 = 256 KB', MAX_BODY_BYTES === 256 * 1024, String(MAX_BODY_BYTES));

  // —— 队列深度：慢客户端上并发提交，超出的直接拒 ——
  const qClient = new MockComfyClient({ stepDelayMs: 10_000, log: () => {} });
  await qClient.start();
  const qJobs = new JobManager(qClient, registry, {
    clientId: 'queue-test',
    log: () => {},
    maxQueueDepth: 3,
  });
  qJobs.start();
  const settled = await Promise.allSettled(
    [0, 1, 2, 3, 4].map(() =>
      qJobs.submit({ templateId: 'txt2img-basic', values: { prompt: 'q', unet_name: 'm' } }),
    ),
  );
  const okCount = settled.filter((s) => s.status === 'fulfilled').length;
  const qRejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  check(
    '队列到顶后拒绝多余提交（先登记再校验，并发也数得准）',
    okCount === 3 && qRejected.length === 2,
    `通过 ${okCount} / 拒绝 ${qRejected.length}`,
  );
  const qErr = qRejected[0]?.reason as { code?: string; status?: number } | undefined;
  check(
    '拒绝原因是 QUEUE_FULL / 429',
    qErr?.code === 'QUEUE_FULL' && qErr?.status === 429,
    `${qErr?.code} / ${qErr?.status}`,
  );
  check('被拒的占位已释放', qJobs.list().length === 3, `${qJobs.list().length} 条`);
  qJobs.stop();
  await qClient.stop();

  // —— 任务表淘汰：超出条数时从最旧的开始丢 ——
  const capClient = new MockComfyClient({ stepDelayMs: 1, log: () => {} });
  await capClient.start();
  const capJobs = new JobManager(capClient, registry, {
    clientId: 'cap-test',
    log: () => {},
    maxJobsRetained: 3,
  });
  capJobs.start();
  const capIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const j = await capJobs.submit({
      templateId: 'txt2img-basic',
      values: { prompt: `cap ${i}`, unet_name: 'm' },
    });
    capIds.push(j.jobId);
    await waitTerminal(capJobs, j.jobId);
  }
  check('任务表按条数截断', capJobs.list().length === 3, `${capJobs.list().length} 条`);
  check(
    '淘汰从最旧的开始（前两条已丢）',
    errMessage(() => capJobs.get(capIds[0]!)) !== null &&
      errMessage(() => capJobs.get(capIds[1]!)) !== null,
  );
  check('最新的任务仍在表里', errMessage(() => capJobs.get(capIds[4]!)) === null);
  capJobs.stop();
  await capClient.stop();

  // ---------------------------------------------------------------------
  section('4. 全链路：提交 → 进度 → 出图');
  const client = new MockComfyClient({ stepDelayMs: 20, log: () => {} });
  await client.start();
  const jobs = new JobManager(client, registry, { clientId: 'smoke-client', log: () => {} });
  jobs.start();

  // 出口断言（第 3 层）：绕过渲染层直接提交越界图也必须被拦
  let egressBlocked = false;
  try {
    await client.submit(unsafeGraph, 'smoke-client');
  } catch {
    egressBlocked = true;
  }
  check('出口断言拦住越界图（mock 客户端）', egressBlocked);

  const events: JobEvent[] = [];
  const job = await jobs.submit({
    templateId: 'txt2img-basic',
    values: { prompt: 'chain test', unet_name: 'm', steps: 8 },
  });
  check('任务已创建', job.jobId.startsWith('j_'), job.jobId);
  check('promptId 已回填', typeof job.promptId === 'string' && job.promptId.length > 0);

  const done = new Promise<void>((resolve) => {
    jobs.subscribe(job.jobId, (evt) => {
      events.push(evt);
      if (evt.type === 'completed' || evt.type === 'error') resolve();
    });
    setTimeout(resolve, 15_000);
  });
  await done;

  const final = jobs.get(job.jobId);
  const kinds = [...new Set(events.map((e) => e.type))];
  check('收到进度事件', kinds.includes('progress'), kinds.join(','));
  check('收到 started 事件', kinds.includes('started'));
  check('收到 completed 事件', kinds.includes('completed'));
  check('任务终态为 succeeded', final.status === 'succeeded', final.status);
  check('产出图片已登记', final.assets.length > 0, `${final.assets.length} 张`);

  const progressEvents = events.filter((e) => e.type === 'progress');
  const maxSeen = Math.max(...progressEvents.map((e) => Number(e.data.max ?? 0)));
  check('进度有 max 值', maxSeen > 0, `max=${maxSeen}`);

  if (final.assets[0]) {
    const decoded = decodeAssetId(final.assets[0].assetId);
    check('assetId 可逆解码', decoded.filename === final.assets[0].filename, decoded.filename);

    const img = await client.fetchImage(decoded);
    check('取图成功', img.data.length > 0, `${img.data.length} 字节`);

    // mock 自带零依赖 PNG 编码器（不依赖 sharp），因此固定产出 PNG
    check('mock 产出合法 PNG', img.data.subarray(0, 8).equals(PNG_MAGIC));
  }

  jobs.stop();
  await client.stop();

  // ---------------------------------------------------------------------
  section('5. 其它接口');
  const models = await new MockComfyClient({ stepDelayMs: 1 }).getModels('diffusion_models');
  check('getModels 可用', models.length > 0, `${models.length} 项`);

  // ---------------------------------------------------------------------
  section('6. LoRA 目录浏览：只看当前层，不递归');
  const fixture: WeilinLoraEntry[] = [
    { path: 'root.safetensors', name: 'root', folder: '', displayName: 'root' },
    { path: 'A\\a1.safetensors', name: 'A\\a1', folder: 'A', displayName: 'a1' },
    { path: 'A\\a2.safetensors', name: 'A\\a2', folder: 'A', displayName: 'a2' },
    { path: 'A\\sub\\s1.safetensors', name: 'A\\sub\\s1', folder: 'A\\sub', displayName: 's1' },
    { path: 'A\\sub\\deep\\d1.safetensors', name: 'A\\sub\\deep\\d1', folder: 'A\\sub\\deep', displayName: 'd1' },
    { path: 'B\\deep\\x.safetensors', name: 'B\\deep\\x', folder: 'B\\deep', displayName: 'x' },
  ];

  const root = browseLoras(fixture, '');
  check('根：只列直属文件', root.items.length === 1 && root.items[0]!.name === 'root');
  check(
    '根：子目录为 A(2) 与 B(0)',
    root.folders.length === 2 &&
      root.folders.find((f) => f.name === 'A')?.count === 2 &&
      root.folders.find((f) => f.name === 'B')?.count === 0,
    root.folders.map((f) => `${f.name}(${f.count})`).join(', '),
  );
  check('根：空目录 B 仍可进入（即使直属数为 0）', root.folders.some((f) => f.name === 'B'));

  const a = browseLoras(fixture, 'A');
  check(
    '★ 浏览 A 时**不**带出子目录内容',
    a.items.length === 2 && !a.items.some((i) => i.name.includes('sub')),
    a.items.map((i) => i.displayName).join(','),
  );
  check(
    'A 的子目录只有 sub(1)',
    a.folders.length === 1 && a.folders[0]!.name === 'sub' && a.folders[0]!.count === 1,
  );

  const sub = browseLoras(fixture, 'A\\sub');
  check('浏览 A\\sub：直属 1 个，且不含 deep 的内容', sub.items.length === 1 && sub.items[0]!.displayName === 's1');
  check('A\\sub 的子目录只有 deep(0)', sub.folders.length === 1 && sub.folders[0]!.name === 'deep');

  const deep = browseLoras(fixture, 'B');
  check('浏览 B：无直属文件但有子目录', deep.items.length === 0 && deep.folders.length === 1);

  check(
    '面包屑：全部 › A › sub',
    sub.breadcrumbs.map((b) => b.name).join(' › ') === '全部 › A › sub',
    sub.breadcrumbs.map((b) => `${b.name}:${b.path || '(root)'}`).join(' | '),
  );
  check('面包屑各级 path 正确', sub.breadcrumbs[1]!.path === 'A' && sub.breadcrumbs[2]!.path === 'A\\sub');

  check('前后斜杠被容忍', browseLoras(fixture, '\\A\\').path === 'A');

  // ---------------------------------------------------------------------
  section('7. 预设仓库（内存 SQLite，零外部依赖）');
  const pdb = openDatabase(':memory:');
  check('迁移到 v2', userVersion(pdb) === 2, `user_version=${userVersion(pdb)}`);

  const tables = (
    pdb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as Array<{ name: string }>
  ).map((r) => r.name);
  check(
    '四张预设表已建',
    ['preset_prompt', 'preset_quality_pos', 'preset_quality_neg', 'preset_size'].every((t) =>
      tables.includes(t),
    ),
    tables.join(','),
  );

  const store = new PresetStore(pdb);
  check('初始各类别为空', store.listAll().every((k) => k.items.length === 0));
  check('类别登记表有 4 项', PRESET_KINDS.length === 4);

  store.upsert('prompt', '起手', { values: { prompt: '1girl, solo' } });
  store.upsert('qualityPos', '写实', {
    description: '照片风格',
    values: { qualityPos: 'photorealistic' },
  });
  store.upsert('size', '竖版', { values: { width: 832, height: 1216 } });
  store.upsert('size', '方图', { values: { width: 1024, height: 1024 } });

  const size = store.list('size');
  check('size 有 2 条', size.items.length === 2);
  check('带字段元数据（dialog 展示用）', size.fields.length === 2 && size.fields[0]!.label === '宽');
  check(
    '★ 服务端派生 values（列 → input key）',
    size.items[0]!.values.width === 832 && size.items[0]!.values.height === 1216,
    JSON.stringify(size.items[0]!.values),
  );
  check('description 是真列而非 JSON 键', store.list('qualityPos').items[0]!.description === '照片风格');
  check('sort_order 按插入顺序', size.items.map((i) => i.name).join(',') === '竖版,方图');
  check('文本类别的派生 values', store.list('prompt').items[0]!.values.prompt === '1girl, solo');

  store.upsert('size', '竖版', { description: '改过', values: { width: 768, height: 1152 } });
  const after = store.list('size');
  check('同名覆盖不新增', after.items.length === 2 && after.items[0]!.values.width === 768);
  check('覆盖时描述也更新', after.items[0]!.description === '改过');

  const rejects: Array<[string, () => void]> = [
    ['未知 kind 被拒', () => store.upsert('nope', 'x', { values: {} })],
    ['空名被拒', () => store.upsert('size', '  ', { values: { width: 1, height: 1 } })],
    ['缺字段被拒', () => store.upsert('size', 'x', { values: { width: 1 } })],
    ['负数被拒', () => store.upsert('size', 'x', { values: { width: -1, height: 1 } })],
    ['非整数被拒', () => store.upsert('size', 'x', { values: { width: 1.5, height: 1 } })],
    ['文本字段非字符串被拒', () => store.upsert('prompt', 'x', { values: { prompt: 123 } })],
    ['描述非字符串被拒', () => store.upsert('prompt', 'x', { description: 1, values: { prompt: 'a' } })],
    ['values 非对象被拒', () => store.upsert('prompt', 'x', { values: 'str' })],
  ];
  for (const [name, fn] of rejects) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    check(name, threw);
  }

  // 数据库层约束：绕过应用校验直接插入，CHECK 仍应拦下
  let checkWorked = false;
  try {
    pdb
      .prepare(
        "INSERT INTO preset_size (id,uid,name,description,width,height,sort_order,created_at,updated_at) VALUES ('z','local','坏','',0,1,0,'x','x')",
      )
      .run();
  } catch {
    checkWorked = true;
  }
  check('CHECK 约束在数据库层生效', checkWorked);

  check('删除存在的预设', store.remove('size', '方图'));
  check('删除不存在的返回 false', !store.remove('size', '不存在'));
  check('删除后剩 1 条', store.list('size').items.length === 1);

  const other = new PresetStore(pdb, 'other-user');
  other.upsert('size', '竖版', { values: { width: 1, height: 1 } });
  check('不同 uid 可同名且互不覆盖', store.list('size').items[0]!.values.width === 768);
  check('不同 uid 各自可见', other.list('size').items[0]!.values.width === 1);
  check('默认 uid 为 local', LOCAL_UID === 'local');
  closeDatabase(pdb);

  // ---------------------------------------------------------------------
  section('8. 迁移 v1 → v2（旧 JSON 表数据搬迁）');
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mig-'));
  const migFile = path.join(migDir, 'old.db');
  {
    const old = new DatabaseSync(migFile);
    old.exec(`
      CREATE TABLE presets (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        value TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (uid, kind, name)
      );
      PRAGMA user_version = 1;
    `);
    const now = '2026-01-01T00:00:00.000Z';
    const ins = old.prepare(
      'INSERT INTO presets (id,uid,kind,name,value,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    ins.run('p1', 'local', 'prompt', '起手', JSON.stringify({ prompt: '1girl' }), 0, now, now);
    ins.run(
      'p2',
      'local',
      'qualityPos',
      '写实',
      JSON.stringify({ qualityPos: 'photo', $desc: '照片风格' }),
      0,
      now,
      now,
    );
    ins.run('p3', 'local', 'size', '竖版', JSON.stringify({ width: 832, height: 1216 }), 0, now, now);
    old.close();
  }
  const migrated = openDatabase(migFile);
  check('旧库升级到 v2', userVersion(migrated) === 2);
  const mstore = new PresetStore(migrated);
  check('文本预设已搬迁', mstore.list('prompt').items[0]!.values.prompt === '1girl');
  check('$desc 已提升为 description 列', mstore.list('qualityPos').items[0]!.description === '照片风格');
  check(
    '尺寸预设已搬迁',
    mstore.list('size').items[0]!.values.width === 832 &&
      mstore.list('size').items[0]!.values.height === 1216,
  );
  const leftover = migrated
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='presets'")
    .get();
  check('旧表已删除', leftover === undefined);
  closeDatabase(migrated);
  fs.rmSync(migDir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\n✅ 全部通过\n'
      : `\n❌ ${failures} 项失败\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n冒烟脚本异常终止:');
  console.error(err);
  process.exit(1);
});
