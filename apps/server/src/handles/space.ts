import fs from 'node:fs';
import path from 'node:path';

/**
 * 文件空间句柄 —— 核提供给插件的**唯一**句柄。
 *
 * 核只做一件事：按**包名**在 `data/plugins/` 下切一块唯一目录给插件。
 * 目录里放什么（SQLite？JSON？图片？缩略图缓存？）插件自己决定，
 * 核不假设、不解析、**也不清理**。
 *
 * ## 为什么按包名而不是 profile 里的行 id
 *
 * - 空间跟着**代码**走：行 id 是本地别名（同一个包可以在两个 profile 里起不同 id，
 *   也可能被改名），包名是插件的身份证；
 * - 同一个包装两次 = 同一块空间：同一份代码本来就该看到同一份数据。
 *
 * 代价很明确：**改包名＝换空间**，旧数据要手工搬。
 *
 * ## 为什么核不再提供数据库句柄
 *
 * 原来的 `ctx.db` 是"一个库 + 表前缀 + `_plugin_migrations` 账本"。那套东西的硬价值
 * 只有跨插件 JOIN 与跨表事务；既然模型里不存在跨插件库操作，剩下的全是耦合，
 * 还带来一个说不清的边界（前缀是命名空间，不是权限边界）。现在插件想用什么存储就用什么，
 * 连"插件删掉时怎么清数据"都退化成删一个目录。
 *
 * 顺带一提：自己管库之后，插件可以在自己的库里用**真正的外键**
 * （`REFERENCES ... ON DELETE CASCADE`）—— 那是单所有者才有的待遇。
 */
export interface PluginSpace {
  /** 归属的包名，如 `@comfyui-web/anima-example` */
  readonly packageName: string;
  /** 空间根目录（绝对路径，必存在） */
  readonly root: string;
  /** 空间内相对路径 → 绝对路径；越界直接抛 */
  resolve(rel: string): string;
}

/**
 * npm 包名：可选的 `@scope/` + 名字。刻意收窄到 URL 安全字符集，
 * 因为它要直接参与目录名构造。
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * 包名 → 目录名：`@comfyui-web/anima-example` → `@comfyui-web+anima-example`。
 * 只替换作用域那一个斜杠（pnpm 在 `node_modules/.pnpm` 里也是这个写法），
 * 这样目录名里不会再出现路径分隔符。
 */
export function spaceDirName(packageName: string): string {
  const name = packageName.trim();
  if (!PACKAGE_NAME_RE.test(name) || name.includes('..') || name.length > 214) {
    throw new Error(
      `[space] 非法包名 "${packageName}"：只允许 @scope/name 形式与小写 URL 安全字符（用于构造目录名）`,
    );
  }
  return name.replace('/', '+');
}

export class SpaceService {
  private readonly baseDir: string;
  private readonly handles = new Map<string, PluginSpace>();

  constructor(dataDir: string) {
    this.baseDir = path.join(dataDir, 'plugins');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /** 空间根：`<dataDir>/plugins` */
  get base(): string {
    return this.baseDir;
  }

  /** 取某包名的空间（同包名复用同一个实例），目录不存在则建出来 */
  for(packageName: string): PluginSpace {
    let handle = this.handles.get(packageName);
    if (!handle) {
      handle = new PluginSpaceImpl(packageName, path.join(this.baseDir, spaceDirName(packageName)));
      this.handles.set(packageName, handle);
    }
    return handle;
  }

  /** 包名 → 目录绝对路径（不建目录；CLI 与诊断用） */
  dirFor(packageName: string): string {
    return path.join(this.baseDir, spaceDirName(packageName));
  }

  /** 诊断用：已经有哪些空间 */
  list(): string[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs.readdirSync(this.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }
}

class PluginSpaceImpl implements PluginSpace {
  readonly packageName: string;
  readonly root: string;

  constructor(packageName: string, root: string) {
    this.packageName = packageName;
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    // 越界校验：插件只能在自己的空间里活动（挡手滑，不挡恶意——同进程代码挡不住）
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`[space:${this.packageName}] 路径越界：${rel}`);
    }
    return abs;
  }
}
