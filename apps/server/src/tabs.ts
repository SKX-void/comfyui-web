import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'cordis';
import type { Logger } from 'pino';

import {
  resolvePluginPackage,
  SUPPORTED_CONTRACT,
  type ResolvedPluginPackage,
} from './plugin-package.js';

/**
 * `/tabs` —— **目录型工作流插件**（决策 D14，已落地）。
 *
 * 每个子目录就是一个插件，**目录名即 id**：
 *
 * ```
 * tabs/<id>/package.json   { "name": "@comfyui-web/tab-<id>", "main": "server.js",
 *                            "plugin": { "contract": 1, "title": "…", "client": "client.js" } }
 * tabs/<id>/server.js      cordis 插件（export name / inject / apply）
 * tabs/<id>/client.js      ESM 前端入口（export default { tabs, routes }）；vue 走页面 import map
 * ```
 *
 * 它是宿主**唯一**的插件来源（D16/D19）：契约检查、失败隔离、`GET /api/plugins`、
 * 设置页说明、前端 tab 装载全部走这一条路，不新增第二套生命周期。
 *
 * ## 什么时候扫（D20）
 *
 * **只在两个时刻**：宿主启动时装配一次，以及 `POST /api/tabs/rescan`（设置页/欢迎页的
 * 「重新扫描插件目录」按钮）。宿主不监听目录、不轮询：改完 `tabs/` 是人知道自己改了什么，
 * 由人决定什么时候生效 —— 顺带把"容器挂载 / 网络盘上 fs.watch 静默失聪"这类坑一起消掉。
 *
 * ## 为什么要求"自包含"
 *
 * 插件产物本来就自带依赖（esbuild 把 deps inline 进 `server.js`），所以 tabs 目录下
 * **没有** node_modules：插件只 import node 内置模块 + 宿主给的句柄。要第三方库就先 bundle。
 * 只有这样，"丢一个目录进去就是一个 tab"才成立（也免掉 N 份 node_modules 与不可复现的安装）。
 *
 * ## 状态归插件自己
 *
 * `/tabs` 只回答"有哪几个 tab"，**不持有它们的配置**：插件用 `ctx.space` 在自己的
 * `data/plugins/<包名>/` 里自持数据库 / 配置文件（决策 D15）。宿主只提供
 * `POST /api/tabs/:id/reload` 让它把新设置生效，免得出现"改完没落盘、重启就丢"的假象。
 */

/** 目录名即 id：它同时决定路由前缀（/api/p/<id>）与前端资源前缀（/plugins/<id>/） */
const TAB_ID_RE = /^[a-z][a-z0-9_-]*$/;

export interface ScannedTab {
  id: string;
  dir: string;
  /** 服务端入口绝对路径；`problem` 存在时它可能并不存在 */
  entry: string;
  pkg?: ResolvedPluginPackage;
  /** 不能加载的原因：这一行仍会以 disabled 挂上，好让设置页把原因显示出来 */
  problem?: string;
  /**
   * 目录内容指纹（相对路径 + 大小 + mtime）。变了就说明**代码变了**，
   * 需要卸载后用带 cache-buster 的新说明符重挂（Node 的 ESM 缓存按 URL 记）。
   */
  fingerprint: string;
}

/**
 * 扫 `<tabsDir>` 下的子目录。
 *
 * 坏目录不抛异常、也不消失，而是带着 `problem` 回来：它仍会以 disabled 挂上，
 * 清单页把原因显示出来，运维看得见才有得修。
 */
export function scanTabs(tabsDir: string, logger?: Logger): ScannedTab[] {
  if (!fs.existsSync(tabsDir)) return [];

  const tabs: ScannedTab[] = [];
  const broken: Array<{ id: string; problem: string }> = [];

  for (const dirent of fs.readdirSync(tabsDir, { withFileTypes: true })) {
    // `.` / `_` 前缀留给草稿与备注；只认目录
    if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name.startsWith('_')) continue;

    const id = dirent.name;
    const dir = path.join(tabsDir, id);
    const fallbackEntry = path.join(dir, 'server.js');
    const fingerprint = fingerprintDir(dir);
    const bad = (problem: string, entry = fallbackEntry): void => {
      tabs.push({ id, dir, entry, problem, fingerprint });
      broken.push({ id, problem });
    };

    if (!TAB_ID_RE.test(id)) {
      bad(`目录名非法：必须小写字母开头、只含 [a-z0-9_-]`);
      continue;
    }

    const pkgJson = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      bad('缺少 package.json（manifest 与入口都写在里面）');
      continue;
    }

    let main = 'server.js';
    try {
      const raw = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { main?: unknown };
      if (typeof raw.main === 'string' && raw.main !== '') main = raw.main;
    } catch (err) {
      bad(`package.json 解析失败：${message(err)}`);
      continue;
    }

    const entry = path.resolve(dir, main);
    if (!fs.existsSync(entry)) {
      bad(`入口不存在：${main}`, entry);
      continue;
    }

    // 解析基准是这一格 tab 目录本身（入口是绝对路径，baseDir 只兜相对路径/裸包名）
    const pkg = resolvePluginPackage(entry, dir);
    if (pkg === undefined) {
      bad('解析不到 manifest（package.json 缺 plugin 段？）', entry);
      continue;
    }

    const contract = pkg.manifest.contract;
    if (contract !== undefined && contract !== SUPPORTED_CONTRACT) {
      bad(`契约版本不符：声明 contract=${String(contract)}，宿主支持 ${SUPPORTED_CONTRACT}`, entry);
      continue;
    }

    tabs.push({ id, dir, entry, pkg, fingerprint });
  }

  tabs.sort((a, b) => a.id.localeCompare(b.id));
  if (logger !== undefined && broken.length > 0) {
    logger.warn({ broken }, '有 tab 目录没通过检查（仍会以禁用状态出现在清单里）');
  }
  return tabs;
}

export interface RescanResult {
  added: string[];
  removed: string[];
  /** 代码变了、被就地重挂的 tab */
  reloaded: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * 目录内容指纹：任一文件的相对路径 / 大小 / mtime 变了它就变。
 *
 * 用它而不是"看文件事件报的名字"，是为了对**编辑器写盘方式**不敏感
 * （直接写 vs 临时文件 + rename 都只是 mtime 变化），也顺手挡掉"事件到了但内容没变"的空重扫。
 * 排除 `.` 前缀与 `node_modules`：前者是草稿，后者按约定不该存在。
 */
function fingerprintDir(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        const stat = fs.statSync(abs);
        parts.push(`${path.relative(dir, abs)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      } catch {
        // 扫描途中文件消失：忽略，下一次重扫会看到
      }
    }
  };
  walk(dir);
  return parts.join('|');
}

/**
 * 目录型 tab 的注册表：扫描 → Loader 增删 / 就地重挂。
 *
 * 装的时机（D20）：**不再自动扫描**。启动装一次，之后靠手动 ——
 * `POST /api/tabs/rescan` 重新比对目录指纹，新的挂上、变的带 `?v=<token>` 重挂、没了的卸掉。
 * 宿主不监听文件系统：目录里什么时候有新东西，是**知道的人（你）**的事。
 *
 * 重挂 = 新 fiber，所以插件必须在 `ctx.effect(() => () => 收尾)` 里关掉自己开的东西
 * （文件、定时器、在跑的任务）；内存状态会随重挂丢失 —— 要活下来的写进 `ctx.space`。
 */
export class TabsService {
  /**
   * 已挂上的 tab：`ok` = 正常挂载，`bad` = 因 problem 以 disabled 挂着；值里带挂载时的目录指纹。
   * `problem` 也留在这儿 —— 它是"原因没变就别重挂坏目录"的比对依据。
   */
  private readonly mounted = new Map<
    string,
    { state: 'ok' | 'bad'; fingerprint: string; problem?: string }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  /** 只在第一次扫描时把"有坏目录"打到日志（之后每次重扫都会自己报，不能每次都刷） */
  private firstScan = true;
  /** 重挂计数：和 Date.now() 一起构成 cache-buster，保证同一毫秒内的多次重挂也不撞 */
  private reloads = 0;
  /** 重扫的触发者（启动装配 vs 手动端点），只用于日志文案 */
  private via: 'boot' | 'api' = 'boot';

  constructor(
    private readonly ctx: Context,
    private readonly tabsDir: string,
    private readonly logger: Logger,
  ) {}

  /** 这个 id 是不是目录型 tab（core 据此决定启停/重挂走哪条路） */
  owns(id: string): boolean {
    return this.mounted.has(id);
  }

  get dir(): string {
    return this.tabsDir;
  }

  list(): ScannedTab[] {
    const tabs = scanTabs(this.tabsDir, this.firstScan ? this.logger : undefined);
    this.firstScan = false;
    return tabs;
  }

  /** 按 id 取当前扫描结果（core 用它拿入口路径与包元数据） */
  get(id: string): ScannedTab | undefined {
    return this.list().find((tab) => tab.id === id);
  }

  /**
   * 重扫并让 Loader 跟上（**加载/重挂的唯一入口**，D20）；并发调用排队（两次重扫叠在一起没有意义）。
   *
   * 调用点只有两个：启动时装配一次、`POST /api/tabs/rescan`。宿主不再监听目录。
   */
  async rescan(): Promise<RescanResult> {
    const run = this.queue.then(() => this.rescanNow());
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async rescanNow(): Promise<RescanResult> {
    const result: RescanResult = { added: [], removed: [], reloaded: [], failed: [] };
    const scanned = this.list();
    // "新挂"与"重挂"在这一层一次算清：下面按每个 tab 的真实状态决定做什么
    const newlySeen = new Set(this.pending());
    const changedSeen = new Set(this.changed());

    // 目录没了 → 卸载（也包括改名：旧 id 卸载、新 id 挂载）
    const seen = new Set(scanned.map((tab) => tab.id));
    for (const id of [...this.mounted.keys()]) {
      if (seen.has(id)) continue;
      this.remove(id);
      result.removed.push(id);
    }

    for (const tab of scanned) {
      const current = this.mounted.get(tab.id);

      if (tab.problem !== undefined) {
        // 原因没变就不动它（避免每次重扫都卸载重挂）
        if (current?.state === 'bad' && current.problem === tab.problem) {
          this.mounted.set(tab.id, { state: 'bad', fingerprint: tab.fingerprint, problem: tab.problem });
          continue;
        }
        if (current !== undefined) this.remove(tab.id);
        await this.create(tab.id, tab.entry, true, tab.fingerprint, false, tab.problem);
        result.failed.push({ id: tab.id, reason: tab.problem });
        continue;
      }

      // 已在跑、且代码没变：不动
      if (current?.state === 'ok' && current.fingerprint === tab.fingerprint) continue;
      if (current === undefined && !newlySeen.has(tab.id)) continue;
      if (current !== undefined && !changedSeen.has(tab.id) && current.state === 'ok') continue;

      const reload = current?.state === 'ok';
      const wasDisabled = reload ? (this.findEntry(tab.id)?.disabled ?? false) : false;
      if (current !== undefined) this.remove(tab.id);
      try {
        // 代码变了才带 cache-buster：初次挂载用干净路径，`/api/plugins` 里的说明符更好读
        await this.create(tab.id, tab.entry, wasDisabled, tab.fingerprint, reload);
        if (reload) result.reloaded.push(tab.id);
        else result.added.push(tab.id);
      } catch (err) {
        result.failed.push({ id: tab.id, reason: `挂载失败：${message(err)}` });
      }
    }

    await this.ctx.loader.await();
    this.logger.info({ ...result, via: this.via }, '已重扫 tab 目录');
    this.via = 'api';
    return result;
  }

  /**
   * 强制重挂一个 tab（不管指纹有没有变）。
   *
   * 目录型插件的配置归它自己：插件把设置写进 `ctx.space` 之后，要重新走一遍 `apply()`
   * 才生效。宿主不碰它的配置，只提供这一个动作（决策 D15）。
   */
  async reload(id: string): Promise<boolean> {
    const run = this.queue.then(() => this.reloadNow(id));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reloadNow(id: string): Promise<boolean> {
    const tab = this.list().find((item) => item.id === id);
    if (tab === undefined || tab.problem !== undefined || !this.mounted.has(id)) return false;

    // 运行期停用过的 tab 重挂后仍然是停用的：启停是运行期状态，不该被一次重挂抹掉
    const wasDisabled = this.findEntry(id)?.disabled ?? false;
    this.remove(id);
    try {
      await this.create(id, tab.entry, wasDisabled, tab.fingerprint, true);
    } catch {
      // 原因已经由调用方（core 的重挂端点）在响应里说明
      return false;
    }
    await this.ctx.loader.await();
    return true;
  }

  private findEntry(id: string) {
    for (const entry of this.ctx.loader.entries()) {
      if (shortId(entry.id) === id) return entry;
    }
    return undefined;
  }

  private async create(
    id: string,
    entry: string,
    disabled: boolean,
    fingerprint: string,
    bustCache = false,
    problem?: string,
  ): Promise<void> {
    // id **不带 `:`**：`:` 是 loader 的 group 路径分隔符，带它会让 resolve/remove 找不到这一行。
    //
    // 类型签名把 `id` 排除了（默认由 loader 随机分配），但运行期 `ensureId()` **认调用方给的 id**。
    // 这里必须显式给：**目录名即 id** 是这套东西的全部意义
    // （它同时是路由前缀 `/api/p/<id>` 与前端资源前缀 `/plugins/<id>/`）。
    const options = {
      id,
      name: bustCache ? `${entry}?v=${this.nextToken()}` : entry,
      config: {},
      ...(disabled ? { disabled: true } : {}),
    } as unknown as Parameters<typeof this.ctx.loader.create>[0];
    await this.ctx.loader.create(options);
    this.mounted.set(id, {
      state: disabled ? 'bad' : 'ok',
      fingerprint,
      ...(problem !== undefined ? { problem } : {}),
    });
  }

  /** 重挂用的 cache-buster：不同 URL = 不同模块实例（`plugin-package.ts` 会剥掉它做文件解析） */
  private nextToken(): string {
    this.reloads += 1;
    return `${Date.now().toString(36)}${this.reloads.toString(36)}`;
  }

  private remove(id: string): void {
    try {
      this.ctx.loader.remove(id);
    } catch (err) {
      this.logger.warn({ id, err: message(err) }, '卸载 tab 失败');
    }
    // 路由表也放掉：插件被卸载后旧 handler 的闭包不该再留在内存里
    try {
      this.ctx.routes.release(id);
    } catch {
      // routes 服务还没就绪（启动早期）时忽略
    }
    this.mounted.delete(id);
  }

  /**
   * **已装载**的 tab 清单（`GET /api/plugins` 走这条）。
   *
   * 只报已经在 Loader 里的那些：目录里刚放进来、还没点重扫的插件**不出现在清单里** ——
   * 否则界面会显示一个"看得见但点不开"的 tab（路由与前端都还没挂），那比看不见更骗人。
   */
  scan(): ScannedTab[] {
    return this.list().filter((tab) => this.mounted.has(tab.id));
  }

  /** 目录里有、但还没装载的 id（重扫结果里的 `added`）；坏了且还没挂上的也算 */
  private pending(): string[] {
    return this.list()
      .filter((tab) => !this.mounted.has(tab.id))
      .map((tab) => tab.id);
  }

  /** 已装载、但目录指纹变了的 id（重扫结果里的 `reloaded`）——只跟已装载的比 */
  private changed(): string[] {
    return this.list()
      .filter((tab) => {
        const current = this.mounted.get(tab.id);
        return current !== undefined && current.fingerprint !== tab.fingerprint;
      })
      .map((tab) => tab.id);
  }

  /** 正常退出时没什么要收的：没有监听器、没有定时器（D20 之后宿主只在启动时扫一次） */
  dispose(): void {}
}

/** `include:anima-plus` → `anima-plus`（与 core-plugin 的 shortId 同一约定） */
function shortId(entryId: string): string {
  const index = entryId.indexOf(':');
  return index === -1 ? entryId : entryId.slice(index + 1);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
