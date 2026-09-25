/**
 * anima-example —— **第一个「真」插件**。
 *
 * 和 anima-plus 的区别就一句话：它不反代任何旧服务，自己把活干完：
 *
 *   表单 → 改工作流图 → POST ComfyUI /prompt → 订阅 ComfyUI /ws 收进度
 *        → 拉 /history → 下载 /view 的图 → 落到自己空间里的 images/
 *        → SSE 推给浏览器 → 作业记录写进自己的表
 *
 * 它演示插件契约里除了「反代」以外的每一条：
 *   - `inject = ['routes','space']` —— 核只给一个句柄：文件空间
 *   - 存储**完全自管**：`node:sqlite` 开在自己的空间里，版本用 `PRAGMA user_version`
 *   - 产出图落进自己的空间（谁都不许自动清）
 *   - 设置项来自 `package.json` 的 `plugin.settings[]`，值由**本插件自己持有**
 *     （空间里的 `settings.json`，见 §2.5）：它现在是目录型 tab，宿主不代管配置
 *
 * 只 import node 内置模块和类型，**不 import cordis**：宿主已经把 cordis 打进自己的产物，
 * 插件再引一份就是两个实例。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const name = 'anima-example';

// 核只给一个句柄：文件空间（按**包名**分配，不是 profile 里的行 id）
export const inject = ['routes', 'space'];

const ID = 'anima-example';
/** 空间按包名分配，所以这里必须写本插件的包名 */
const PACKAGE = '@comfyui-web/anima-example';
const WORKFLOW_FILE = new URL('./workflow.json', import.meta.url);
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

// ===========================================================================
// 1. 工作流：载入 + 把「表单字段」绑定到「工作流节点」
// ===========================================================================

function loadWorkflow() {
  return JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
}

/** 按 class_type 找唯一节点；找不到直接抛——配置错要立刻炸，而不是静默出一张废图 */
function byClass(graph, classType) {
  for (const [nodeId, node] of Object.entries(graph)) {
    if (node && node.class_type === classType) return [nodeId, node];
  }
  throw new Error(`工作流里找不到 ${classType} 节点`);
}

/** 顺着连线往上游走一步：node.inputs[key] === [nodeId, slotIndex] */
function upstream(graph, node, key) {
  const link = node?.inputs?.[key];
  if (!Array.isArray(link)) return null;
  const nodeId = String(link[0]);
  return graph[nodeId] ? [nodeId, graph[nodeId]] : null;
}

/**
 * 解析绑定关系。
 *
 * **全部靠 class_type + 连线推导，一个节点号都不写死** —— 在 ComfyUI 里拖动节点、
 * 重新导出、换一个同构的工作流，这里都不会失效。节点号只在同一次会话里当索引使。
 */
function resolveBindings(graph) {
  const [samplerId, sampler] = byClass(graph, 'KSampler');

  const positive = upstream(graph, sampler, 'positive');
  const negative = upstream(graph, sampler, 'negative');
  if (!positive || !negative) throw new Error('KSampler 的 positive/negative 没有连线');

  // 潜空间：sampler.latent_image → 可能是 LatentRotate → 再到 EmptyLatentImage
  let latent = upstream(graph, sampler, 'latent_image');
  let rotate = null;
  if (latent && latent[1].class_type === 'LatentRotate') {
    rotate = latent;
    latent = upstream(graph, latent[1], 'samples');
  }
  if (!latent || latent[1].class_type !== 'EmptyLatentImage') {
    throw new Error('找不到 EmptyLatentImage（KSampler.latent_image 的源头）');
  }

  // LoRA：从 sampler.model 往上游找第一个 LoraLoader
  let cursor = upstream(graph, sampler, 'model');
  let lora = null;
  while (cursor) {
    if (cursor[1].class_type === 'LoraLoader') {
      lora = cursor;
      break;
    }
    cursor = upstream(graph, cursor[1], 'model');
  }

  const [unetId, unet] = byClass(graph, 'UNETLoader');
  const [clipId, clip] = byClass(graph, 'CLIPLoader');
  const [vaeId, vae] = byClass(graph, 'VAELoader');
  const [saveId] = byClass(graph, 'SaveImage');

  return {
    samplerId,
    positiveId: positive[0],
    negativeId: negative[0],
    latentId: latent[0],
    rotateId: rotate ? rotate[0] : null,
    loraId: lora ? lora[0] : null,
    unetId,
    clipId,
    vaeId,
    saveId,
    // 工作流自带的当前值 = 表单的初始值
    // 工作流自带的正向文本（本插件里它是"质量/风格"串，不是描述）+ 负向文本
    current: {
      positive: String(positive[1].inputs?.text ?? ''),
      negative: String(negative[1].inputs?.text ?? ''),
      seed: Number(sampler.inputs?.seed ?? 0),
      steps: Number(sampler.inputs?.steps ?? 20),
      cfg: Number(sampler.inputs?.cfg ?? 7),
      sampler: String(sampler.inputs?.sampler_name ?? 'euler'),
      scheduler: String(sampler.inputs?.scheduler ?? 'normal'),
      width: Number(latent[1].inputs?.width ?? 1024),
      height: Number(latent[1].inputs?.height ?? 1024),
      batch: Number(latent[1].inputs?.batch_size ?? 1),
      rotation: rotate ? String(rotate[1].inputs?.rotation ?? 'none') : null,
      lora: lora ? String(lora[1].inputs?.lora_name ?? '') : null,
      loraStrength: lora ? Number(lora[1].inputs?.strength_model ?? 1) : null,
      unet: String(unet.inputs?.unet_name ?? ''),
      clip: String(clip.inputs?.clip_name ?? ''),
      clipType: String(clip.inputs?.type ?? 'stable_diffusion'),
      vae: String(vae.inputs?.vae_name ?? ''),
    },
  };
}

// ===========================================================================
// 2. ComfyUI 客户端：HTTP + 一条共享 WebSocket
// ===========================================================================

class ComfyClient {
  constructor(baseUrl, log) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = randomUUID();
    this.log = log;
    this.handlers = new Set();
    this.ws = null;
    this.started = false;
    this.retry = 0;
    this.timer = null;
    this.lastError = null;
  }

  setBaseUrl(baseUrl) {
    const next = baseUrl.replace(/\/+$/, '');
    if (next === this.baseUrl) return;
    this.baseUrl = next;
    this.#closeWs();
    if (this.started) this.#connect();
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start() {
    this.started = true;
    this.#connect();
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.#closeWs();
  }

  #closeWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
    }
  }

  /**
   * 本仓所有任务共用一个 clientId、只维护**一条**共享连接
   * （原因见 plugins/anima-plus/server/comfy/real.ts 的注释），靠 prompt_id 区分归属。
   * progress 事件在部分版本里不带 prompt_id，靠 execution_start 记住当前在跑哪个 prompt。
   */
  #connect() {
    if (!this.started) return;
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = `?clientId=${encodeURIComponent(this.clientId)}`;

    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      this.#scheduleReconnect(`WS 创建失败: ${err}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.lastError = null;
      this.log(`ComfyUI WS 已连接 ${url.host}`);
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return; // 二进制帧是预览图，本插件不处理
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object' || !payload.type) return;
      for (const handler of this.handlers) {
        try {
          handler(payload);
        } catch (err) {
          this.log(`事件处理器抛错: ${err}`);
        }
      }
    });

    ws.addEventListener('error', () => {
      this.lastError = 'WebSocket 错误';
    });

    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.#scheduleReconnect('WS 断开');
    });
  }

  #scheduleReconnect(reason) {
    if (!this.started || this.timer) return;
    const delay = Math.min(500 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.lastError = reason;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#connect();
    }, delay);
    if (this.retry === 1) this.log(`${reason}，${delay}ms 后重连`);
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === 1;
  }

  async #json(pathname, init = {}, timeoutMs = 30_000) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new Error(
        isTimeout
          ? `ComfyUI 请求超时（${timeoutMs}ms）: ${pathname}`
          : `连不上 ComfyUI (${this.baseUrl}): ${err}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ComfyUI ${pathname} 返回 ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  async prompt(graph) {
    const data = await this.#json('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    return {
      promptId: String(data.prompt_id ?? ''),
      number: Number(data.number ?? 0),
      nodeErrors: data.node_errors ?? {},
    };
  }

  /** 只问单个 prompt：ComfyUI 的 /history/<id> 会返回一个单键对象 */
  async history(promptId) {
    const raw = await this.#json(`/history/${encodeURIComponent(promptId)}`);
    const entry = raw ? raw[promptId] : undefined;
    if (!entry) return null;
    return {
      images: collectImages(entry.outputs ?? {}),
      completed: Boolean(entry.status?.completed),
      statusStr: String(entry.status?.status_str ?? ''),
      messages: entry.status?.messages ?? [],
    };
  }

  async view({ filename, subfolder = '', type = 'output' }) {
    // 路径穿越防护：filename 只能是一个文件名
    if (filename.includes('..') || filename.startsWith('/')) {
      throw new Error(`非法文件名: ${filename}`);
    }
    const qs = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${this.baseUrl}/view?${qs}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`取图返回 ${res.status}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/png',
    };
  }

  async interrupt() {
    await this.#json('/interrupt', { method: 'POST' });
  }

  async deleteQueued(promptId) {
    await this.#json('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  async queue() {
    const raw = await this.#json('/queue');
    return {
      running: (raw.queue_running ?? []).length,
      pending: (raw.queue_pending ?? []).length,
    };
  }

  async objectInfo() {
    return this.#json('/object_info', {}, 30_000);
  }

  async stats() {
    return this.#json('/system_stats', {}, 3_000);
  }
}

/** ComfyUI 的 outputs 形如 { "21": { images: [{filename, subfolder, type}] } } */
function collectImages(outputs) {
  const out = [];
  for (const [nodeId, output] of Object.entries(outputs)) {
    for (const image of output?.images ?? []) {
      if (image && typeof image.filename === 'string') {
        out.push({
          nodeId,
          filename: image.filename,
          subfolder: image.subfolder ?? '',
          type: image.type ?? 'output',
        });
      }
    }
  }
  return out;
}

// ===========================================================================
// 3. 插件本体
// ===========================================================================

/**
 * 插件自己的迁移：框架不再管 schema 版本（没有账本、没有表前缀），
 * 用 SQLite 原生的 `PRAGMA user_version`。只追加、不回改；每条一个事务。
 * 数据是全新的（旧共享库已按决定清空），所以这里直接就是最终形态。
 */
const MIGRATIONS = [
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
function migrate(db) {
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

// ===========================================================================
// 2.5 设置：由插件自己持有（决策 D15）
// ===========================================================================
//
// 目录型 tab 没有"行配置"这回事（宿主对它的 PUT config 返回 400，plugins.yml 里也没有它），
// 所以设置住在自己的空间里（`data/plugins/<包名>/settings.json`），由本插件的 /api/settings
// 读写。字段的**形状**仍写在 package.json 的 plugin.settings 里（界面从宿主清单端点取）。

const SETTINGS_FILE_NAME = 'settings.json';

/** 认识的设置项：写文件时只收这些键，UI 送来的杂物不住进空间 */
const SETTING_KEYS = [
  'comfyuiBaseUrl',
  'negativePrompt',
  'defaultSteps',
  'defaultCfg',
  'defaultWidth',
  'defaultHeight',
  'historyLimit',
];

/** 读设置；文件不存在 = 还没配过（各字段回落到工作流/内置默认值） */
function readStoredSettings(space) {
  const file = space.resolve(SETTINGS_FILE_NAME);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { file, values: {}, error: '设置文件不是一个 JSON 对象' };
    }
    return { file, values: raw };
  } catch (err) {
    // 没配过和读坏了必须分开说：前者是正常状态，后者要让用户看见
    if (err && err.code === 'ENOENT') return { file, values: {} };
    return { file, values: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

function writeStoredSettings(space, values) {
  const clean = {};
  for (const key of SETTING_KEYS) {
    if (values?.[key] !== undefined) clean[key] = values[key];
  }
  const file = space.resolve(SETTINGS_FILE_NAME);
  fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return file;
}

/** 一次性迁移：清单行的 config 只在**首次**装载时被采信（那时它还是唯一的配置来源） */
function seedStoredSettings(space, legacy) {
  if (legacy === null || typeof legacy !== 'object' || Object.keys(legacy).length === 0) return false;
  if (fs.existsSync(space.resolve(SETTINGS_FILE_NAME))) return false;
  writeStoredSettings(space, legacy);
  return true;
}

export function apply(ctx, legacySettings) {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const log = (msg) => ctx.logger?.info?.(`[${ID}] ${msg}`);

  // 设置归插件自己（D15）：值在 <space>/settings.json；清单行的 config 只在首次装载时被采信一次
  if (seedStoredSettings(space, legacySettings)) {
    log(`已把清单里的配置落成 ${space.resolve(SETTINGS_FILE_NAME)}（一次性迁移）`);
  }
  const stored = readStoredSettings(space);
  if (stored.error !== undefined) log(`设置文件读不出来，改用内置默认值：${stored.error}`);
  const config = stored.values;

  // ---- 3.1 存储：全在插件自己的空间里，核不参与 ----
  //   库文件与产出图都在 space.root 下。这两张表是插件自己的，所以可以用
  //   **真外键**：assets 跟着 jobs 级联删（共用库时这是做不到的）。
  const db = new DatabaseSync(space.resolve('anima-example.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  /** 产出图目录；库里存的是**相对空间根**的路径，空间整体搬走也不失效 */
  const IMAGES = space.resolve('images');
  fs.mkdirSync(IMAGES, { recursive: true });

  // ---- 3.2 工作流与绑定（启动时解析一次，失败就在清单里报出来）----
  let workflow;
  let bindings;
  try {
    workflow = loadWorkflow();
    bindings = resolveBindings(workflow);
  } catch (err) {
    // 解析不了就抛出：宿主会把本插件标成 broken 并显示原因，比带着坏绑定跑出废图强
    throw new Error(`工作流解析失败（${WORKFLOW_FILE.pathname}）：${err.message}`);
  }
  log(`工作流已载入：${Object.keys(workflow).length} 个节点，绑定 ${JSON.stringify(Object.keys(bindings.current))}`);

  // ---- 3.3 设置：值由插件自己持有（空间里的 settings.json，见 §2.5）----
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const str = (v, fallback) => (typeof v === 'string' && v.trim() !== '' ? v : fallback);
  const settings = {
    comfyuiBaseUrl: str(config?.comfyuiBaseUrl, 'http://localhost:8188'),
    negativePrompt: typeof config?.negativePrompt === 'string' ? config.negativePrompt : bindings.current.negative,
    defaultSteps: num(config?.defaultSteps, bindings.current.steps),
    defaultCfg: num(config?.defaultCfg, bindings.current.cfg),
    defaultWidth: num(config?.defaultWidth, bindings.current.width),
    defaultHeight: num(config?.defaultHeight, bindings.current.height),
    historyLimit: num(config?.historyLimit, 50),
  };

  // 设置里配的默认值也必须落在护栏内 —— 否则"不传参数"就绕过了上限。
  // 做法与 anima-plus 一致：不炸，但收敛并说出来（越界值会出现在日志里）。
  const clampDefault = (value, min, max, label) => {
    const clamped = Math.min(Math.max(Math.round(value), min), max);
    if (clamped !== value) log(`设置 ${label}=${value} 越界，已收敛到 ${clamped}（护栏 ${min}~${max}）`);
    return clamped;
  };
  settings.defaultSteps = clampDefault(settings.defaultSteps, SAFETY.minSteps, SAFETY.maxSteps, 'defaultSteps');
  settings.defaultWidth = clampDefault(settings.defaultWidth, SAFETY.minSide, SAFETY.maxSide, 'defaultWidth');
  settings.defaultHeight = clampDefault(settings.defaultHeight, SAFETY.minSide, SAFETY.maxSide, 'defaultHeight');

  const comfy = new ComfyClient(settings.comfyuiBaseUrl, log);

  // ---- 3.4 作业：内存状态 + SSE 订阅者 ----
  /** jobId → { job, listeners:Set, graph } */
  const live = new Map();
  /** ComfyUI 的 prompt_id → jobId */
  const byPromptId = new Map();
  /** progress 事件可能不带 prompt_id，记住当前在跑的 */
  let runningPromptId = null;
  /** /options 的上游缓存 */
  let optionsCache = { at: 0, value: null };

  function snapshot(job) {
    return {
      jobId: job.jobId,
      promptId: job.promptId ?? null,
      status: job.status,
      progress: job.progress ?? null,
      node: job.node ?? null,
      values: job.values,
      assets: job.assets ?? [],
      error: job.error ?? null,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    };
  }

  function emit(entry, type, data) {
    for (const listener of entry.listeners) {
      try {
        listener(type, data);
      } catch (err) {
        log(`SSE 订阅者抛错: ${err}`);
      }
    }
  }

  const assetUrl = (jobId, idx) => `/api/p/${ID}/assets/${jobId}/${idx}`;

  function toDbRow(job) {
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

  function persist(job) {
    const r = toDbRow(job);
    db.prepare(
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

  function rowToJob(row) {
    const assets = db
      .prepare('SELECT idx, file, mime, bytes FROM assets WHERE job_id = ? ORDER BY idx')
      .all(row.id);
    return {
      jobId: row.id,
      promptId: row.prompt_id,
      status: row.status,
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

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return { code: 'UNKNOWN', message: String(text) };
    }
  }

  /** 终态收尾：拉 history → 下载图片 → 落盘 → 写库 → 推 SSE */
  async function finalize(entry, forcedError) {
    const job = entry.job;
    if (TERMINAL.has(job.status)) return;

    if (forcedError) {
      job.status = 'failed';
      job.error = forcedError;
      job.finishedAt = new Date().toISOString();
      persist(job);
      emit(entry, 'error', { jobId: job.jobId, error: job.error });
      return;
    }

    try {
      // executing(node=null) 与 executed 谁先到不保证，给小重试
      let history = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        history = await comfy.history(job.promptId);
        if (history && history.images.length > 0) break;
        if (history && history.completed && history.statusStr === 'error') break;
        await sleep(attempt === 0 ? 150 : 500);
      }

      const images = history?.images ?? [];
      if (images.length === 0) {
        const failed = history && history.statusStr === 'error';
        throw new Error(
          failed
            ? `ComfyUI 执行失败：${JSON.stringify(history.messages).slice(0, 400)}`
            : 'ComfyUI 没有返回图片',
        );
      }

      const dir = path.join(IMAGES, job.jobId);
      fs.mkdirSync(dir, { recursive: true });
      const assets = [];
      for (const [idx, image] of images.entries()) {
        const { data, contentType } = await comfy.view(image);
        const ext = extFor(contentType, image.filename);
        const file = path.join(dir, `${idx}${ext}`);
        fs.writeFileSync(file, data);
        // 存相对空间根的路径（不是绝对路径）
        db.prepare(
          `INSERT INTO assets (job_id, idx, file, mime, bytes) VALUES (?,?,?,?,?)
           ON CONFLICT(job_id, idx) DO UPDATE SET file=excluded.file, mime=excluded.mime, bytes=excluded.bytes`,
        ).run(job.jobId, idx, path.relative(space.root, file), contentType, data.length);
        assets.push({ idx, url: assetUrl(job.jobId, idx), filename: path.basename(file), mime: contentType, bytes: data.length });
      }

      job.assets = assets;
      job.status = 'succeeded';
      job.progress = { value: job.values.steps, max: job.values.steps };
      job.finishedAt = new Date().toISOString();
      persist(job);
      emit(entry, 'completed', { jobId: job.jobId, assets, status: 'succeeded' });
      log(`作业 ${job.jobId} 完成，${assets.length} 张图`);
    } catch (err) {
      job.status = 'failed';
      job.error = { code: 'COMFY_ERROR', message: err instanceof Error ? err.message : String(err) };
      job.finishedAt = new Date().toISOString();
      persist(job);
      emit(entry, 'error', { jobId: job.jobId, error: job.error });
      log(`作业 ${job.jobId} 失败：${job.error.message}`);
    }
  }

  // ---- 3.5 ComfyUI 事件 → 作业状态 ----
  const unsubscribeComfy = comfy.onEvent((payload) => {
    const type = payload.type;
    const data = payload.data ?? {};

    if (type === 'execution_start') {
      runningPromptId = data.prompt_id ?? null;
      const entry = runningPromptId ? live.get(byPromptId.get(runningPromptId)) : undefined;
      if (entry && entry.job.status !== 'running') {
        entry.job.status = 'running';
        entry.job.startedAt = new Date().toISOString();
        persist(entry.job);
        emit(entry, 'started', { jobId: entry.job.jobId, status: 'running' });
      }
      return;
    }

    if (type === 'progress') {
      const promptId = data.prompt_id ?? runningPromptId;
      const entry = promptId ? live.get(byPromptId.get(promptId)) : undefined;
      if (!entry) return;
      entry.job.progress = { value: Number(data.value ?? 0), max: Number(data.max ?? 0) };
      emit(entry, 'progress', { jobId: entry.job.jobId, progress: entry.job.progress });
      return;
    }

    if (type === 'executing') {
      const promptId = data.prompt_id ?? runningPromptId;
      const entry = promptId ? live.get(byPromptId.get(promptId)) : undefined;
      if (!entry) return;
      entry.job.node = data.node ?? null;
      emit(entry, 'node', { jobId: entry.job.jobId, node: entry.job.node });
      if (data.node === null || data.node === undefined) {
        runningPromptId = null;
        void finalize(entry);
      }
      return;
    }

    if (type === 'execution_error') {
      const promptId = data.prompt_id ?? runningPromptId;
      const entry = promptId ? live.get(byPromptId.get(promptId)) : undefined;
      if (!entry) return;
      runningPromptId = null;
      void finalize(entry, {
        code: 'COMFY_EXECUTION_ERROR',
        message: String(data.exception_message ?? 'ComfyUI 执行出错'),
        node: data.node_id ?? null,
      });
      return;
    }

    if (type === 'execution_interrupted') {
      const promptId = data.prompt_id ?? runningPromptId;
      const entry = promptId ? live.get(byPromptId.get(promptId)) : undefined;
      runningPromptId = null;
      if (!entry || TERMINAL.has(entry.job.status)) return;
      entry.job.status = 'canceled';
      entry.job.finishedAt = new Date().toISOString();
      persist(entry.job);
      emit(entry, 'canceled', { jobId: entry.job.jobId });
    }
  });

  // ---- 3.6 参数校验：宁可 400，也不把越界值打到 GPU（上下限见文件末尾「安全护栏」）----
  async function options() {
    if (optionsCache.value && Date.now() - optionsCache.at < 60_000) return optionsCache.value;
    let info = null;
    try {
      info = await comfy.objectInfo();
    } catch (err) {
      log(`/object_info 拉取失败（表单只能用手填值）：${err}`);
    }
    const enumOf = (node, key) => {
      const spec = info?.[node]?.input?.required?.[key] ?? info?.[node]?.input?.optional?.[key];
      const first = Array.isArray(spec) ? spec[0] : null;
      return Array.isArray(first) ? first.map(String) : [];
    };
    const value = {
      reachable: info !== null,
      unet: enumOf('UNETLoader', 'unet_name'),
      clip: enumOf('CLIPLoader', 'clip_name'),
      clipType: enumOf('CLIPLoader', 'type'),
      vae: enumOf('VAELoader', 'vae_name'),
      lora: enumOf('LoraLoader', 'lora_name'),
      sampler: enumOf('KSampler', 'sampler_name'),
      scheduler: enumOf('KSampler', 'scheduler'),
      rotation: enumOf('LatentRotate', 'rotation'),
      defaults: {
        ...bindings.current,
        // 描述词默认留空：工作流里那串文本是质量/风格词，归"正向提示词"（与负向词对称）
        description: '',
        negative: settings.negativePrompt,
        steps: settings.defaultSteps,
        cfg: settings.defaultCfg,
        width: settings.defaultWidth,
        height: settings.defaultHeight,
        hasRotateNode: bindings.rotateId !== null,
        hasLoraNode: bindings.loraId !== null,
      },
      workflow: { nodes: Object.keys(workflow).length, file: 'workflow.json' },
      bindings: {
        sampler: bindings.samplerId,
        positive: bindings.positiveId,
        negative: bindings.negativeId,
        latent: bindings.latentId,
        rotate: bindings.rotateId,
        lora: bindings.loraId,
        unet: bindings.unetId,
        clip: bindings.clipId,
        vae: bindings.vaeId,
        save: bindings.saveId,
      },
    };
    optionsCache = { at: Date.now(), value };
    return value;
  }

  function validate(body, opts) {
    const errors = [];
    const current = bindings.current;
    const pickEnum = (value, list, fallback) => {
      if (value === undefined || value === null || value === '') return fallback;
      const v = String(value);
      if (list.length > 0 && !list.includes(v)) {
        errors.push(`不是可选值: ${v}`);
        return fallback;
      }
      return v;
    };
    const int = (value, fallback, min, max, label) => {
      if (value === undefined || value === null || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        errors.push(`${label} 必须是 ${min}~${max} 的整数`);
        return fallback;
      }
      return n;
    };
    const float = (value, fallback, min, max, label) => {
      if (value === undefined || value === null || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) {
        errors.push(`${label} 必须是 ${min}~${max} 的数`);
        return fallback;
      }
      return n;
    };

    // 描述词 = 主输入框。兼容旧字段名 prompt（等价于描述词）
    const description =
      typeof body?.description === 'string'
        ? body.description
        : typeof body?.prompt === 'string'
          ? body.prompt
          : '';
    const positive = typeof body?.positive === 'string' ? body.positive : '';
    const negative = typeof body?.negative === 'string' ? body.negative : settings.negativePrompt;
    if (description.trim() === '' && positive.trim() === '') {
      errors.push('描述提示词与正向提示词不能同时为空');
    }
    if (description.length > 8000) errors.push('描述提示词过长（>8000）');
    if (positive.length > 8000) errors.push('正向提示词过长（>8000）');
    if (negative.length > 8000) errors.push('负向提示词过长（>8000）');

    const o = opts ?? {};
    const values = {
      description,
      positive,
      negative,
      seed:
        body?.seed === undefined || body?.seed === null || body?.seed === '' || body?.seed === -1
          ? randomSeed()
          : int(body.seed, randomSeed(), 0, Number.MAX_SAFE_INTEGER, '种子'),
      steps: int(body?.steps, settings.defaultSteps, SAFETY.minSteps, SAFETY.maxSteps, '步数'),
      cfg: float(body?.cfg, settings.defaultCfg, 0, 30, 'CFG'),
      sampler: pickEnum(body?.sampler, o.sampler ?? [], current.sampler),
      scheduler: pickEnum(body?.scheduler, o.scheduler ?? [], current.scheduler),
      width: int(body?.width, settings.defaultWidth, SAFETY.minSide, SAFETY.maxSide, '宽度'),
      height: int(body?.height, settings.defaultHeight, SAFETY.minSide, SAFETY.maxSide, '高度'),
      batch: int(body?.batch, 1, 1, 8, '批量'),
      rotation: bindings.rotateId ? pickEnum(body?.rotation, o.rotation ?? [], current.rotation ?? 'none') : null,
      lora: bindings.loraId ? pickEnum(body?.lora, o.lora ?? [], current.lora ?? '') : null,
      loraStrength: bindings.loraId ? float(body?.loraStrength, current.loraStrength ?? 1, 0, 2, 'LoRA 强度') : null,
      unet: pickEnum(body?.unet, o.unet ?? [], current.unet),
      clip: pickEnum(body?.clip, o.clip ?? [], current.clip),
      vae: pickEnum(body?.vae, o.vae ?? [], current.vae),
    };
    return { values, errors };
  }

  /** 把表单值写进工作流图（深拷贝，绝不改内存里的模板） */
  function buildGraph(values) {
    const graph = structuredClone(workflow);
    // 「手工拼接」就发生在这一行：描述词在前、正向词（质量/风格）在后
    graph[bindings.positiveId].inputs.text = joinPrompt(values.description, values.positive);
    graph[bindings.negativeId].inputs.text = values.negative;
    const sampler = graph[bindings.samplerId].inputs;
    sampler.seed = values.seed;
    sampler.steps = values.steps;
    sampler.cfg = values.cfg;
    sampler.sampler_name = values.sampler;
    sampler.scheduler = values.scheduler;
    const latent = graph[bindings.latentId].inputs;
    latent.width = values.width;
    latent.height = values.height;
    latent.batch_size = values.batch;
    if (bindings.rotateId && values.rotation) graph[bindings.rotateId].inputs.rotation = values.rotation;
    if (bindings.loraId && values.lora) {
      graph[bindings.loraId].inputs.lora_name = values.lora;
      graph[bindings.loraId].inputs.strength_model = values.loraStrength;
    }
    graph[bindings.unetId].inputs.unet_name = values.unet;
    graph[bindings.clipId].inputs.clip_name = values.clip;
    graph[bindings.vaeId].inputs.vae_name = values.vae;
    return graph;
  }

  // ---- 3.7 路由：框架统一加前缀 → /api/p/anima-example/* ----

  // 设置端点：设置归插件自己（D15）。字段的**形状**在 package.json 的 plugin.settings 里，
  // 值在这里 —— 存完由前端请求宿主的 `POST /api/tabs/:id/reload`，让本插件重新 apply()。
  routes.get('/settings', async () => ({
    values: stored.values,
    effective: { ...settings },
    file: stored.file,
    ...(stored.error !== undefined ? { error: stored.error } : {}),
  }));

  routes.put('/settings', async (request, reply) => {
    const body = request?.body;
    const incoming =
      body !== null && typeof body === 'object' && !Array.isArray(body) ? body.values : undefined;
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: '请求体必须是 { values: {…} }：键与 package.json 的 plugin.settings 同名',
        },
      });
    }
    // 值原样落盘、**不在这里收敛**：范围与回落在 §3.3 一处决定（越界会记日志）
    const file = writeStoredSettings(space, incoming);
    log(`设置已更新 ${file}（重新挂载后生效）`);
    return { values: incoming, file, reloadRequired: true };
  });

  routes.get('/options', async () => {
    const o = await options();
    // limits 一起下发：前端把输入框的 min/max 直接绑上，免得用户"填完才吃 400"
    return { ...o, limits: { ...SAFETY }, settings: { ...settings, comfyuiBaseUrl: settings.comfyuiBaseUrl } };
  });

  routes.get('/status', async () => {
    const out = {
      comfyuiBaseUrl: comfy.baseUrl,
      wsConnected: comfy.connected,
      lastError: comfy.lastError,
      inFlight: [...live.values()].filter((e) => !TERMINAL.has(e.job.status)).length,
    };
    try {
      const [stats, queue] = await Promise.all([comfy.stats(), comfy.queue()]);
      out.comfyui = {
        reachable: true,
        version: stats?.system?.comfyui_version ?? null,
        device: stats?.devices?.[0]?.name ?? null,
        queue,
      };
    } catch (err) {
      out.comfyui = { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
    return out;
  });

  routes.post('/jobs', async (request, reply) => {
    let o;
    try {
      o = await options();
    } catch {
      o = null;
    }
    const { values, errors } = validate(request.body ?? {}, o ?? undefined);
    if (errors.length > 0) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: errors.join('；') } });

    const jobId = randomUUID();

    // 建图与最终护栏都在"登记作业"之前：越界的请求不该在历史里留一条失败作业，
    // 也不该占住内存表（真正的闸是 assertGraphSafe，见文件末尾「安全护栏」）。
    let graph;
    try {
      graph = buildGraph(values);
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'GRAPH_BUILD_FAILED', message: err instanceof Error ? err.message : String(err) },
      });
    }
    const unsafe = assertGraphSafe(graph, bindings);
    if (unsafe.length > 0) {
      return reply.code(400).send({ error: { code: 'UNSAFE_GRAPH', message: unsafe.join('；') } });
    }

    const entry = {
      job: {
        jobId,
        promptId: null,
        status: 'queued',
        progress: null,
        node: null,
        values,
        assets: [],
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      },
      listeners: new Set(),
      graph,
    };
    live.set(jobId, entry);

    try {
      const submitted = await comfy.prompt(entry.graph);
      if (!submitted.promptId) throw new Error('ComfyUI 没有返回 prompt_id');
      entry.job.promptId = submitted.promptId;
      byPromptId.set(submitted.promptId, jobId);
      persist(entry.job);
      emit(entry, 'queued', { jobId, promptId: submitted.promptId, status: 'queued' });
      log(`作业 ${jobId} 已提交（prompt_id=${submitted.promptId}）`);
      return reply.code(201).send({ jobId, promptId: submitted.promptId, status: 'queued', createdAt: entry.job.createdAt });
    } catch (err) {
      entry.job.status = 'failed';
      entry.job.error = { code: 'COMFY_SUBMIT_FAILED', message: err instanceof Error ? err.message : String(err) };
      entry.job.finishedAt = new Date().toISOString();
      persist(entry.job);
      return reply.code(502).send({ error: entry.job.error, jobId });
    }
  });

  routes.get('/jobs', async (request) => {
    const limit = Math.min(Math.max(Number(request.query?.limit ?? settings.historyLimit) || 10, 1), 200);
    const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
    const jobs = rows.map(rowToJob).map((job) => {
      const entry = live.get(job.jobId);
      return entry ? snapshot(entry.job) : job;
    });
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n ?? jobs.length);
    return { items: jobs, total };
  });

  routes.get('/jobs/:id', async (request, reply) => {
    const entry = live.get(request.params.id);
    if (entry) return snapshot(entry.job);
    const rows = db.prepare('SELECT * FROM jobs WHERE id = ?').all(request.params.id);
    if (rows.length === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个任务' } });
    return rowToJob(rows[0]);
  });

  routes.get('/jobs/:id/events', (request, reply) => {
    const jobId = request.params.id;
    const entry = live.get(jobId);
    const rows = entry ? null : db.prepare('SELECT * FROM jobs WHERE id = ?').all(jobId);
    if (!entry && (!rows || rows.length === 0)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个任务' } });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (type, data) => {
      raw.write(`event: ${type}\n`);
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const job = entry ? entry.job : rowToJob(rows[0]);
    send('snapshot', snapshot(job));
    if (!entry || TERMINAL.has(job.status)) {
      raw.end();
      return;
    }

    const onEvent = (type, data) => {
      send(type, data);
      if (type === 'completed' || type === 'error' || type === 'canceled') raw.end();
    };
    entry.listeners.add(onEvent);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(ping);
      entry.listeners.delete(onEvent);
    });
  });

  routes.post('/jobs/:id/cancel', async (request, reply) => {
    const entry = live.get(request.params.id);
    if (!entry) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个任务' } });
    if (TERMINAL.has(entry.job.status)) return { ok: true, status: entry.job.status };

    try {
      if (entry.job.status === 'queued' && entry.job.promptId) {
        // 还没开跑：从 ComfyUI 队列里删掉
        await comfy.deleteQueued(entry.job.promptId).catch(() => comfy.interrupt());
      } else {
        await comfy.interrupt();
      }
    } catch (err) {
      return reply.code(502).send({ error: { code: 'CANCEL_FAILED', message: String(err) } });
    }
    // 真正的状态翻转交给 execution_interrupted；这里兜底
    setTimeout(() => {
      if (!TERMINAL.has(entry.job.status)) {
        entry.job.status = 'canceled';
        entry.job.finishedAt = new Date().toISOString();
        persist(entry.job);
        emit(entry, 'canceled', { jobId: entry.job.jobId });
      }
    }, 1500);
    return { ok: true };
  });

  routes.delete('/jobs', async () => {
    // 只清记录，不动空间里的图片（那是用户资产）。
    // 真外键 + ON DELETE CASCADE：删 jobs 一张表就够，assets 自己跟着走。
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n ?? 0);
    db.exec('DELETE FROM jobs');
    live.clear();
    byPromptId.clear();
    return { cleared: n };
  });

  routes.get('/assets/:jobId/:idx', async (request, reply) => {
    const row = db
      .prepare('SELECT file, mime FROM assets WHERE job_id = ? AND idx = ?')
      .get(request.params.jobId, Number(request.params.idx));
    if (row === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这张图' } });
    // 库里是相对路径 → 交给空间句柄解析（顺带挡掉越界值）
    const file = space.resolve(String(row.file));
    if (!fs.existsSync(file)) return reply.code(410).send({ error: { code: 'GONE', message: '文件已不在磁盘上' } });
    reply.header('Content-Type', String(row.mime));
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    if (request.query?.download === '1') {
      reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
    }
    return reply.send(fs.createReadStream(file));
  });

  // ---- 3.8 生命周期：一切注册挂 ctx，卸载时 cordis 自动撤销 ----
  comfy.start();
  log(`已就绪，ComfyUI = ${comfy.baseUrl}`);

  ctx.effect(() => () => {
    unsubscribeComfy();
    comfy.stop();
    for (const entry of live.values()) entry.listeners.clear();
    live.clear();
    db.close();
    log('已卸载');
  });
}

// ===========================================================================
// 安全护栏：任何要发去 ComfyUI 的值都先过这里
// ===========================================================================

/**
 * 上下限。全插件**只有这一份** —— 请求校验、设置默认值收敛、提交前的最终检查都用它。
 *
 * 为什么参考实现也要有护栏：它是"照抄一份就能用"的样板，抄走的不该是一个能把
 * 200 步 / 4096×4096 直接打到 GPU 上的裸奔版本。ComfyUI 不替你拦，显存打满就是整个队列卡死。
 * 上下限由**每个插件自己**定（核不管业务）：边长与 anima-plus 一样是 1216，
 * 步数这边给到 32，而 anima-plus 只给 24 —— 那边是多 LoRA 叠加、Turbo 6 步就能出图，
 * 步数窗口本该更窄；这边直接跑原生工作流，留宽一点。
 */
export const SAFETY = {
  minSteps: 1,
  maxSteps: 32,
  minSide: 64,
  maxSide: 1216,
};

/**
 * 最后一道闸：不看请求，只看**真正要发出去的图**。
 *
 * 请求校验管得住"用户传了什么"，管不住"设置里配的默认值"、"工作流模板自带的数值"，
 * 也管不住以后有人改 `buildGraph` 时接错了线。图是唯一的事实，所以提交前照图再查一遍。
 *
 * 返回问题清单（空数组 = 通过）；调用方负责把它变成 400，而不是把越界值打到 GPU 上。
 */
export function assertGraphSafe(graph, bindings, safety = SAFETY) {
  const problems = [];
  const sampler = graph?.[bindings.samplerId]?.inputs ?? {};
  const latent = graph?.[bindings.latentId]?.inputs ?? {};

  const steps = Number(sampler.steps);
  if (!Number.isInteger(steps) || steps < safety.minSteps || steps > safety.maxSteps) {
    problems.push(`步数 ${sampler.steps} 必须是 ${safety.minSteps}~${safety.maxSteps} 的整数`);
  }
  for (const [key, label] of [
    ['width', '宽度'],
    ['height', '高度'],
  ]) {
    const value = Number(latent[key]);
    if (!Number.isInteger(value) || value < safety.minSide || value > safety.maxSide) {
      problems.push(`${label} ${latent[key]} 必须是 ${safety.minSide}~${safety.maxSide} 的整数`);
    }
  }
  return problems;
}

// ===========================================================================
// 小工具
// ===========================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 描述提示词与正向提示词的手工拼接（前端预览要用同一套规则，见 client/src/App.vue
 * 的 joinedPrompt）。首尾的空格与逗号会被清掉 —— 工作流自带的正向文本末尾就带一个逗号，
 * 直接连会出现 ", ,"；两侧都空则结果是空串。
 */
function joinPrompt(description, positive) {
  const parts = [description, positive]
    .map((text) => String(text ?? '').trim().replace(/^[,\s]+/, '').replace(/[,\s]+$/, ''))
    .filter((text) => text !== '');
  return parts.join(', ');
}

/** 53 位随机种子：超过 MAX_SAFE_INTEGER 会在 JSON 往返中失真 */
function randomSeed() {
  return Math.floor(Math.random() * 2 ** 53);
}

function extFor(contentType, filename) {
  const byType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const fromType = byType[String(contentType).split(';')[0].trim().toLowerCase()];
  if (fromType) return fromType;
  const ext = path.extname(String(filename)).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.png';
}
