import type { Context } from 'cordis';
import type { Logger } from 'pino';

import { findEntry } from './loader-entries.js';
import { mountEntry, unmountEntry } from './tabs-loader.js';
import { scanTabs, type ScannedTab } from './tabs-scan.js';
import { message } from './util.js';

export interface RescanResult {
  added: string[];
  removed: string[];
  /** 代码变了、被就地重挂的 tab */
  reloaded: string[];
  failed: Array<{ id: string; reason: string }>;
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
    /**
     * "这个 tab 现在是不是被停用的"（读的是 `data/host.json` 的 `disabled` 列表）。
     *
     * 交给回调而不是直接拿 settings 文件：启停状态**由 core 端点写、由这里读**，
     * 中间隔着文件；注入判据比让 tabs 自己再解析一遍 JSON 更容易看清谁在改状态（D21）。
     */
    private readonly isDisabled: (id: string) => boolean = () => false,
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
      if (current !== undefined) this.remove(tab.id);
      try {
        // 代码变了才带 cache-buster：初次挂载用干净路径，`/api/plugins` 里的说明符更好读。
        // `disabled` 一律传 false：启停由 `create()` 读盘决定（D21），重扫不该自己猜。
        await this.create(tab.id, tab.entry, false, tab.fingerprint, reload);
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

    // 启停**只由盘上的 `disabled` 决定**（D21）：这里绝不能把"这一行当前是停用的"传下去 ——
    // 那样刚被启用的插件重挂一次又会停用（`create()` 拿到的是过期状态，实测踩过）。
    this.remove(id);
    try {
      await this.create(id, tab.entry, false, tab.fingerprint, true);
    } catch {
      // 原因已经由调用方（core 的重挂端点）在响应里说明
      return false;
    }
    await this.ctx.loader.await();
    return true;
  }

  private async create(
    id: string,
    entry: string,
    disabled: boolean,
    fingerprint: string,
    bustCache = false,
    problem?: string,
  ): Promise<void> {
    // 启停的真源是**盘上的 `disabled`**（D21）；参数 `disabled` 只留给"与盘无关的强制停用"
    const off = disabled || this.isDisabled(id);
    await mountEntry(this.ctx, {
      id,
      entry,
      disabled: off,
      ...(bustCache ? { token: this.nextToken() } : {}),
    });
    this.mounted.set(id, {
      state: off ? 'bad' : 'ok',
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
    unmountEntry(this.ctx, id, this.logger);
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

  /**
   * 已装载的 tab + 它们**当前**的启用状态（`GET /api/plugins` 用它报 `enabled`）。
   *
   * 启用状态有**两个可能的主人**：宿主（`data/host.json` 的 `disabled`，落盘）与 Loader 行
   * （`entry.disabled`，运行期）。清单必须报**实际**那个，否则设置页的开关会和真实情况相反 ——
   * 比如刚启用的插件在 `loader.await()` 落地前后会短暂不一致。
   */
  rows(): Array<{ tab: ScannedTab; enabled: boolean }> {
    return this.scan().map((tab) => ({ tab, enabled: !this.isDisabledByEntry(tab.id) }));
  }

  /** 这一行**现在**是启用还是停用（清单与启停端点共用这一个判据） */
  enabledOf(id: string): boolean {
    return !this.isDisabledByEntry(id);
  }

  /**
   * 这一行**现在**是不是停用的：**先信 Loader 行**（它就是当前事实），
   * 行还没落地时才回落到盘上的 `disabled`。
   *
   * 只看 Loader 行会有个刺眼的窗口：刚启用的插件在 `loader.await()` 落地之前仍报 `disabled`，
   * 界面看起来像"点了没反应"（实测踩过）。只看盘上的值则相反：报的和跑的不是一回事。
   */
  private isDisabledByEntry(id: string): boolean {
    const entry = findEntry(this.ctx, id);
    return entry === undefined ? this.isDisabled(id) : entry.disabled;
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
