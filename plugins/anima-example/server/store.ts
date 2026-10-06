/**
 * 存储：全在插件自己的空间里，核不参与。
 *
 * 库文件与产出图都在 `space.root` 下。这两张表是插件自己的，所以可以用**真外键**：
 * assets 跟着 jobs 级联删（共用库时这是做不到的）。
 * 库里存的是**相对空间根**的路径，空间整体搬走也不失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assetUrl } from './meta.js';
import type { PluginSpace } from './types.js';
import type { AssetFileRow, AssetRow, Job, JobError, JobRow, JobStatus } from './model.js';

/**
 * 插件自己的迁移：框架不再管 schema 版本（没有账本、没有表前缀），
 * 用 SQLite 原生的 `PRAGMA user_version`。只追加、不回改；每条一个事务。
 * 数据是全新的（旧共享库已按决定清空），所以这里直接就是最终形态。
 */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT,
      status        TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      positive      TEXT NOT NULL DEFAULT '',
      negative      TEXT NOT NULL DEFAULT '',
      seed          INTEGER NOT NULL,
      steps         INTEGER NOT NULL,
      cfg           REAL NOT NULL,
      sampler       TEXT NOT NULL,
      scheduler     TEXT NOT NULL,
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      batch         INTEGER NOT NULL,
      rotation      TEXT,
      lora          TEXT,
      lora_strength REAL,
      unet          TEXT,
      clip          TEXT,
      vae           TEXT,
      prompt_id     TEXT,
      error         TEXT
    );
    CREATE TABLE assets (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      idx    INTEGER NOT NULL,
      file   TEXT NOT NULL,
      mime   TEXT NOT NULL,
      bytes  INTEGER NOT NULL,
      PRIMARY KEY (job_id, idx)
    )`,
  },
];

/** 版本号就是 `PRAGMA user_version`；跑完才提交，中途失败整条回滚 */
function migrate(db: DatabaseSync): void {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(step.sql);
      db.exec(`PRAGMA user_version = ${Number(step.version)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function toDbRow(job: Job): JobRow {
  return {
    id: job.jobId,
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    finished_at: job.finishedAt ?? null,
    status: job.status,
    description: job.values.description,
    positive: job.values.positive,
    negative: job.values.negative,
    seed: job.values.seed,
    steps: job.values.steps,
    cfg: job.values.cfg,
    sampler: job.values.sampler,
    scheduler: job.values.scheduler,
    width: job.values.width,
    height: job.values.height,
    batch: job.values.batch,
    rotation: job.values.rotation ?? null,
    lora: job.values.lora ?? null,
    lora_strength: job.values.loraStrength ?? null,
    unet: job.values.unet ?? null,
    clip: job.values.clip ?? null,
    vae: job.values.vae ?? null,
    prompt_id: job.promptId ?? null,
    error: job.error ? JSON.stringify(job.error) : null,
  };
}

function safeParse(text: string): JobError {
  try {
    return JSON.parse(text);
  } catch {
    return { code: 'UNKNOWN', message: String(text) };
  }
}

/** 作业与产出记录：库行 ↔ 作业对象，外加几张表的读写。 */
export class JobStore {
  space: PluginSpace;
  imagesDir: string;
  db: DatabaseSync;

  constructor(space: PluginSpace) {
    this.space = space;
    /** 产出图目录：每张图一个子目录（库行里存的是相对空间根的路径） */
    this.imagesDir = space.resolve('images');
    this.db = new DatabaseSync(space.resolve('anima-example.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
    fs.mkdirSync(this.imagesDir, { recursive: true });
  }

  /** 写一条作业（提交后、状态变化、收尾各调一次；同一 id 只更新状态列） */
  persist(job: Job): void {
    const r = toDbRow(job);
    this.db.prepare(
      `INSERT INTO jobs (
         id, created_at, started_at, finished_at, status, description, positive, negative,
         seed, steps, cfg, sampler, scheduler, width, height, batch, rotation, lora, lora_strength,
         unet, clip, vae, prompt_id, error
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         started_at=excluded.started_at, finished_at=excluded.finished_at, status=excluded.status,
         prompt_id=excluded.prompt_id, error=excluded.error`,
    ).run(
      r.id, r.created_at, r.started_at, r.finished_at, r.status, r.description, r.positive,
      r.negative, r.seed, r.steps, r.cfg, r.sampler, r.scheduler, r.width, r.height, r.batch,
      r.rotation, r.lora, r.lora_strength, r.unet, r.clip, r.vae, r.prompt_id, r.error,
    );
  }

  /** 库行 → 作业对象（形状与内存里的 job 一致，前端两处拿到的是同一个形状） */
  rowToJob(row: JobRow): Job {
    const assets = this.db
      .prepare('SELECT idx, file, mime, bytes FROM assets WHERE job_id = ? ORDER BY idx')
      .all(row.id) as unknown as AssetRow[];
    return {
      jobId: row.id,
      promptId: row.prompt_id,
      status: row.status as JobStatus,
      progress: null,
      node: null,
      values: {
        description: row.description,
        positive: row.positive,
        negative: row.negative,
        seed: row.seed,
        steps: row.steps,
        cfg: row.cfg,
        sampler: row.sampler,
        scheduler: row.scheduler,
        width: row.width,
        height: row.height,
        batch: row.batch,
        rotation: row.rotation,
        lora: row.lora,
        loraStrength: row.lora_strength,
        unet: row.unet,
        clip: row.clip,
        vae: row.vae,
      },
      assets: assets.map((a) => ({
        idx: a.idx,
        url: assetUrl(row.id, a.idx),
        filename: path.basename(a.file),
        mime: a.mime,
        bytes: a.bytes,
      })),
      error: row.error ? safeParse(row.error) : null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  /** 历史列表（新的在前） */
  list(limit: number): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as JobRow[];
  }

  count(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n ?? 0);
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as
      | JobRow
      | undefined;
  }

  /**
   * 只清记录，不动空间里的图片（那是用户资产）。
   * 真外键 + ON DELETE CASCADE：删 jobs 一张表就够，assets 自己跟着走。
   */
  clear(): number {
    const n = this.count();
    this.db.exec('DELETE FROM jobs');
    return n;
  }

  /** 某个作业的产出图目录（finalize 用它落盘） */
  imageDir(jobId: string): string {
    return path.join(this.imagesDir, jobId);
  }

  /** 落一条产出记录；`file` 是**绝对路径**，入库前转成相对空间根（搬走空间也不失效） */
  saveAsset(jobId: string, idx: number, file: string, mime: string, bytes: number): void {
    this.db.prepare(
      `INSERT INTO assets (job_id, idx, file, mime, bytes) VALUES (?,?,?,?,?)
       ON CONFLICT(job_id, idx) DO UPDATE SET file=excluded.file, mime=excluded.mime, bytes=excluded.bytes`,
    ).run(jobId, idx, path.relative(this.space.root, file), mime, bytes);
  }

  asset(jobId: string, idx: number): AssetFileRow | undefined {
    return this.db
      .prepare('SELECT file, mime FROM assets WHERE job_id = ? AND idx = ?')
      .get(jobId, idx) as unknown as AssetFileRow | undefined;
  }

  /** 库里存的是相对路径 → 交给空间句柄解析（顺带挡掉越界值） */
  resolveImage(file: string): string {
    return this.space.resolve(String(file));
  }

  close(): void {
    this.db.close();
  }
}
