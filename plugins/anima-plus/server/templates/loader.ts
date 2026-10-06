import fs from 'node:fs/promises';
import path from 'node:path';
import type { Graph, TemplateDef } from '@comfyui-web/shared';
import type { LoadedTemplate } from './render.js';
import { KNOWN_TRANSFORMS } from './transforms.js';
import { describeCount, describeHit } from '../safety/describe.js';
import { scanGraph } from '../safety/scan.js';
import { effectiveBounds } from '../safety/effective.js';

/**
 * 校验插件唯一的那份定义（form.json）与 workflow.json 的一致性。
 * 任何问题都抛出，绝不静默降级。
 *
 * 返回值是**告警**（不阻断启动）：目前只有"工作流自带的越界值会被护栏夹紧"这一类，
 * 交给调用方打日志，让运维在启动期就能看见。
 */
export function validateForm(def: TemplateDef, graph: Graph, origin: string): string[] {
  const problems: string[] = [];

  if (!def.id) problems.push('缺少 id');
  if (!def.name) problems.push('缺少 name');
  if (!def.version) problems.push('缺少 version');
  if (!Array.isArray(def.inputs)) problems.push('inputs 必须是数组');
  if (!Array.isArray(def.bindings)) problems.push('bindings 必须是数组');
  if (!def.outputs?.nodes?.length) problems.push('outputs.nodes 不能为空');

  const inputKeys = new Set((def.inputs ?? []).map((i) => i.key));
  if (inputKeys.size !== (def.inputs ?? []).length) problems.push('inputs[].key 有重复');

  for (const b of def.bindings ?? []) {
    const m = /^([^.]+)\.inputs\.(.+)$/.exec(b.target ?? '');
    if (!m) {
      problems.push(`binding.target 格式非法: ${b.target}`);
      continue;
    }
    const [nodeId, field] = [m[1]!, m[2]!];
    const node = graph[nodeId];
    if (!node) {
      problems.push(`binding.target 指向不存在的节点: ${b.target}`);
    } else if (!(field in node.inputs)) {
      problems.push(
        `binding.target 指向不存在的字段: ${b.target}（节点 ${nodeId} 是 ${node.class_type}）`,
      );
    }
    if (b.from !== undefined && !inputKeys.has(b.from)) {
      problems.push(`binding.from 不在 inputs 中: ${b.from}`);
    }
    if (b.transform && !KNOWN_TRANSFORMS.includes(b.transform)) {
      problems.push(`未知 transform: ${b.transform}`);
    }
  }

  for (const outNode of def.outputs?.nodes ?? []) {
    if (!graph[outNode]) problems.push(`outputs.nodes 指向不存在的节点: ${outNode}`);
  }

  // ---- 安全护栏（plugins/anima-plus/docs/safety.md）------------------------------------------
  // 1) 表单默认值不得越过安全上限：这种工作流一提交必被拒，属于作者笔误，启动期就拦下
  for (const input of def.inputs ?? []) {
    const bounds = effectiveBounds(def, graph, input);
    if (!bounds.fromPolicy) continue;
    const v = input.default;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const what = `${input.label}（inputs.${input.key}）`;
    const limit = bounds.label ?? '安全';
    if (bounds.max !== undefined && v > bounds.max) {
      problems.push(`${what} 的 default=${v} 超过${limit}上限 ${bounds.max}`);
    }
    if (bounds.min !== undefined && v < bounds.min) {
      problems.push(`${what} 的 default=${v} 低于${limit}下限 ${bounds.min}`);
    }
  }

  // 2) 被管控字段的取值必须能判定：判定不了就等于"不知道会不会打爆显存"，一律拒绝
  const scan = scanGraph(graph);
  for (const u of scan.unresolved) {
    problems.push(`安全上限无法校验：${u.detail}`);
  }

  // 3) 数量超限（例如图里写死了 9 个 LoRA）：不夹紧，直接拦，属于作者笔误
  for (const c of scan.overCount) {
    problems.push(describeCount(c));
  }

  // 4) 工作流自带的越界数值不阻断启动（提交时会被夹紧），但要让人看见
  const warnings = scan.hits.map(
    (h) => `工作流 ${origin} 的 ${describeHit(h)} —— 提交时会被夹紧到 ${h.fixed}`,
  );

  if (problems.length > 0) {
    throw new Error(`工作流 ${origin} 校验失败:\n  - ${problems.join('\n  - ')}`);
  }
  return warnings;
}

/**
 * 图里用到、但声明里没交代出处的节点类。
 *
 * 出处 = `builtin`（ComfyUI 自带）或某个包的 `provides`。两者都没有，用户拿到
 * "缺 X" 之后无从下手，所以这属于声明缺陷。
 */
export function coverageGaps(def: TemplateDef): string[] {
  const known = new Set(def.requirements?.builtin ?? []);
  for (const pack of def.requirements?.packs ?? []) {
    for (const cls of pack.provides ?? []) known.add(cls);
  }
  return (def.requirements?.nodes ?? []).filter((cls) => !known.has(cls));
}

/**
 * 插件的**唯一**工作流定义：form.json（表单/绑定）+ workflow.json（图）。
 *
 * v2 的「一个工作流 = 一个 tab」（docs/architecture.md §0 G1）意味着插件内不存在
 * "多模板"：没有目录扫描、没有按 id 查、没有 id 唯一性校验 —— 那些都是 v1 单体
 * 「模板数据」层的遗留（见 docs/architecture.md §10）。
 */
export class WorkflowDefinition {
  private loaded: LoadedTemplate | null = null;

  constructor(
    /** 插件包根目录（编译后就是 tab 根）：workflow.json 与 assets/ 都在这里 */
    private readonly pluginDir: string,
    /** 启动期告警出口（安全护栏的"工作流自带越界"提示走这里） */
    private readonly log?: (msg: string, meta?: unknown) => void,
  ) {}

  /** 启动时加载；定义非法则**整体启动失败**（快速失败） */
  async load(): Promise<void> {
    this.loaded = null;
    const { tpl, warnings } = await this.loadOne();
    for (const w of warnings) this.log?.(w);
    this.loaded = tpl;
  }

  private async loadOne(): Promise<{ tpl: LoadedTemplate; warnings: string[] }> {
    const formPath = path.join(this.pluginDir, 'assets', 'form.json');
    const raw = await fs.readFile(formPath, 'utf8').catch((err: unknown) => {
      throw new Error(`表单定义不可读: ${formPath} (${String(err)})`);
    });
    let def: TemplateDef;
    try {
      def = JSON.parse(raw) as TemplateDef;
    } catch (err) {
      throw new Error(`表单定义 ${formPath} JSON 解析失败: ${String(err)}`);
    }

    // 图就是插件根那份 workflow.json（与 package.json 并列，唯一基准）：
    // 没有"来源文件"指针，也就不存在"来源与骨架漂移"这种事故。
    const graphPath = path.join(this.pluginDir, 'workflow.json');
    const graphRaw = await fs.readFile(graphPath, 'utf8').catch((err: unknown) => {
      throw new Error(`工作流不可读: ${graphPath} (${String(err)})`);
    });
    const graph = JSON.parse(graphRaw) as Graph;

    // 需求节点**从 graph 推导**，不接受手写：手写清单漂过一次（声明列 9 种、
    // 图里实际 17 种，缺的那 8 种一路跑到 ComfyUI 才报错，用户只看到 node type not exist）。
    // 渲染器只做取值替换、不增删节点，所以图的 class_type 集合就是完整需求。
    def.requirements = {
      ...(def.requirements ?? {}),
      nodes: [...new Set(Object.values(graph).map((node) => node.class_type))].sort(),
    };

    const warnings = validateForm(def, graph, def.id);

    // 声明的覆盖面：图里用到的类必须能在 builtin ∪ packs[].provides 里找到出处，
    // 否则界面上只能显示"缺某个节点，但不知道装谁"。这是**作者笔误**，不阻断启动，
    // 但契约测试会把它当失败拦下（见 scripts/contract-test.mjs）。
    const uncovered = coverageGaps(def);
    if (uncovered.length > 0) {
      warnings.push(
        `requirements 没写出处的节点类: ${uncovered.join(', ')}（补 builtin 或某个包的 provides）`,
      );
    }
    return { tpl: { def, graph, dir: this.pluginDir }, warnings };
  }

  /** 已加载的唯一定义；load() 之前访问是编程错误 */
  get(): LoadedTemplate {
    if (!this.loaded) throw new Error('工作流定义尚未加载（WorkflowDefinition.load() 未执行）');
    return this.loaded;
  }
}
