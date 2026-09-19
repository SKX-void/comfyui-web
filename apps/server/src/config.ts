import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（apps/server/src -> ../../..） */
export const repoRoot = path.resolve(here, '..', '..', '..');

/** 内置默认值（config.json 缺失时使用） */
const BUILTIN_DEFAULTS = {
  host: '127.0.0.1',
  port: 8080,
  comfyui: {
    baseUrl: '10.2.3.22:8188',
    mode: 'real' as 'real' | 'mock',
  },
  templatesDir: 'templates',
  dataDir: '.data',
  logLevel: 'info',
  mockStepDelayMs: 120,
};

export interface ServerConfig {
  host: string;
  port: number;
  /** 已归一化的 ComfyUI 基址（必含协议，无尾斜杠） */
  comfyBaseUrl: string;
  comfyMode: 'real' | 'mock';
  templatesDir: string;
  /** 持久化数据目录（SQLite 等），相对仓库根或绝对路径 */
  dataDir: string;
  /** SQLite 文件绝对路径 */
  dbFile: string;
  logLevel: string;
  mockStepDelayMs: number;
  /** 本次实际加载的配置文件（按优先级从低到高），用于日志与健康检查 */
  configFiles: string[];
}

type JsonObject = Record<string, unknown>;

/**
 * 去注释 + 解析。
 * 支持 `//` 行注释与 `/* *​/` 块注释——与 WeiLin 配置文件的约定一致。
 * 注意：会跳过字符串字面量内的 `//`（例如 URL 里的 `http://`）。
 */
export function parseJsonc(text: string): JsonObject {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        // 转义序列整体保留
        if (next !== undefined) {
          out += next;
          i += 1;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }

  return JSON.parse(out) as JsonObject;
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 浅层合并：只递归一层顶层对象（够用且行为可预测） */
function merge(base: JsonObject, override: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? { ...prev, ...v } : v;
  }
  return out;
}

function readConfigFile(file: string): { data: JsonObject; loaded: boolean } {
  if (!fs.existsSync(file)) return { data: {}, loaded: false };
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return { data: parseJsonc(raw), loaded: true };
  } catch (err) {
    throw new Error(`配置文件解析失败: ${file}\n  ${(err as Error).message}`);
  }
}

/**
 * 归一化 ComfyUI 地址：
 * - 缺协议时补 `http://`（允许写 "10.2.3.22:8188"）
 * - 去掉尾部斜杠
 * - 缺端口时**报错**（ComfyUI 默认 8188，漏写端口几乎总是笔误）
 *
 * 注意：不能用 `url.port` 判断是否写了端口——
 * `http://a:80` 会被 URL 规范化成 `http://a`（80 是默认端口），
 * 因此改为直接检查输入原文的 authority 部分。
 */
export function normalizeBaseUrl(input: string): string {
  const s = input.trim();
  if (s === '') throw new Error('comfyui.baseUrl 不能为空');

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;

  const authority = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '';
  if (authority === '') {
    throw new Error(`comfyui.baseUrl 缺少主机名: "${input}"（示例：10.2.3.22:8188）`);
  }
  if (!/:\d+$/.test(authority)) {
    throw new Error(
      `comfyui.baseUrl 缺少端口: "${input}"（示例：10.2.3.22:8188；如确实用 80 端口请显式写 :80）`,
    );
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(
      `comfyui.baseUrl 格式非法: "${input}"（示例：10.2.3.22:8188 或 http://10.2.3.22:8188）`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/**
 * 加载配置。
 *
 * 优先级（从低到高）：
 *   内置默认值 → config.json → config.local.json → 环境变量
 *
 * 配置文件路径可用 `CONFIG_FILE` 覆盖（相对仓库根或绝对路径）；
 * 指定 `CONFIG_FILE` 时仍会尝试同目录的 `config.local.json`。
 */
export function loadConfig(): ServerConfig {
  const explicit = env('CONFIG_FILE');
  const baseFile = explicit
    ? path.resolve(repoRoot, explicit)
    : path.join(repoRoot, 'config.json');
  const localFile = path.join(path.dirname(baseFile), 'config.local.json');

  const loadedFiles: string[] = [];
  let merged: JsonObject = { ...BUILTIN_DEFAULTS };

  const base = readConfigFile(baseFile);
  if (base.loaded) {
    merged = merge(merged, base.data);
    loadedFiles.push(baseFile);
  }
  const local = readConfigFile(localFile);
  if (local.loaded) {
    merged = merge(merged, local.data);
    loadedFiles.push(localFile);
  }

  // ---- 环境变量覆盖 ----
  const envOverrides: JsonObject = {};
  if (env('HOST')) envOverrides.host = env('HOST');
  if (env('PORT')) envOverrides.port = Number(env('PORT'));
  const comfyEnv: JsonObject = {};
  if (env('COMFY_BASE_URL')) comfyEnv.baseUrl = env('COMFY_BASE_URL');
  if (env('COMFY_MODE')) comfyEnv.mode = env('COMFY_MODE');
  if (Object.keys(comfyEnv).length > 0) envOverrides.comfyui = comfyEnv;
  if (env('TEMPLATES_DIR')) envOverrides.templatesDir = env('TEMPLATES_DIR');
  if (env('DATA_DIR')) envOverrides.dataDir = env('DATA_DIR');
  if (env('LOG_LEVEL')) envOverrides.logLevel = env('LOG_LEVEL');
  if (env('MOCK_STEP_DELAY_MS')) {
    envOverrides.mockStepDelayMs = Number(env('MOCK_STEP_DELAY_MS'));
  }
  if (Object.keys(envOverrides).length > 0) {
    merged = merge(merged, envOverrides);
  }

  // ---- 取值与校验 ----
  const comfyui = isPlainObject(merged.comfyui) ? merged.comfyui : {};
  const mode = String(comfyui.mode ?? 'real');
  if (mode !== 'real' && mode !== 'mock') {
    throw new Error(`comfyui.mode 必须是 real 或 mock，收到: ${mode}`);
  }

  const port = Number(merged.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`port 必须是 1-65535 的整数，收到: ${String(merged.port)}`);
  }

  const templatesDirRaw = String(merged.templatesDir ?? 'templates');
  const templatesDir = path.isAbsolute(templatesDirRaw)
    ? templatesDirRaw
    : path.join(repoRoot, templatesDirRaw);

  const dataDirRaw = String(merged.dataDir ?? '.data');
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(repoRoot, dataDirRaw);

  const mockStepDelayMs = Number(merged.mockStepDelayMs ?? 120);
  if (!Number.isFinite(mockStepDelayMs) || mockStepDelayMs < 0) {
    throw new Error(`mockStepDelayMs 必须是非负数字，收到: ${String(merged.mockStepDelayMs)}`);
  }

  return {
    host: String(merged.host ?? '127.0.0.1'),
    port,
    comfyBaseUrl: normalizeBaseUrl(String(comfyui.baseUrl ?? BUILTIN_DEFAULTS.comfyui.baseUrl)),
    comfyMode: mode,
    templatesDir,
    dataDir,
    dbFile: path.join(dataDir, 'comfyui-server.db'),
    logLevel: String(merged.logLevel ?? 'info'),
    mockStepDelayMs,
    configFiles: loadedFiles,
  };
}
