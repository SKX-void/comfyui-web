import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { AppError } from '../errors.js';

/**
 * 预设仓库（范式化：每种预设一张表，类型化列 + CHECK 约束）。
 *
 * 表结构只在这里登记一次，CRUD / 派生 values / 前端字段元数据都由它驱动。
 * 加一种预设 = 加一条 registry + 一条迁移。
 */

/** v1 单用户；将来换真实用户标识即可，表结构无需改 */
export const LOCAL_UID = 'local';

const NAME_MAX = 64;
const DESC_MAX = 200;

export interface PresetField {
  /** 数据库列名 */
  column: string;
  /** 模板 input 的 key —— 派生 `values` 时用它 */
  inputKey: string;
  /** dialog 里显示的字段名 */
  label: string;
  type: 'text' | 'int';
}

export interface PresetKindDef {
  kind: string;
  /** dialog 标题用 */
  label: string;
  table: string;
  fields: PresetField[];
}

/** 预设类别登记表 —— 与迁移 v2 建的表一一对应 */
export const PRESET_KINDS: readonly PresetKindDef[] = [
  {
    kind: 'prompt',
    label: '正向提示词',
    table: 'preset_prompt',
    fields: [{ column: 'text', inputKey: 'prompt', label: '提示词', type: 'text' }],
  },
  {
    kind: 'qualityPos',
    label: '正向质量词',
    table: 'preset_quality_pos',
    fields: [{ column: 'text', inputKey: 'qualityPos', label: '质量词', type: 'text' }],
  },
  {
    kind: 'qualityNeg',
    label: '负向质量词',
    table: 'preset_quality_neg',
    fields: [{ column: 'text', inputKey: 'qualityNeg', label: '质量词', type: 'text' }],
  },
  {
    kind: 'size',
    label: '宽高对',
    table: 'preset_size',
    fields: [
      { column: 'width', inputKey: 'width', label: '宽', type: 'int' },
      { column: 'height', inputKey: 'height', label: '高', type: 'int' },
    ],
  },
];

const BY_KIND = new Map(PRESET_KINDS.map((k) => [k.kind, k]));

/** 返回给前端的单条预设 */
export interface PresetRecord {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /**
   * 由类型化列**派生**的、可直接 Object.assign 到表单值的对象。
   * 键为模板 input 的 key（列本身仍是唯一数据源）。
   */
  values: Record<string, unknown>;
}

/** 某类别的完整载荷（dialog 需要字段元数据才能展示"详细内容"） */
export interface PresetKindPayload {
  kind: string;
  label: string;
  fields: PresetField[];
  items: PresetRecord[];
}

interface Row {
  id: string;
  name: string;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  [column: string]: unknown;
}

function kindDef(kind: string): PresetKindDef {
  const def = BY_KIND.get(kind);
  if (!def) {
    throw AppError.badRequest(
      `未知的预设类别: ${kind}（可用：${PRESET_KINDS.map((k) => k.kind).join(', ')}）`,
    );
  }
  return def;
}

function assertName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw AppError.badRequest('预设名不能为空');
  if (n.length > NAME_MAX) throw AppError.badRequest(`预设名过长（上限 ${NAME_MAX}）`);
  return n;
}

function assertDesc(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw AppError.badRequest('描述必须是字符串');
  const d = v.trim();
  if (d.length > DESC_MAX) throw AppError.badRequest(`描述过长（上限 ${DESC_MAX}）`);
  return d;
}

/** 按字段定义校验 values，返回「列名 -> 值」，交给 SQL 绑定 */
function assertValues(def: PresetKindDef, values: unknown): Record<string, string | number> {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw AppError.badRequest('预设值必须是对象');
  }
  const src = values as Record<string, unknown>;
  const out: Record<string, string | number> = {};

  for (const f of def.fields) {
    const raw = src[f.inputKey];
    if (f.type === 'int') {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        throw AppError.badRequest(`${f.label} 必须是正整数，收到: ${JSON.stringify(raw)}`);
      }
      out[f.column] = n;
    } else {
      if (typeof raw !== 'string') {
        throw AppError.badRequest(`${f.label} 必须是字符串`);
      }
      out[f.column] = raw;
    }
  }
  return out;
}

export class PresetStore {
  constructor(
    private readonly db: Db,
    private readonly uid: string = LOCAL_UID,
  ) {}

  /** 全部类别（前端一次拉齐，避免每个切换器各发一次请求） */
  listAll(): PresetKindPayload[] {
    return PRESET_KINDS.map((def) => this.list(def.kind));
  }

  list(kind: string): PresetKindPayload {
    const def = kindDef(kind);
    const cols = def.fields.map((f) => f.column).join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, name, description, sort_order, created_at, updated_at, ${cols}
         FROM ${def.table} WHERE uid = ? ORDER BY sort_order, name`,
      )
      .all(this.uid) as unknown as Row[];

    return {
      kind: def.kind,
      label: def.label,
      fields: def.fields,
      items: rows.map((r) => this.toRecord(def, r)),
    };
  }

  /** 新增或覆盖同名预设（名字在用户内唯一，见 UNIQUE(uid,name)） */
  upsert(kind: string, name: string, body: unknown): void {
    const def = kindDef(kind);
    const cleanName = assertName(name);
    const payload = (body ?? {}) as Record<string, unknown>;
    const description = assertDesc(payload.description);
    const cols = assertValues(def, payload.values);

    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id, sort_order FROM ${def.table} WHERE uid = ? AND name = ?`)
      .get(this.uid, cleanName) as { id: string; sort_order: number } | undefined;

    const colNames = Object.keys(cols);
    if (existing) {
      const sets = ['description = ?', 'updated_at = ?', ...colNames.map((c) => `${c} = ?`)];
      this.db
        .prepare(`UPDATE ${def.table} SET ${sets.join(', ')} WHERE id = ?`)
        .run(description, now, ...colNames.map((c) => cols[c]!), existing.id);
      return;
    }

    const maxRow = this.db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${def.table} WHERE uid = ?`)
      .get(this.uid) as { m: number } | undefined;

    const insertCols = ['id', 'uid', 'name', 'description', ...colNames, 'sort_order', 'created_at', 'updated_at'];
    const placeholders = insertCols.map(() => '?').join(',');
    this.db
      .prepare(`INSERT INTO ${def.table} (${insertCols.join(',')}) VALUES (${placeholders})`)
      .run(
        `ps_${randomUUID()}`,
        this.uid,
        cleanName,
        description,
        ...colNames.map((c) => cols[c]!),
        Number(maxRow?.m ?? -1) + 1,
        now,
        now,
      );
  }

  /** 删除；不存在返回 false（路由据此给 404） */
  remove(kind: string, name: string): boolean {
    const def = kindDef(kind);
    const r = this.db
      .prepare(`DELETE FROM ${def.table} WHERE uid = ? AND name = ?`)
      .run(this.uid, name.trim());
    return Number(r.changes) > 0;
  }

  /** 列 -> 派生 values（键换成模板 input 的 key） */
  private toRecord(def: PresetKindDef, row: Row): PresetRecord {
    const values: Record<string, unknown> = {};
    for (const f of def.fields) values[f.inputKey] = row[f.column];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      values,
    };
  }
}
