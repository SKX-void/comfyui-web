import fs from 'node:fs/promises';
import path from 'node:path';
import type { Graph, TemplateDef } from '@comfyui-server/shared';
import { AppError } from '../errors.js';
import type { LoadedTemplate } from './render.js';
import { KNOWN_TRANSFORMS } from './transforms.js';

/** 校验模板定义 + graph 的一致性。任何问题都抛出，绝不静默降级。 */
export function validateTemplate(def: TemplateDef, graph: Graph, origin: string): void {
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

  if (def.promptBinding && !graph[def.promptBinding.node]) {
    problems.push(`promptBinding.node 不存在于 graph: ${def.promptBinding.node}`);
  }

  for (const outNode of def.outputs?.nodes ?? []) {
    if (!graph[outNode]) problems.push(`outputs.nodes 指向不存在的节点: ${outNode}`);
  }

  if (problems.length > 0) {
    throw new Error(`模板 ${origin} 校验失败:\n  - ${problems.join('\n  - ')}`);
  }
}

async function loadOne(dir: string): Promise<LoadedTemplate> {
  const tplPath = path.join(dir, 'template.json');
  const raw = await fs.readFile(tplPath, 'utf8');
  let def: TemplateDef;
  try {
    def = JSON.parse(raw) as TemplateDef;
  } catch (err) {
    throw new Error(`模板 ${tplPath} JSON 解析失败: ${String(err)}`);
  }

  // graph 来自 source.file（通常是从 ComfyUI 导出的 API 格式工作流）
  const graphFile = def.source?.file;
  if (!graphFile) {
    throw new Error(`模板 ${tplPath} 缺少 source.file（graph 来源）`);
  }
  const graphPath = path.resolve(dir, graphFile);
  const graphRaw = await fs.readFile(graphPath, 'utf8');
  const graph = JSON.parse(graphRaw) as Graph;

  validateTemplate(def, graph, def.id);
  return { def, graph, dir };
}

export class TemplateRegistry {
  private readonly byId = new Map<string, LoadedTemplate>();

  constructor(private readonly templatesDir: string) {}

  /** 启动时加载全部模板；任一模板非法则**整体启动失败**（快速失败） */
  async load(): Promise<void> {
    this.byId.clear();
    let entries: string[];
    try {
      entries = await fs.readdir(this.templatesDir);
    } catch (err) {
      throw new Error(`模板目录不可读: ${this.templatesDir} (${String(err)})`);
    }

    const errors: string[] = [];
    for (const entry of entries.sort()) {
      const dir = path.join(this.templatesDir, entry);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      try {
        await fs.access(path.join(dir, 'template.json'));
      } catch {
        continue; // 不是模板目录
      }
      try {
        const tpl = await loadOne(dir);
        if (this.byId.has(tpl.def.id)) {
          throw new Error(`模板 id 重复: ${tpl.def.id}`);
        }
        this.byId.set(tpl.def.id, tpl);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    if (errors.length > 0) {
      throw new Error(`模板加载失败：\n\n${errors.join('\n\n')}`);
    }
  }

  get(id: string): LoadedTemplate {
    const tpl = this.byId.get(id);
    if (!tpl) throw AppError.templateNotFound(id);
    return tpl;
  }

  list(): LoadedTemplate[] {
    return [...this.byId.values()];
  }
}
