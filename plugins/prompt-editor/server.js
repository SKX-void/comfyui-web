/**
 * prompt-editor —— 纯编写类 tab（**不负责绘图**）。
 *
 * 前端是主角（区块式工作区 + tag/自然语言两种切分视图 + 纯文本输出）。
 * 服务端只做一件事：把「预设库」和「当前草稿」落在插件自己的空间里 ——
 * 存储形态自管（D12），核不参与、不迁移、不清理。
 *
 * 只 import node 内置模块，**不 import cordis**：宿主已经把 cordis 打进自己的产物，
 * 插件再引一份就是两个实例。
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const name = 'prompt-editor';

export const inject = ['routes', 'space'];

const ID = 'prompt-editor';
/** 空间按**包名**分配，所以这里必须写本插件的包名 */
const PACKAGE = '@comfyui-web/prompt-editor';
const PRESETS_FILE = 'presets.json';
const DRAFT_FILE = 'draft.json';

/** 上限：自用工具也要防「一个坏请求 / 手改坏的文件」把 UI 撑爆 */
const LIMITS = {
  presets: 300,
  name: 120,
  blocks: 200,
  items: 5000,
  itemText: 4000,
  title: 200,
  color: 32,
  translation: 4000,
};

const MODES = new Set(['tag', 'text']);

// ===========================================================================
// 1. 形状收敛：盘上的、请求里的数据都不信任，一律过一遍
// ===========================================================================

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function id(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, 64) : randomUUID();
}

/** 把任意输入收敛成一份 Doc；形状不对（比如整个不是对象）返回 null */
export function sanitizeDoc(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const blocks = Array.isArray(input.blocks) ? input.blocks.slice(0, LIMITS.blocks) : [];
  return {
    version: 1,
    mode: MODES.has(input.mode) ? input.mode : 'tag',
    blocks: blocks
      .filter((block) => block !== null && typeof block === 'object' && !Array.isArray(block))
      .map((block) => ({
        id: id(block.id),
        title: text(block.title, LIMITS.title),
        color: text(block.color, LIMITS.color),
        items: (Array.isArray(block.items) ? block.items.slice(0, LIMITS.items) : [])
          .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
          .map((item) => ({
            id: id(item.id),
            text: text(item.text, LIMITS.itemText),
            // 缺省是「启用」：手写一份预设时不该因为漏字段就整块被吞掉
            enabled: item.enabled !== false,
            translation: text(item.translation, LIMITS.translation),
          })),
      })),
  };
}

function sanitizePreset(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const doc = sanitizeDoc(input.doc);
  if (doc === null) return null;
  return {
    id: id(input.id),
    name: text(input.name, LIMITS.name) || '未命名预设',
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
    doc,
  };
}

// ===========================================================================
// 2. 落盘：整文件 JSON + 原子替换
// ===========================================================================

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 不存在 / 读坏了都退化成默认值：这里没有"必须炸"的理由，坏文件不该让 tab 起不来
    return fallback;
  }
}

/** 先写临时文件再 rename：进程在写一半时被杀，旧文件仍然完整 */
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

// ===========================================================================
// 3. 路由：/api/p/prompt-editor/*（前缀由宿主统一加）
// ===========================================================================

export function apply(ctx) {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const log = (msg) => ctx.logger?.info?.(`[${ID}] ${msg}`);

  const presetsFile = space.resolve(PRESETS_FILE);
  const draftFile = space.resolve(DRAFT_FILE);

  const loadPresets = () => {
    const raw = readJson(presetsFile, null);
    const list = raw !== null && typeof raw === 'object' && Array.isArray(raw.presets) ? raw.presets : [];
    return list.map(sanitizePreset).filter((preset) => preset !== null);
  };
  const savePresets = (list) => writeJson(presetsFile, { version: 1, presets: list });

  const summary = (preset) => ({
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    blockCount: preset.doc.blocks.length,
    itemCount: preset.doc.blocks.reduce((n, block) => n + block.items.length, 0),
  });

  const findPreset = (presetId) => loadPresets().find((preset) => preset.id === presetId) ?? null;

  const badRequest = (reply, message) =>
    reply.code(400).send({ error: { code: 'BAD_REQUEST', message } });
  const notFound = (reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个预设' } });

  // ---- 预设库：像 WeiLin 的主标签管理器，只是存储形态换成插件自己的 JSON ----

  routes.get('/presets', async () => ({ presets: loadPresets().map(summary) }));

  routes.get('/presets/:id', async (request, reply) => {
    const preset = findPreset(request.params.id);
    return preset === null ? notFound(reply) : { preset };
  });

  routes.post('/presets', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '请求体必须是 { name, doc }');
    }
    const doc = sanitizeDoc(body.doc);
    if (doc === null) return badRequest(reply, 'doc 形状不对（应为 { mode, blocks }）');

    const list = loadPresets();
    if (list.length >= LIMITS.presets) {
      return badRequest(reply, `预设数量已达上限 ${LIMITS.presets}，先删掉一些再存`);
    }
    const preset = {
      id: randomUUID(),
      name: text(body.name, LIMITS.name) || '未命名预设',
      updatedAt: Date.now(),
      doc,
    };
    list.push(preset);
    savePresets(list);
    log(`新增预设「${preset.name}」（共 ${list.length} 条）`);
    return reply.code(201).send({ preset });
  });

  /** 改名与覆盖保存共用：只改传进来的字段 */
  routes.put('/presets/:id', async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '请求体必须是 { name?, doc? }');
    }
    const list = loadPresets();
    const index = list.findIndex((preset) => preset.id === request.params.id);
    if (index === -1) return notFound(reply);

    const current = list[index];
    const next = { ...current, updatedAt: Date.now() };
    if (typeof body.name === 'string') next.name = text(body.name, LIMITS.name) || current.name;
    if (body.doc !== undefined) {
      const doc = sanitizeDoc(body.doc);
      if (doc === null) return badRequest(reply, 'doc 形状不对（应为 { mode, blocks }）');
      next.doc = doc;
    }
    list[index] = next;
    savePresets(list);
    return { preset: next };
  });

  routes.delete('/presets/:id', async (request, reply) => {
    const list = loadPresets();
    const next = list.filter((preset) => preset.id !== request.params.id);
    if (next.length === list.length) return notFound(reply);
    savePresets(next);
    return { ok: true, remaining: next.length };
  });

  // ---- 草稿：刷新页面不丢工作；只留一份，不做历史 ----

  routes.get('/draft', async () => {
    const doc = sanitizeDoc(readJson(draftFile, null));
    return { doc };
  });

  routes.put('/draft', async (request, reply) => {
    const body = request.body;
    const doc = sanitizeDoc(body !== null && typeof body === 'object' ? body.doc : null);
    if (doc === null) return badRequest(reply, '请求体必须是 { doc: { mode, blocks } }');
    writeJson(draftFile, doc);
    return { ok: true };
  });

  ctx.effect(() => () => {
    // 本插件没有定时器 / 长连接；留一个显式的收尾点，重挂时语义清楚
  });
}
