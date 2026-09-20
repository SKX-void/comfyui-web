import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 是否运行在打包产物里（esbuild 注入，见 src/globals.d.ts） */
const BUNDLED = typeof __BUNDLED__ !== 'undefined' && __BUNDLED__;

/**
 * 仓库标记：从当前文件往上找它，找到的目录就是"根"。
 * 源码态是 `apps/server/src`，打包态是 `dist/`，两者到根的距离不同，
 * 硬编码 `../../..` 在打包后必然算错（会指到仓库的上一级）。
 */
const ROOT_MARKER = 'pnpm-workspace.yaml';

/**
 * 仓库根目录 —— `templatesDir` / `dataDir` / `config.json` 的解析基准。
 *
 * 解析顺序：
 *   1. `REPO_ROOT` 环境变量（显式指定，最高优先）
 *   2. 从当前文件往上找 `pnpm-workspace.yaml`：
 *      - 源码态 `<root>/apps/server/src` → `<root>`
 *      - 打包态 `<root>/dist` → `<root>`（所以本地跑产物和跑源码看到的是同一份配置）
 *   3. 找不到（说明 dist/ 被搬去别处单独部署了）→ **把产物所在目录当根**，
 *      即 `<某个目录>/server.mjs` + `<某个目录>/config.json` + `<某个目录>/templates/`
 */
export const repoRoot = (() => {
  const explicit = process.env.REPO_ROOT;
  if (explicit) return path.resolve(explicit);

  for (let dir = here; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ROOT_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到文件系统根了
  }
  return BUNDLED ? here : path.resolve(here, '..', '..', '..');
})();

/**
 * 构建产物目录（`server.mjs` 与前端 `web/` 的所在处）。
 *
 * - 打包态：就是当前文件所在目录 → 前端固定为 `<server.mjs 所在目录>/web`
 * - 源码态：`<仓库根>/dist`（同一份布局，只是产物还没生成）
 */
export const distDir = BUNDLED ? here : path.join(repoRoot, 'dist');

/**
 * 模板目录的默认值。
 *
 * 打包产物里模板是**跟着产物走**的（`dist/templates`，见 scripts/build.mjs）：
 * `template.json` 的 bindings 指向写死的节点/字段、`requirements.nodes` 指向具体节点类，
 * 模板与 server 必须同版本。所以打包态优先用产物自带的那份 —— 与 `web/` 同一套规则，
 * 整包搬走也成立，不依赖 REPO_ROOT。
 *
 * 源码态（tsx 跑 src/index.ts）永远用仓库根的 `templates/`，这样改完模板
 * `POST /api/templates/reload` 立刻生效。
 */
const defaultTemplatesDir = (() => {
  if (BUNDLED) {
    const baked = path.join(distDir, 'templates');
    if (fs.existsSync(baked)) return baked;
  }
  return path.join(repoRoot, 'templates');
})();

/** 内置默认值（config.json 缺失时使用） */
const BUILTIN_DEFAULTS = {
  host: '127.0.0.1',
  port: 8080,
  comfyui: {
    baseUrl: '10.2.3.22:8188',
    mode: 'real' as 'real' | 'mock',
  },
  templatesDir: 'templates',
  dataDir: 'data',
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
  /** 持久化数据目录（SQLite 等），相对"根"或绝对路径 */
  dataDir: string;
  /** SQLite 文件绝对路径 */
  dbFile: string;
  /**
   * 可重建的缓存目录（目前是 LoRA 预览图缩略图）。
   *
   * 默认 `<dataDir>/cache` —— 缓存必须落在可写的地方：容器里应用目录是只读挂载
   * （`./dist:/app:ro`），缓存写到应用目录里会直接 EROFS。跟着 dataDir 走就不会漏配。
   */
  cacheDir: string;
  /**
   * 前端静态产物目录（托管用）。
   * 默认 `<distDir>/web` —— 也就是固定为"server.mjs 旁边的 web 文件夹"，
   * 整个 dist/ 可以整体搬走；要指到别处时用 config.json 的 webDir 或 WEB_DIR。
   */
  webDir: string;
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
  if (env('CACHE_DIR')) envOverrides.cacheDir = env('CACHE_DIR');
  if (env('WEB_DIR')) envOverrides.webDir = env('WEB_DIR');
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

  const templatesDirRaw = merged.templatesDir === undefined ? undefined : String(merged.templatesDir);
  const templatesDir = templatesDirRaw
    ? path.isAbsolute(templatesDirRaw)
      ? templatesDirRaw
      : path.join(repoRoot, templatesDirRaw)
    : defaultTemplatesDir;

  const dataDirRaw = String(merged.dataDir ?? 'data');
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(repoRoot, dataDirRaw);

  /**
   * 缓存目录默认落在数据目录下面（`<dataDir>/cache`），而不是另起一个 `.cache`。
   *
   * 这样只需要配一个 `dataDir`：容器里把它指到可写卷，缓存自然跟着走，
   * 不会出现"数据能写、缓存写到只读的应用目录里"这种半截子状态。
   */
  const cacheDirRaw =
    merged.cacheDir === undefined ? undefined : String(merged.cacheDir);
  const cacheDir = cacheDirRaw
    ? path.isAbsolute(cacheDirRaw)
      ? cacheDirRaw
      : path.join(repoRoot, cacheDirRaw)
    : path.join(dataDir, 'cache');

  const webDirRaw = merged.webDir === undefined ? undefined : String(merged.webDir);
  const webDir = webDirRaw
    ? path.isAbsolute(webDirRaw)
      ? webDirRaw
      : path.join(repoRoot, webDirRaw)
    : path.join(distDir, 'web');

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
    cacheDir,
    webDir,
    logLevel: String(merged.logLevel ?? 'info'),
    mockStepDelayMs,
    configFiles: loadedFiles,
  };
}
