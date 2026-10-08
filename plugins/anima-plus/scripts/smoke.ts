#!/usr/bin/env node
/**
 * anima-plus 自检：**不需要 ComfyUI、不需要网络、不起 HTTP**。
 *
 * 旧服务那份 896 行的 smoke 脚本（`apps/server/scripts/smoke.ts`，已随旧服务删除）是随进程一起跑的（mock 客户端 +
 * 真 HTTP + 真 SQLite），删掉 8086 之后它没法原样搬过来。这里只保留**纯函数级**、
 * 且最值钱的那几段：模板静态校验 → 渲染与值变换 → **显存护栏** → 配额 → 预设 CRUD。
 *
 * 为什么护栏这段最重要：`safety/limits.ts` 是"能出图"和"打爆显存"之间唯一的收口，
 * 而且它刚从旧服务逐字搬过来 —— 这段测试就是"搬家没搬丢规则"的证据。
 *
 *   pnpm --filter @comfyui-web/anima-plus smoke          # 精简（失败项立刻回显）
 *   pnpm --filter @comfyui-web/anima-plus smoke -v       # 全量明细
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { createImageLibrary } from 'purejsimage';
import { jpegCodec } from 'purejsimage/codecs/jpeg';
import type { TemplateInput } from '@comfyui-web/shared';

import { WorkflowDefinition } from '../server/templates/loader.js';
import { buildConfig, normalizeBaseUrl } from '../server/config.js';
import { renderTemplate } from '../server/templates/render.js';
import { applyTransform } from '../server/templates/transforms.js';
import {
  MAX_LORAS,
  MAX_SIDE,
  MAX_STEPS,
  MIN_SIDE,
} from '../server/safety/limits.js';
import { MAX_BODY_BYTES, MAX_JOBS_RETAINED, MAX_QUEUE_DEPTH } from '../server/safety/quota.js';
import { PRESET_KINDS, PresetStore } from '../server/store/presets.js';
import { closeDatabase, openDatabase, userVersion } from '../server/store/db.js';
import { TriggerStore } from '../server/triggers/store.js';
import { assertGraphSafe } from '../server/safety/describe.js';
import { guardGraph, scanGraph } from '../server/safety/scan.js';
import { narrowTemplateBounds } from '../server/safety/effective.js';
import { LastStateStore, stateFile } from '../server/state.js';
import { TriggerResolver } from '../server/triggers/resolve.js';
import type { WeilinClient } from '../server/weilin/client.js';
import { cleanupPrompt } from '../client/src/prompt-cleanup.js';
import { restoreValues } from '../client/src/form.js';
import {
  RESIZER_TAG,
  THUMB_QUALITY,
  makeThumbnail,
  resizerAvailable,
  resizerTag,
  shouldPassThrough,
  thumbStatus,
} from '../server/weilin/thumb.js';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(PLUGIN_DIR, 'assets');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

let total = 0;
let failures = 0;
let currentSection = '';
const failedChecks: string[] = [];

function check(name: string, ok: boolean, extra = ''): void {
  total += 1;
  const text = `${name}${extra ? ` — ${extra}` : ''}`;
  if (VERBOSE) console.log(`  ${ok ? '✔' : '✘'} ${text}`);
  if (ok) return;
  failures += 1;
  failedChecks.push(currentSection ? `[${currentSection}] ${text}` : text);
  if (!VERBOSE) console.log(`✘ ${text}`); // 精简模式：失败必须立刻可见
}

function section(title: string): void {
  currentSection = title;
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

/** 跑一段应当抛错的逻辑，返回错误信息；没抛错返回 null */
function errMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** 在 graph 里找第一个带某字段的节点输入（不依赖具体节点 id） */
function findInput(graph: Record<string, { inputs?: Record<string, unknown> }>, field: string): unknown {
  for (const node of Object.values(graph)) {
    if (node?.inputs && field in node.inputs) return node.inputs[field];
  }
  return undefined;
}

/**
 * 只找**字面量**（跳过数组形式的连线）。
 * ComfyUI 的 API 格式里 `[nodeId, outputIndex]` 表示"接在别人的输出上"；
 * 种子这类值往往就是这么接的，所以断言得跳过连线去找真正被写入的那个节点。
 */
function findLiteral(
  graph: Record<string, { inputs?: Record<string, unknown> }>,
  field: string,
): unknown {
  for (const node of Object.values(graph)) {
    const v = node?.inputs?.[field];
    if (v !== undefined && !Array.isArray(v)) return v;
  }
  return undefined;
}

/**
 * 造一张带噪声的 PNG（纯标准库）。
 *
 * 噪声是刻意的：纯色 PNG 压完只有几 KB，会从"该转码"的阈值下溜走，测不到真实路径。
 */
function makeTestPng(width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // 过滤器：none
    for (let x = 0; x < width; x += 1) {
      const o = row + 1 + x * 3;
      raw[o] = (x * 31 + y * 17) % 256;
      raw[o + 1] = (x * 3 + y) % 256;
      raw[o + 2] = (y * 5 + x * 7) % 256;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(payload), 0);
    return Buffer.concat([len, payload, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 色彩类型：truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 自检专用：把产物（JPEG）读回来核对尺寸 */
const jpegProbe = createImageLibrary({ codecs: [jpegCodec] });

async function main(): Promise<void> {
  // ── 工作流（一个插件一份定义：workflow.json + assets/form.json） ────────
  section('工作流');
  const workflow = new WorkflowDefinition(PLUGIN_DIR, () => {});
  await workflow.load();
  const tpl = workflow.get();
  check('工作流 id / 名称', tpl.def.id === 'txt2img-basic', `${tpl.def.id} · ${tpl.def.name}`);
  check('工作流声明了 13 个表单输入', (tpl.def.inputs ?? []).length === 13, `count=${(tpl.def.inputs ?? []).length}`);

  const requiredNodes = tpl.def.requirements?.nodes ?? [];
  const missing = requiredNodes.filter((cls) => !Object.values(tpl.graph).some((n) => n.class_type === cls));
  check('graph 里含声明要求的全部节点类', missing.length === 0, missing.join(', '));

  // bounds 收窄：ui.max 必须已经被显存护栏压住（前端滑块的上限就是这个）
  const narrowed = narrowTemplateBounds(tpl.def, tpl.graph);
  const stepsIn = (narrowed.inputs ?? []).find((i) => i.key === 'steps');
  const widthIn = (narrowed.inputs ?? []).find((i) => i.key === 'width');
  check('steps 的 ui.max 被收窄到护栏上限', stepsIn?.ui?.max === MAX_STEPS, `max=${stepsIn?.ui?.max}`);
  check('width 的 ui.max 被收窄到护栏上限', widthIn?.ui?.max === MAX_SIDE, `max=${widthIn?.ui?.max}`);
  check('width 的 ui.min 不低于护栏下限', (widthIn?.ui?.min ?? 0) >= MIN_SIDE, `min=${widthIn?.ui?.min}`);

  // ── 渲染 ────────────────────────────────────────────────────────────────
  section('渲染');
  const before = JSON.stringify(tpl.graph);
  const r = renderTemplate(tpl, {});
  check('渲染不修改定义（深拷贝）', JSON.stringify(tpl.graph) === before);
  check('默认值渲染出的 graph 非空', Object.keys(r.graph).length > 5, `nodes=${Object.keys(r.graph).length}`);
  check('工作流默认值没有被夹紧', r.safety.clamped.length === 0, `clamped=${r.safety.clamped.length}`);

  const defaultPrompt = String((tpl.def.inputs ?? []).find((i) => i.key === 'prompt')?.default ?? '');
  check('提示词落到了 graph 里', JSON.stringify(r.graph).includes(defaultPrompt.slice(0, 18)), defaultPrompt.slice(0, 24));

  // ── 随机种子（服务端渲染时手动抽，图里不带 -1 这种哨兵值） ─────────────
  const seed = findLiteral(r.graph, 'seed');
  check('seed=-1 被变换成真实种子', typeof seed === 'number' && seed >= 0, `seed=${seed}`);
  check(
    '随机种子是整数且在安全整数范围内',
    typeof seed === 'number' && Number.isInteger(seed) && seed <= Number.MAX_SAFE_INTEGER,
    `seed=${seed}`,
  );
  // 种子由前端在点「开始出图」时抽定（App.vue 的 drawSeed），所以正常情况下送来的就已是
  // 具体数字，渲染只是原样落图；-1 留作手工/旧客户端的兜底（下面单独断言）。
  check(
    '具体种子原样落图并回传（不再有 -1 哨兵）',
    r.seeds.seed === seed && r.values.seed === seed,
    `seeds=${JSON.stringify(r.seeds)} values.seed=${JSON.stringify(r.values.seed)}`,
  );
  check('默认种子是具体数字（随机由前端接手）', typeof tpl.def.inputs.find((i) => i.key === 'seed')?.default === 'number' && tpl.def.inputs.find((i) => i.key === 'seed')?.default !== -1);
  check('存在「随机」开关且默认开启', tpl.def.inputs.find((i) => i.key === 'randomSeed')?.type === 'switch' && tpl.def.inputs.find((i) => i.key === 'randomSeed')?.default === true);
  const rolls = new Set(Array.from({ length: 8 }, () => findLiteral(renderTemplate(tpl, { seed: -1 }).graph, 'seed')));
  check('反复提交随机种子不重复', rolls.size === 8, `distinct=${rolls.size}/8`);
  check('固定种子原样落图', findLiteral(renderTemplate(tpl, { seed: 12345 }).graph, 'seed') === 12345);
  check('负数种子被拒绝（-1 除外）', /不能小于 -1/.test(errMessage(() => renderTemplate(tpl, { seed: -5 })) ?? ''));
  check('超出安全整数范围的种子被拒绝', /不能大于/.test(errMessage(() => renderTemplate(tpl, { seed: 1e20 })) ?? ''));

  // 默认不加载任何 LoRA（用户自己选），所以默认渲染出的 lora_str 必须是空数组；
  // 变换本身用**显式值**验，别依赖默认值 —— 默认值一改，靠默认值验的断言就假绿了。
  const loraStr = findInput(r.graph, 'lora_str');
  check('默认 lora_str 是空数组', loraStr === '[]', String(loraStr).slice(0, 60));

  const withLora = renderTemplate(tpl, { loras: [{ name: 'demo-lora', weight: 0.9 }] }).graph;
  const explicitLoraStr = findInput(withLora, 'lora_str');
  const lorasParsed = (() => {
    try {
      return JSON.parse(String(explicitLoraStr)) as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
  })();
  check('LoRA 被变换成 lora_str 富 JSON', Array.isArray(lorasParsed) && lorasParsed.length > 0, String(explicitLoraStr).slice(0, 60));
  check('lora_str 里带权重字段', lorasParsed?.[0] !== undefined && 'weight' in (lorasParsed[0] ?? {}));

  const coerced = renderTemplate(tpl, { steps: '5' }).values;
  check('字符串数值被归一化成 number', coerced.steps === 5, `steps=${JSON.stringify(coerced.steps)}`);
  const sizeApplied = renderTemplate(tpl, { width: 768, height: 640 }).graph;
  check('用户填的宽高落图', findInput(sizeApplied, 'width') === 768 && findInput(sizeApplied, 'height') === 640);

  // ── 触发词注入（Lora堆 不注入；词由服务端拼进 28「质量词」之前） ────────
  section('触发词注入');
  const bindings = tpl.def.bindings ?? [];
  check(
    '28（质量词）绑定了 triggerPrefix',
    bindings.find((b) => b.target === '28.inputs.text')?.transform === 'triggerPrefix',
  );
  check(
    'LoRA 绑到 Lora堆（不注入的节点）',
    bindings.some((b) => b.target === '58.inputs.lora_str'),
  );
  check(
    '已没有 43（全能节点）的绑定',
    !bindings.some((b) => b.target.startsWith('43.')),
  );

  const nodeText = (graph: Record<string, unknown>, id: string): unknown =>
    (graph[id] as { inputs?: Record<string, unknown> } | undefined)?.inputs?.text;
  check(
    '触发词拼在质量词之前',
    nodeText(renderTemplate(tpl, { qualityPos: 'q' }, { triggerPrefix: '@bantan' }).graph, '28') ===
      '@bantan, q',
  );
  check('没有触发词时质量词原样', nodeText(renderTemplate(tpl, { qualityPos: 'q' }).graph, '28') === 'q');
  check(
    '值为空时只留触发词（不留分隔逗号）',
    applyTransform('triggerPrefix', '', { triggerPrefix: 'x' }) === 'x',
  );
  // 空串是"没填"而不是"要清空"：coerceValues 会回落到表单默认质量词（既有语义，不是本次改的）
  check(
    '质量词留空时回落到默认值，触发词仍在最前',
    String(
      nodeText(renderTemplate(tpl, { qualityPos: '' }, { triggerPrefix: 'x' }).graph, '28'),
    ).startsWith('x, dramatic angle'),
  );

  // 触发词三态表：写盘 → 重启仍在 → 解析优先级；注入文本不带权重
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anima-triggers-'));
  const tmpSpace = { root: tmpDir, resolve: (rel: string) => path.join(tmpDir, rel) };
  try {
    const store = new TriggerStore(tmpSpace);
    check('空表读出不报错（文件不存在是正常状态）', Object.keys(store.all()).length === 0);
    check('非法 LoRA 名被拒绝', errMessage(() => store.apply('', false, 'x')) !== null);

    // 态 2：自定义词
    store.apply('Anima\\画师\\taffy-style', false, '@bantan');
    check(
      '写入自定义词',
      store.get('Anima\\画师\\taffy-style') === '@bantan' &&
        !store.isSuppressed('Anima\\画师\\taffy-style'),
    );
    check(
      '带扩展名的名字被归一化',
      store.apply('a.safetensors', false, 'w').useDefault === false && store.get('a') === 'w',
    );

    // 态 3：关默认且留空 = 不注入。必须单独存，否则 reload 后会弹回"用默认"
    store.apply('silent', false, '');
    check(
      '关默认且留空 → 记进 suppressDefault（words 里不留键）',
      store.isSuppressed('silent') && store.get('silent') === undefined,
    );

    const reloaded = new TriggerStore(tmpSpace);
    check('重启后自定义词仍在', reloaded.get('Anima\\画师\\taffy-style') === '@bantan');
    check('重启后"不注入"仍在（第三态确实落盘）', reloaded.isSuppressed('silent'));

    // 态 1：回到用默认 → 两处记录都清掉
    reloaded.apply('Anima\\画师\\taffy-style', true, 'ignored');
    check(
      '开关打开 → 记录清除，回到用默认',
      reloaded.stateOf('Anima\\画师\\taffy-style').useDefault &&
        reloaded.get('Anima\\画师\\taffy-style') === undefined,
    );

    /** 只实现被用到的那一个方法：解析逻辑不依赖 WeiLin 的其它能力 */
    const stub = (word: string): WeilinClient =>
      ({
        getLoraInfo: async (file: string) => ({
          file,
          triggerWords: word ? [word] : [],
          loraWorks: '',
          civitaiName: '',
          nsfwLevel: null,
          baseModel: '',
        }),
      }) as unknown as WeilinClient;

    const lora = { name: 'auto-lora', lora: 'auto-lora.safetensors', weight: 1 };
    const autoResolver = new TriggerResolver(reloaded, stub('auto'));
    const autoDetails = await autoResolver.resolve([lora]);
    check(
      '开关开 → 用 WeiLin 默认词（含来源与开关态）',
      autoDetails[0]?.word === 'auto' &&
        autoDetails[0]?.source === 'weilin' &&
        autoDetails[0]?.useDefault === true,
      JSON.stringify(autoDetails),
    );
    check('注入文本不带权重', (await autoResolver.prefix([lora])) === 'auto');

    reloaded.apply('auto-lora', false, 'mine');
    const overrideDetails = await autoResolver.resolve([lora]);
    check(
      '自定义词优先（标签库有词也不用）',
      overrideDetails[0]?.word === 'mine' && overrideDetails[0]?.source === 'override',
      JSON.stringify(overrideDetails),
    );
    check('关掉默认时仍回传默认词（第 1 行要显示它）', overrideDetails[0]?.defaultWord === 'auto');

    const noneResolver = new TriggerResolver(reloaded, stub(''));
    check(
      '标签库也没有词 → 不注入',
      (await noneResolver.prefix([{ name: 'z', lora: 'z.safetensors', weight: 1 }])) === '',
    );

    // 第三态：关默认 + 留空 → 即便标签库有词也不注入
    reloaded.apply('silent-lora', false, '');
    const suppressedResolver = new TriggerResolver(reloaded, stub('不该被用上'));
    const suppressedDetails = await suppressedResolver.resolve([
      { name: 'silent-lora', lora: 'silent-lora.safetensors', weight: 1 },
    ]);
    check(
      '关默认且留空 → 不注入（默认词只展示、不使用）',
      suppressedDetails[0]?.word === '' &&
        suppressedDetails[0]?.source === 'none' &&
        suppressedDetails[0]?.useDefault === false &&
        suppressedDetails[0]?.defaultWord === '不该被用上',
      JSON.stringify(suppressedDetails),
    );

    const downResolver = new TriggerResolver(reloaded, {
      getLoraInfo: async () => {
        throw new Error('WeiLin 挂了');
      },
    } as unknown as WeilinClient);
    check(
      'WeiLin 不可用降级成"没有默认词"，不抛错',
      (await downResolver.prefix([{ name: 'w', lora: 'w.safetensors', weight: 1 }])) === '',
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // ── 提示词整理（手动按钮；换行/句号/行尾逗号一律不动） ──────────────────
  section('提示词整理');
  const cases: Array<[string, string, string]> = [
    ['已经干净的行原样返回（`a,b` 不补空格）', '1girl,solo', '1girl,solo'],
    ['行内去重', 'a, b, a', 'a, b'],
    ['大小写不同不算重复', '1girl, 1Girl', '1girl, 1Girl'],
    ['括号内的逗号不拆段（权重语法只算一个段）', '(a, b:1.2), (a, b:1.2)', '(a, b:1.2)'],
    ['合并连续逗号', 'a,,b', 'a, b'],
    ['行尾逗号保留', 'a,,b,', 'a, b,'],
    ['行尾逗号 + 去重同时发生', 'a, a,', 'a,'],
    ['换行是硬边界：跨行不去重', 'a, a\nb, b', 'a\nb'],
    ['跨行重复的标签不被删', 'tag\n tag', 'tag\n tag'],
    ['空行保留', 'a,,a\n\nb', 'a\n\nb'],
    ['句号不动（不删也不补）', 'a., b.', 'a., b.'],
  ];
  for (const [label, input, expect] of cases) {
    const got = cleanupPrompt(input).text;
    check(label, got === expect, `in=${JSON.stringify(input)} out=${JSON.stringify(got)}`);
  }
  const stats = cleanupPrompt('a, a, b\nc,,d');
  check(
    '统计：删重复 1、并连续逗号 1',
    stats.dupes === 1 && stats.commas === 1,
    JSON.stringify(stats),
  );
  check('无可整理时 text 不变且计数为 0', JSON.stringify(cleanupPrompt('a, b,\n\nc')) === JSON.stringify({ text: 'a, b,\n\nc', dupes: 0, commas: 0 }));

  // ── 显存护栏（最关键） ──────────────────────────────────────────────────
  section('显存护栏');
  check('步数越界被拒绝', /不能大于 24/.test(errMessage(() => renderTemplate(tpl, { steps: 999 })) ?? ''));
  check('尺寸越界被拒绝', /不能大于 1216/.test(errMessage(() => renderTemplate(tpl, { width: 99999 })) ?? ''));

  const nineLoras = Array.from({ length: MAX_LORAS + 1 }, (_, i) => ({
    name: `l${i}`,
    lora: `l${i}.safetensors`,
    weight: 1,
  }));
  check('LoRA 超过 8 个被拒绝', /最多 8 个/.test(errMessage(() => renderTemplate(tpl, { loras: nineLoras })) ?? ''));

  // 直接对 graph 用护栏：越界夹紧 + 数量超限拒绝 + 取值不明 fail closed
  const overGraph = {
    '1': { class_type: 'KSampler', inputs: { steps: 999, width: 4 } },
  } as unknown as Parameters<typeof guardGraph>[0];
  const scan = guardGraph(overGraph);
  check('guardGraph 报告越界', scan.hits.length >= 2, `hits=${scan.hits.length}`);
  check('guardGraph 把 steps 夹到上限', (overGraph as never as Record<string, { inputs: { steps: number } }>)['1']!.inputs.steps === MAX_STEPS);
  check('guardGraph 把 width 夹到下限', (overGraph as never as Record<string, { inputs: { width: number } }>)['1']!.inputs.width === MIN_SIDE);

  const countGraph = {
    '1': { class_type: 'WeiLinPromptUIWithoutLora', inputs: { lora_str: JSON.stringify(nineLoras) } },
  } as unknown as Parameters<typeof scanGraph>[0];
  check('LoRA 数量超限被单独识别', scanGraph(countGraph).overCount.length > 0);

  const unresolvedGraph = {
    '1': { class_type: 'KSampler', inputs: { steps: ['99', 0] } },
  } as unknown as Parameters<typeof scanGraph>[0];
  check('取值不明（连线指向不存在的节点）', scanGraph(unresolvedGraph).unresolved.length > 0);
  check('取值不明时 assertGraphSafe 拒绝', errMessage(() => assertGraphSafe(unresolvedGraph)) !== null);
  check('正常 graph 能过出口断言', errMessage(() => assertGraphSafe(renderTemplate(tpl, {}).graph)) === null);

  // ── 配额 ────────────────────────────────────────────────────────────────
  section('配额');
  check('队列深度上限 = 5', MAX_QUEUE_DEPTH === 5, String(MAX_QUEUE_DEPTH));
  check('保留任务上限 = 200', MAX_JOBS_RETAINED === 200, String(MAX_JOBS_RETAINED));
  check('请求体上限 = 256KB', MAX_BODY_BYTES === 256 * 1024, String(MAX_BODY_BYTES));

  // ── 预设（用内存库，不碰插件空间） ──────────────────────────────────────
  section('配置：设置项（填错不许炸）');
  const cfgPaths = { pluginDir: '', dbFile: '', cacheDir: '', dataDir: '' };
  const noCfg = buildConfig(undefined, cfgPaths);
  check(
    '未配置 → 5 / 200 / 预热开 / 缓存 5 分钟',
    noCfg.maxQueueDepth === 5 &&
      noCfg.maxJobsRetained === 200 &&
      noCfg.depsWarmupOnStart === true &&
      noCfg.depsCacheTtlMs === 5 * 60_000,
    `${noCfg.maxQueueDepth} / ${noCfg.maxJobsRetained} / ${noCfg.depsWarmupOnStart} / ${noCfg.depsCacheTtlMs}`,
  );
  check('地址留空 → 默认 localhost:8188', noCfg.comfyBaseUrl === 'http://localhost:8188', noCfg.comfyBaseUrl);
  check('地址只写 host:port 会自动补协议', noCfg.comfyBaseUrl === normalizeBaseUrl('localhost:8188'));

  const tuned = buildConfig(
    { maxQueueDepth: 8, maxJobsRetained: 50, depsWarmupOnStart: false, depsCacheTtlMinutes: 30 },
    cfgPaths,
  );
  check(
    '合法值全部生效',
    tuned.maxQueueDepth === 8 &&
      tuned.maxJobsRetained === 50 &&
      tuned.depsWarmupOnStart === false &&
      tuned.depsCacheTtlMs === 30 * 60_000,
  );
  check('数字字符串也认（表单送回来的可能是字符串）', buildConfig({ maxQueueDepth: '3' }, cfgPaths).maxQueueDepth === 3);
  check(
    '越界收敛：999 → 16、0 → 1、保留 1 → 10、缓存 1e9 → 1440',
    buildConfig({ maxQueueDepth: 999 }, cfgPaths).maxQueueDepth === 16 &&
      buildConfig({ maxQueueDepth: 0 }, cfgPaths).maxQueueDepth === 1 &&
      buildConfig({ maxJobsRetained: 1 }, cfgPaths).maxJobsRetained === 10 &&
      buildConfig({ depsCacheTtlMinutes: 1e9 }, cfgPaths).depsCacheTtlMs === 1440 * 60_000,
  );
  check(
    '非法值回默认而不是抛错（abc / 空 / null / 对象）',
    buildConfig({ maxQueueDepth: 'abc' }, cfgPaths).maxQueueDepth === 5 &&
      buildConfig({ maxQueueDepth: null }, cfgPaths).maxQueueDepth === 5 &&
      buildConfig({ depsCacheTtlMinutes: 'x' }, cfgPaths).depsCacheTtlMs === 5 * 60_000 &&
      buildConfig({ maxQueueDepth: {} }, cfgPaths).maxQueueDepth === 5,
  );
  check(
    '缓存 0 分钟 = 明确允许（每次重查上游）',
    buildConfig({ depsCacheTtlMinutes: 0 }, cfgPaths).depsCacheTtlMs === 0,
  );
  check(
    '布尔：false/no/off 都认，乱七八糟的字符串回默认',
    buildConfig({ depsWarmupOnStart: false }, cfgPaths).depsWarmupOnStart === false &&
      buildConfig({ depsWarmupOnStart: 'no' }, cfgPaths).depsWarmupOnStart === false &&
      buildConfig({ depsWarmupOnStart: '随便' }, cfgPaths).depsWarmupOnStart === true,
  );
  check(
    'configFiles 记下生效来源（/config 排障用）',
    noCfg.configFiles[0] === '内置默认值' &&
      buildConfig({ maxQueueDepth: 8 }, cfgPaths).configFiles.join('|').includes('maxQueueDepth') &&
      buildConfig({ maxQueueDepth: 999 }, cfgPaths).configFiles.join('|').includes('越界'),
  );

  // ── 缩略图 ──────────────────────────────────────────────────────────────
  section('缩略图：纯 JS 编解码（只在划算时转）');
  // 缩放器从"惰性 import('sharp')，拿不到就原图直出"换成了 purejsimage。
  // 这条链路的失败模式很隐蔽：图仍能显示，只是变小/变糊，没人会去翻日志。
  // 所以用合成 PNG 把三条路径钉死：划算就转、不划算就透传、坏字节只回退不抛。
  const bigPng = makeTestPng(900, 900);
  const smallPng = makeTestPng(120, 120);
  check(
    '合成图体积落在阈值两侧（否则这段测不到真实路径）',
    bigPng.length > 128 * 1024 && smallPng.length < 128 * 1024,
    `大 ${Math.round(bigPng.length / 1024)}KB / 小 ${Math.round(smallPng.length / 1024)}KB`,
  );
  check(
    '透传判定：库里 30KB、512px 的预览图，3:4 卡片尺寸不转；要 112px 时才转',
    shouldPassThrough(30 * 1024, 512, 512, 336, 448) &&
      !shouldPassThrough(30 * 1024, 512, 512, 112, 112) &&
      !shouldPassThrough(2 * 1024 * 1024, 512, 512, 336, 448),
  );
  // 宽成 string 再比：万一将来有人把 tag 改回 'none'（也就是回到原图直出），这条要能响
  const tagWidened: string = RESIZER_TAG;
  check(
    '缓存键里的引擎标识已换（否则会复用 sharp/原图时代的缓存）',
    (await resizerTag()) === RESIZER_TAG && tagWidened !== 'none' && tagWidened.length > 0,
    RESIZER_TAG,
  );
  check('缩放能力始终可用（纯 JS 随包走，没有可选依赖）', (await resizerAvailable()) === true);

  const thumb = await makeThumbnail(bigPng, 256, 342);
  check(
    '大图真的转出了缩略图',
    thumb !== null && thumb.length > 0,
    thumb ? `${Math.round(thumb.length / 1024)}KB` : 'null',
  );
  check(
    '产物是 JPEG（不是原图直出）',
    thumb !== null && thumb[0] === 0xff && thumb[1] === 0xd8 && thumb[2] === 0xff,
  );
  check(
    '产物比原图小一个量级',
    thumb !== null && thumb.length * 4 < bigPng.length,
    thumb ? `${Math.round(thumb.length / 1024)}KB vs ${Math.round(bigPng.length / 1024)}KB` : 'null',
  );
  if (thumb) {
    const outMeta = await (await jpegProbe.open(thumb)).metadata();
    check(
      '产物尺寸就是请求的 256x342（cover 居中裁切）',
      outMeta.width === 256 && outMeta.height === 342,
      `${outMeta.width}x${outMeta.height}`,
    );
  }
  check('小图 → 透传（null 表示用原图）', (await makeThumbnail(smallPng, 256, 342)) === null);
  check(
    '坏字节 → 回退原图，不抛异常',
    (await makeThumbnail(Buffer.from('definitely not an image'), 256, 342)) === null,
  );
  const thumbStats = thumbStatus();
  check(
    '排障状态反映真实引擎与三条路径的计数',
    thumbStats.engine === RESIZER_TAG &&
      thumbStats.quality === THUMB_QUALITY &&
      thumbStats.transcoded >= 1 &&
      thumbStats.passthrough >= 1 &&
      thumbStats.failed >= 1 &&
      thumbStats.lastError !== null,
    `transcoded=${thumbStats.transcoded} passthrough=${thumbStats.passthrough} failed=${thumbStats.failed} lastError=${thumbStats.lastError}`,
  );

  section('参数快照（last-state.json）与回填');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anima-state-'));
  const stateSpace = { root: stateDir, resolve: (rel: string) => path.join(stateDir, rel) };
  const lastState = new LastStateStore(stateSpace);
  const firstRead = lastState.read();
  check(
    '没存过 = 空快照（不是错误）',
    Object.keys(firstRead.values).length === 0 &&
      firstRead.savedAt === null &&
      firstRead.error === undefined,
    JSON.stringify(firstRead),
  );

  // 只落模板认得的键：换过模板的机器上，文件里不该留着一批早就没有的字段
  lastState.write({ prompt: '1girl', steps: 28, 早就没有的键: 'x' }, ['prompt', 'steps']);
  const afterWrite = lastState.read();
  check(
    '写入按模板 key 过滤',
    afterWrite.values.prompt === '1girl' &&
      afterWrite.values.steps === 28 &&
      !('早就没有的键' in afterWrite.values),
    JSON.stringify(afterWrite.values),
  );
  check(
    'savedAt 落盘（界面要显示"上次保存于…"）',
    typeof afterWrite.savedAt === 'string' && !Number.isNaN(Date.parse(afterWrite.savedAt)),
    String(afterWrite.savedAt),
  );
  check(
    '原子写：不留 .tmp 残留',
    await fs
      .access(`${stateFile(stateSpace)}.tmp`)
      .then(() => false)
      .catch(() => true),
  );

  await fs.writeFile(stateFile(stateSpace), '{ 这不是 JSON');
  const broken = lastState.read();
  check(
    '文件读坏 → 空值 + error（页面退回模板默认值，不炸）',
    Object.keys(broken.values).length === 0 && typeof broken.error === 'string',
    String(broken.error),
  );

  const stateInputs: TemplateInput[] = [
    { key: 'prompt', label: '提示词', type: 'text' },
    { key: 'steps', label: '步数', type: 'number' },
    { key: 'randomSeed', label: '随机', type: 'switch' },
    { key: 'loras', label: 'LoRA', type: 'lora-select' },
  ];
  const restored = restoreValues(stateInputs, {
    prompt: '1girl',
    steps: 28,
    randomSeed: true,
    loras: [{ name: 'a', weight: 1 }],
    早就没有的键: 'x',
  });
  check(
    '回填：认识且类型对得上的键全部回填，不认识的键丢掉',
    restored.prompt === '1girl' &&
      restored.steps === 28 &&
      restored.randomSeed === true &&
      Array.isArray(restored.loras) &&
      !('早就没有的键' in restored),
    JSON.stringify(restored),
  );
  check(
    '回填：类型对不上的键丢掉（字符串不许住进 switch，界面会显示得莫名其妙）',
    Object.keys(restoreValues(stateInputs, { randomSeed: 'true', steps: '28' })).length === 0,
  );
  check('回填：坏输入（不是对象）不炸，返回空', Object.keys(restoreValues(stateInputs, null)).length === 0);
  await fs.rm(stateDir, { recursive: true, force: true });

  section('预设');
  const db = openDatabase(':memory:');
  check('库迁移到最新版本', userVersion(db) === 2, `user_version=${userVersion(db)}`);
  const presets = new PresetStore(db);
  check('4 类预设都可用', presets.listAll().length === PRESET_KINDS.length, `kinds=${presets.listAll().length}`);

  presets.upsert('prompt', '测试', { description: 'd', values: { prompt: '1girl' } });
  let kind = presets.list('prompt');
  check('预设写入 + values 派生', kind.items[0]?.values.prompt === '1girl', JSON.stringify(kind.items[0]?.values));
  presets.upsert('prompt', '测试', { description: 'd2', values: { prompt: '2girls' } });
  kind = presets.list('prompt');
  check('同名预设是覆盖写（不重复）', kind.items.length === 1 && kind.items[0]?.values.prompt === '2girls');
  check('宽高对预设的两列都在', (() => {
    presets.upsert('size', '竖版', { values: { width: 832, height: 1216 } });
    const v = presets.list('size').items[0]?.values;
    return v?.width === 832 && v?.height === 1216;
  })());
  check('缺列被拒绝', errMessage(() => presets.upsert('size', '坏', { values: { width: 1 } })) !== null);
  check('未知 kind 被拒绝', errMessage(() => presets.upsert('nope', 'x', { values: {} })) !== null);
  check('删除返回 true / 再删返回 false', presets.remove('prompt', '测试') && !presets.remove('prompt', '测试'));
  closeDatabase(db);

  console.log(
    `\n${failures === 0 ? '✔' : '✘'} 自检完成：${total - failures}/${total} 项通过` +
      (failures > 0 ? `，${failures} 项失败` : ''),
  );
  if (failures > 0) {
    console.log('\n失败项：');
    for (const f of failedChecks) console.log(`  ✘ ${f}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n✘ 自检异常终止：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
