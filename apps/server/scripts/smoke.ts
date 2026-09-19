/**
 * 冒烟测试：不依赖外部服务，验证「模板 → 渲染 → 提交 → 进度 → 出图」链路。
 *
 * 运行：pnpm --filter @comfyui-server/server smoke
 */
import path from 'node:path';
import { loadConfig, normalizeBaseUrl, parseJsonc } from '../src/config.js';
import { TemplateRegistry } from '../src/templates/loader.js';
import { renderTemplate, coerceValues } from '../src/templates/render.js';
import { MockComfyClient } from '../src/comfy/mock.js';
import { JobManager, decodeAssetId } from '../src/jobs/manager.js';
import { browseLoras } from '../src/weilin/browse.js';
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
  check(
    '未暴露字段保留 graph 原值',
    graph[saveNodeId]!.inputs.filename_prefix === 'server' &&
      graph['19']!.inputs.auto_random === false,
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
  section('4. 全链路：提交 → 进度 → 出图');
  const client = new MockComfyClient({ stepDelayMs: 20, log: () => {} });
  await client.start();
  const jobs = new JobManager(client, registry, { clientId: 'smoke-client', log: () => {} });
  jobs.start();

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
