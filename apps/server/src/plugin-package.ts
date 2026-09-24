import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 插件包的静态元数据（`package.json` 的 `plugin` 段）。
 *
 * 为什么读包而不读代码：这份元数据要在"插件模块导入失败"时也能拿到，
 * 否则清单页展示不了坏插件。而且它是静态事实，不执行任何插件代码。
 */
export interface PluginSettingField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea';
  label?: string;
  description?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** 密钥类字段：API 返回时脱敏 */
  secret?: boolean;
  /**
   * 本项**留空**时由宿主全局设置兜底：值是宿主全局项的键（目前只有 `comfyuiBaseUrl`）。
   *
   * 例：`fallback: 'comfyuiBaseUrl'` —— 留空 = 跟随设置页里配的统一 ComfyUI 地址，
   * 填了 = 这个插件自定。宿主只做"留空就用全局值"这一件事，不认识 ComfyUI 的语义。
   */
  fallback?: string;
}

export interface PluginPackageManifest {
  /** 契约版本：宿主不认就拒绝加载（docs/architecture.md §4.5） */
  contract?: number;
  title?: string;
  icon?: string;
  order?: number;
  /** 前端产物入口，相对包根；宿主经 /plugins/<id>/<entry> 送出 */
  client?: string;
  settings?: PluginSettingField[];
}

export const SUPPORTED_CONTRACT = 1;

export interface ResolvedPluginPackage {
  /** 解析到的包名（诊断用；相对路径插件为文件路径） */
  resolvedFrom: string;
  /** 包根目录 */
  dir: string;
  /** 包名（package.json 的 name） */
  packageName?: string;
  version?: string;
  manifest: PluginPackageManifest;
}

/** 从任意目录往上找最近的 package.json */
function findPackageJsonUpward(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readManifest(pkgJsonPath: string): ResolvedPluginPackage {
  const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
    name?: string;
    version?: string;
    plugin?: PluginPackageManifest;
  };
  return {
    resolvedFrom: pkgJsonPath,
    dir: path.dirname(pkgJsonPath),
    packageName: raw.name,
    version: raw.version,
    manifest: raw.plugin ?? {},
  };
}

/**
 * 把 plugins.yml / tabs 扫描结果里的模块说明符解析成插件包。
 *
 * - 相对路径（`./x.mjs`）→ 相对 profile 目录解析，再往上找 package.json；
 * - 绝对路径（`/abs/tabs/hello/server.js`）→ 目录型 tab（D14），往入口所在目录找 package.json；
 * - 裸包名（`@comfyui-web/demo`）→ 用 profile 自己的 node_modules 解析。
 *
 * 说明符可以带 query（`/abs/server.js?v=abc`）—— 那是**目录型 tab 热重载**用来绕开
 * Node ESM 模块缓存的（不同 URL = 不同模块实例），文件系统这一侧必须把它剥掉，
 * 否则 `existsSync` 立刻判不存在、清单与前端产物全丢。
 *
 * 裸包名要求插件包导出 `./package.json`（`exports` 里显式声明），
 * 否则回落到"解析主入口再往上找 package.json"。
 */
export function resolvePluginPackage(
  specifier: string,
  profileDir: string,
): ResolvedPluginPackage | undefined {
  const filePart = stripSpecifierSuffix(specifier);
  const isPathLike = filePart.startsWith('.') || path.isAbsolute(filePart);

  if (isPathLike) {
    const abs = path.isAbsolute(filePart) ? filePart : path.resolve(profileDir, filePart);
    if (!fs.existsSync(abs)) return undefined;
    const pkgJson = findPackageJsonUpward(path.dirname(abs));
    return pkgJson ? readManifest(pkgJson) : undefined;
  }

  const require = createRequire(path.join(profileDir, 'package.json'));

  // 首选：直接解析 package.json（需要插件包导出它）
  try {
    return readManifest(require.resolve(`${filePart}/package.json`));
  } catch {
    // 回落：解析主入口再往上找
  }
  try {
    const entry = require.resolve(filePart);
    const pkgJson = findPackageJsonUpward(path.dirname(entry));
    return pkgJson ? readManifest(pkgJson) : undefined;
  } catch {
    return undefined;
  }
}

/** `/abs/server.js?v=abc` → `/abs/server.js`；`./x.mjs#frag` → `./x.mjs` */
function stripSpecifierSuffix(specifier: string): string {
  const index = specifier.search(/[?#]/);
  return index === -1 ? specifier : specifier.slice(0, index);
}
