import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 是否运行在打包产物里（esbuild 注入，见 src/globals.d.ts） */
const BUNDLED = typeof __BUNDLED__ !== 'undefined' && __BUNDLED__;

const ROOT_MARKER = 'pnpm-workspace.yaml';

/**
 * 仓库根目录。规则与 v1 的 config.ts 一致：源码态从 `apps/server/src` 往上找
 * `pnpm-workspace.yaml`，打包态则把产物所在目录当根（`dist/host/` 被整包搬走也成立）。
 */
export const repoRoot = (() => {
  const explicit = process.env.REPO_ROOT;
  if (explicit) return path.resolve(explicit);

  for (let dir = here; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ROOT_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
  }
  return BUNDLED ? here : path.resolve(here, '..', '..', '..');
})();

export interface HostConfig {
  /** 监听地址与端口（v2 独立端口，默认 8087，不碰 v1 的 8086） */
  host: string;
  port: number;
  /** 宿主数据目录：插件文件空间（data/plugins/<包名>/）与其它运行期数据 */
  dataDir: string;
  /** profile 根目录（每个 profile 一个目录，内含 plugins.yml 与 node_modules） */
  profilesDir: string;
  /** 默认启用的 profile 名 */
  profile: string;
  /** 宿主前端产物目录（仅打包/生产态用于静态托管） */
  webDir: string;
  logLevel: string;
}

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8087,
  dataDir: 'data',
  profilesDir: 'profiles',
  profile: 'default',
  logLevel: 'info',
} as const;

/** `host.config.json` 是可选的：不存在时全部走内置默认值 */
function readOptionalConfigFile(): Partial<HostConfig> {
  const candidates = BUNDLED
    ? [path.join(repoRoot, 'host.config.json')]
    : [path.join(repoRoot, 'host.config.json')];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    // 支持 // 与 /* */ 注释：与 v1 的 config.json 保持同一种可读性
    const raw = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    return JSON.parse(raw) as Partial<HostConfig>;
  }
  return {};
}

export function loadHostConfig(): HostConfig {
  const raw = readOptionalConfigFile();
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(repoRoot, p));

  // 环境变量只作**临时覆盖**（换端口起临时实例、跑测试），不是第二份配置来源：
  // 真源永远是 host.config.json。
  const envPort = process.env.COMFYUI_WEB_PORT !== undefined ? Number(process.env.COMFYUI_WEB_PORT) : undefined;
  const dataDir = abs(raw.dataDir ?? DEFAULTS.dataDir);
  const distHost = BUNDLED ? here : path.join(repoRoot, 'dist', 'host');
  const profile = process.env.COMFYUI_WEB_PROFILE ?? raw.profile ?? DEFAULTS.profile;

  return {
    host: raw.host ?? DEFAULTS.host,
    port: envPort !== undefined && Number.isFinite(envPort) ? envPort : (raw.port ?? DEFAULTS.port),
    dataDir,
    profilesDir: abs(raw.profilesDir ?? DEFAULTS.profilesDir),
    profile,
    logLevel: process.env.COMFYUI_WEB_LOG_LEVEL ?? raw.logLevel ?? DEFAULTS.logLevel,
    // 前端位置固定：产物态是 `<host.mjs 所在目录>/web`，源码态是仓库根的 dist/host/web
    webDir: raw.webDir ? abs(raw.webDir) : path.join(distHost, 'web'),
  };
}

/** profile 目录：`<profilesDir>/<name>` */
export function profileDir(config: HostConfig): string {
  return path.join(config.profilesDir, config.profile);
}

/** profile 的清单文件（Include 托管，读写回文件） */
export function profileManifest(config: HostConfig): string {
  return path.join(profileDir(config), 'plugins.yml');
}

/**
 * profile 的清单**模板**（入库的基线）。
 *
 * 清单本身不入库：它是"这批部署的事实"——设置页会把本机 ComfyUI 地址之类写进去，
 * 连"留空 = 跟随统一设置"的项也存解析后的地址（§5.7）。所以入库的是这个剥掉
 * `config`/`disabled` 的模板，宿主启动时清单缺失就从它复制一份。
 */
export function profileManifestTemplate(config: HostConfig): string {
  return path.join(profileDir(config), 'plugins.example.yml');
}
