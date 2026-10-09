/**
 * 预设库 / 区块库的**导入导出文件**：两个方向都在这儿，形状只有这一份定义。
 *
 * 为什么在服务端：导入必须过收敛函数（`sanitizeDoc` / `sanitizeBlockPreset`），形状写在客户端
 * 就成了两份定义，迟早对不上 —— 导出去的文件，导进来得原样认。
 *
 * 文件里**不带 id**（也不带 `updatedAt`）：id 是这台机器内部的寻址键，跨文件没有意义，
 * 导入时现场生成。区块库的分类只带**名字**：分类 id 同样只在本地有效，跨文件只能按名字对齐
 * （重名的分类按"第一个同名的"认，见 `routes-block-presets.ts` 的导入路由）。
 *
 * 两份文件都带 `kind` 与 `version`：导错文件（比如把区块库的文件丢进预设库）要能当场说清，
 * 而不是灌进去一堆认不出的行。手写的 `{ presets: [...] }` 也认（没有 `kind` 就不查），
 * 但 `kind` 对不上一定拒 —— 那是明确的"拿错文件了"。
 */
import { LIMITS } from './constants.js';
import { sanitizeBlockPreset, type BlockLibrary, type BlockPreset } from './blockstore.js';
import { sanitizeDoc, text, type Doc, type Preset } from './doc.js';
import { asRecord, isRecord } from './util.js';

export const PRESETS_KIND = 'prompt-editor/presets';
export const BLOCKS_KIND = 'prompt-editor/block-library';
const VERSION = 1;

/** 文件里的一行预设：名字 + 整份文档（id / 时间都不带） */
export interface PresetImportRow {
  name: string;
  doc: Doc;
}

/** 文件里的一行区块：整块 + 它所属分类的**名字**（`''` = 未分类） */
export interface BlockImportRow {
  preset: BlockPreset;
  category: string;
}

/**
 * 导出请求里的选择集：`null` = 全选。
 *
 * 缺省 / 空数组 / 不是数组都算全选 —— 导出的语义是"把库拿出来"，`curl -d '{}'` 也该能导整库；
 * 真选了 0 条是客户端的事（按钮禁用），不该靠后端 400 去兜。
 */
export function readExportIds(input: unknown): string[] | null {
  const raw = asRecord(input)?.ids;
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((one): one is string => typeof one === 'string' && one !== '');
  return ids.length === 0 ? null : ids;
}

export function presetExportDoc(presets: Preset[]): Record<string, unknown> {
  return {
    kind: PRESETS_KIND,
    version: VERSION,
    exportedAt: Date.now(),
    presets: presets.map((one) => ({ name: one.name, doc: one.doc })),
  };
}

/**
 * 认一份预设库的导出文件。`null` = 根本不是这个形状（调用方回 400）。
 * 认不出的行**跳过并计数**：一份文件里坏了一行，不该让整次导入失败。
 */
export function readPresetImport(input: unknown): { rows: PresetImportRow[]; skipped: number } | null {
  const raw = asRecord(input);
  if (raw === null || !Array.isArray(raw.presets)) return null;
  if (raw.kind !== undefined && raw.kind !== PRESETS_KIND) return null;
  const rows: PresetImportRow[] = [];
  for (const row of raw.presets) {
    const one = asRecord(row);
    if (one === null) continue;
    const doc = sanitizeDoc(one.doc);
    if (doc === null) continue;
    rows.push({ name: text(one.name, LIMITS.name).trim() || '未命名预设', doc });
  }
  return { rows, skipped: raw.presets.length - rows.length };
}

/**
 * 区块库的导出文件。`categories` 只列**这些块用到的**分类名（整库导出就是全部用到的）：
 * 文件是给人搬去另一台机器的，带上没用到的一堆空分类只是噪音。
 */
export function blockExportDoc(library: BlockLibrary, presets: BlockPreset[]): Record<string, unknown> {
  const byId = new Map(library.categories.map((one) => [one.id, one.name]));
  const used: string[] = [];
  const rows = presets.map((one) => {
    const category = byId.get(one.categoryId) ?? '';
    if (category !== '' && !used.includes(category)) used.push(category);
    return {
      name: one.name,
      category,
      title: one.title,
      color: one.color,
      mode: one.mode,
      items: one.items,
    };
  });
  return { kind: BLOCKS_KIND, version: VERSION, exportedAt: Date.now(), categories: used, presets: rows };
}

/** 认一份区块库的导出文件。形状同 `readPresetImport`（坏行跳过并计数） */
export function readBlockImport(input: unknown): { rows: BlockImportRow[]; skipped: number } | null {
  const raw = asRecord(input);
  if (raw === null || !Array.isArray(raw.presets)) return null;
  if (raw.kind !== undefined && raw.kind !== BLOCKS_KIND) return null;
  const rows: BlockImportRow[] = [];
  for (const row of raw.presets) {
    if (!isRecord(row)) continue;
    // id 与归属都不从文件里拿：id 现场生成，归属在路由里按名字对齐
    const preset = sanitizeBlockPreset({ ...row, id: '', categoryId: '' });
    if (preset === null) continue;
    rows.push({ preset, category: text(row.category, LIMITS.category).trim() });
  }
  return { rows, skipped: raw.presets.length - rows.length };
}
