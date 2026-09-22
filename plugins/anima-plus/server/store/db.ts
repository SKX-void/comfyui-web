import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 访问层。
 *
 * 用 Node **内置**的 `node:sqlite`，而不是 better-sqlite3：
 * 后者是原生模块（需 node-gyp 编译），与我们「纯 JS 源码构建」的目标冲突。
 *
 * 迁移用 `PRAGMA user_version` 记录版本（SQLite 头部的整数，不需要额外表）。
 */

export type Db = DatabaseSync;

interface Migration {
  version: number;
  name: string;
  /** 纯 DDL 用 sql；需要数据搬迁时用 run */
  sql?: string;
  run?: (db: Db) => void;
}

/**
 * 迁移列表：**只追加、不修改已发布的条目**。
 * 每条在单个事务里执行，失败即整体回滚。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'presets(kv+json)',
    // 历史版本：单表 + JSON 值。已被 v2 取代，但保留条目以尊重"不回改"原则。
    sql: `
      CREATE TABLE IF NOT EXISTS presets (
        id         TEXT PRIMARY KEY,
        uid        TEXT NOT NULL,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (uid, kind, name)
      );
      CREATE INDEX IF NOT EXISTS idx_presets_lookup ON presets(uid, kind, sort_order);
    `,
  },
  {
    version: 2,
    name: 'presets per-kind tables',
    run: (db) => {
      // 每种预设一张表（范式化：类型化列 + CHECK 约束，而非 JSON 值）
      db.exec(`
        CREATE TABLE preset_prompt (
          id          TEXT PRIMARY KEY,
          uid         TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          text        TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          UNIQUE (uid, name)
        );
        CREATE TABLE preset_quality_pos (
          id          TEXT PRIMARY KEY,
          uid         TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          text        TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          UNIQUE (uid, name)
        );
        CREATE TABLE preset_quality_neg (
          id          TEXT PRIMARY KEY,
          uid         TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          text        TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          UNIQUE (uid, name)
        );
        CREATE TABLE preset_size (
          id          TEXT PRIMARY KEY,
          uid         TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          width       INTEGER NOT NULL CHECK (width  > 0),
          height      INTEGER NOT NULL CHECK (height > 0),
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          UNIQUE (uid, name)
        );
      `);

      // 搬迁 v1 的数据（老表若不存在则跳过，例如全新库）
      const hasOld = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='presets'")
        .get() as { name?: string } | undefined;
      if (!hasOld?.name) return;

      const rows = db
        .prepare('SELECT id, uid, kind, name, value, sort_order, created_at, updated_at FROM presets')
        .all() as unknown as OldPresetRow[];

      const textKinds: Record<string, string> = {
        prompt: 'preset_prompt',
        qualityPos: 'preset_quality_pos',
        qualityNeg: 'preset_quality_neg',
      };

      for (const r of rows) {
        const kind = String(r.kind);
        const value = safeParseObject(String(r.value));
        const desc = typeof value.$desc === 'string' ? value.$desc : '';
        try {
          if (textKinds[kind]) {
            const text = typeof value[kind] === 'string' ? (value[kind] as string) : '';
            db.prepare(
              `INSERT OR IGNORE INTO ${textKinds[kind]} (id, uid, name, description, text, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
            ).run(r.id, r.uid, r.name, desc, text, r.sort_order, r.created_at, r.updated_at);
          } else if (kind === 'size') {
            const w = Number(value.width);
            const h = Number(value.height);
            if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) continue;
            db.prepare(
              'INSERT OR IGNORE INTO preset_size (id, uid, name, description, width, height, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
            ).run(r.id, r.uid, r.name, desc, w, h, r.sort_order, r.created_at, r.updated_at);
          }
        } catch {
          // 单条搬迁失败不影响整体（非法值由 CHECK 拦下）
        }
      }

      db.exec('DROP TABLE presets');
    },
  },
];

/** v1 老表的行形状（搬迁用） */
interface OldPresetRow {
  id: string;
  uid: string;
  kind: string;
  name: string;
  value: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function openDatabase(file: string, log: (msg: string, meta?: unknown) => void = () => {}): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const before = userVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= before) continue;
    try {
      db.exec('BEGIN');
      if (m.sql) db.exec(m.sql);
      m.run?.(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      log('已应用迁移', { version: m.version, name: m.name });
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也无更多可做 */
      }
      throw new Error(`迁移 v${m.version} (${m.name}) 失败: ${String(err)}`);
    }
  }

  return db;
}

export function userVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
}
