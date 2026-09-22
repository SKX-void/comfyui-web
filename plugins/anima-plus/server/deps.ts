import type {
  DepsPackView,
  DepsReport,
  DepsTemplateView,
  PackRequirement,
  TemplateRequirements,
} from '@comfyui-web/shared';

import type { ComfyClient } from './comfy/types.js';
import type { TemplateRegistry } from './templates/loader.js';

/**
 * 依赖检查：模板需要的节点类，这台 ComfyUI 到底有没有。
 *
 * 判据只有一个 —— `GET /object_info` 的键集合（= 已注册的节点类）。它比"包装没装"
 * 更准：包装了但 import 失败、缺 Python 依赖时，**包在而节点不在**，查包会给假阳性。
 *
 * "缺的节点出自哪个包"则用**模板里手写的声明**（`requirements.packs[].url`）回答，
 * 不查 ComfyUI-Manager：它的"类 → 包"映射会猜错，而且 WeiLin 这类不在 Manager 上的
 * 包根本查不到。作者本来就知道自己用的是哪个仓库。
 *
 * object_info 约 9MB / 2s，**必须缓存**；提交前的检查也走同一份缓存。
 * 缓存时长可由设置项调（`ttlMs`）：`0` = 不缓存，用于"刚在 ComfyUI 装完包、想立刻重查"。
 */
const CACHE_TTL_MS = 5 * 60_000;

export interface NodeKeys {
  keys: Set<string>;
  at: Date;
  cached: boolean;
}

export class DepsService {
  private cache: { at: number; keys: Set<string> } | null = null;
  private inflight: Promise<Set<string>> | null = null;

  private readonly ttlMs: number;

  constructor(
    private readonly client: ComfyClient,
    private readonly templates: TemplateRegistry,
    private readonly log: (msg: string, meta?: unknown) => void = () => {},
    options: { ttlMs?: number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  }

  /**
   * 上游已注册的节点类。
   *
   * - `refresh: true` 绕过缓存（界面上"重新检查"用）；
   * - 并发调用合流成一次请求（开着三个页面不会拉三份 9MB）。
   */
  async nodeKeys(options: { refresh?: boolean } = {}): Promise<NodeKeys> {
    const now = Date.now();
    if (!options.refresh && this.cache !== null && now - this.cache.at < this.ttlMs) {
      return { keys: this.cache.keys, at: new Date(this.cache.at), cached: true };
    }

    // 单飞：正在拉就等它，别再来一份
    if (this.inflight !== null) {
      return { keys: await this.inflight, at: new Date(), cached: true };
    }

    const task = this.client.getObjectInfo().then((info) => new Set(Object.keys(info)));
    this.inflight = task;
    try {
      const keys = await task;
      this.cache = { at: Date.now(), keys };
      return { keys, at: new Date(this.cache.at), cached: false };
    } finally {
      this.inflight = null;
    }
  }

  /** 完整报告（`GET /api/deps`）。上游不可达时返回 `ok: null` —— **不谎报缺失**。 */
  async report(options: { refresh?: boolean } = {}): Promise<DepsReport> {
    let keys: Set<string>;
    let at: Date;
    let cached: boolean;
    try {
      const result = await this.nodeKeys(options);
      keys = result.keys;
      at = result.at;
      cached = result.cached;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('依赖检查失败：ComfyUI 不可达，无法判断依赖', { error: message });
      return {
        ok: null,
        checkedAt: null,
        error: message,
        missingBuiltin: [],
        missing: [],
        packs: this.packViews(null),
        templates: this.templateViews(null),
      };
    }

    const { builtin } = this.declared();
    const missingBuiltin = builtin.filter((cls) => !keys.has(cls));
    const templates = this.templateViews(keys);
    const packs = this.packViews(keys);

    // 节点 → 出处（包）；内置缺失时 pack 为 null（装插件包没用，得升级 ComfyUI）
    const byClass = new Map<string, { name: string; url: string }>();
    for (const pack of packs) {
      for (const cls of pack.missing) byClass.set(cls, { name: pack.name, url: pack.url });
    }
    const missing = [...new Set([...byClass.keys(), ...missingBuiltin])]
      .sort()
      .map((classType) => ({ classType, pack: byClass.get(classType) ?? null }));

    return {
      ok: missing.length === 0,
      checkedAt: at.toISOString(),
      cached,
      nodeCount: keys.size,
      missingBuiltin,
      missing,
      packs,
      templates,
    };
  }

  /**
   * 缺失节点的可读解释，例如 `CR Text（装 Comfyroll：https://…）`。
   *
   * 直接用在 422 的 message 里：用户在任务失败详情里就能看到该去装什么，
   * 而不是只知道一个节点名。
   */
  describeMissing(missing: string[], requirements?: TemplateRequirements): string {
    const packs = requirements?.packs ?? this.declared().packs;
    return missing
      .map((cls) => {
        const pack = packs.find((p) => (p.provides ?? []).includes(cls));
        return pack === undefined ? cls : `${cls}（装 ${pack.name}：${pack.url}）`;
      })
      .join('；');
  }

  /** 全部模板的声明并集；同名包合并 provides（任一模板必需 → 该包必需） */
  private declared(): { builtin: string[]; packs: PackRequirement[] } {
    const builtin = new Set<string>();
    const packs = new Map<string, PackRequirement>();
    for (const tpl of this.templates.list()) {
      const req = tpl.def.requirements;
      for (const cls of req?.builtin ?? []) builtin.add(cls);
      for (const pack of req?.packs ?? []) {
        const prev = packs.get(pack.name);
        if (prev === undefined) {
          packs.set(pack.name, { ...pack, provides: [...pack.provides] });
        } else {
          prev.provides = [...new Set([...prev.provides, ...pack.provides])];
          if (prev.optional === true && pack.optional !== true) prev.optional = false;
        }
      }
    }
    return { builtin: [...builtin].sort(), packs: [...packs.values()] };
  }

  private packViews(keys: Set<string> | null): DepsPackView[] {
    return this.declared().packs.map((pack) => ({
      ...pack,
      // keys === null = 没查成：这里留空数组，缺失与否由 ok:null 表达，不猜
      missing: keys === null ? [] : pack.provides.filter((cls) => !keys.has(cls)),
    }));
  }

  private templateViews(keys: Set<string> | null): DepsTemplateView[] {
    return this.templates.list().map((tpl) => {
      const req = tpl.def.requirements;
      const nodes = req?.nodes ?? [];
      // 可选包里提供的节点不算"必需"
      const optional = new Set(
        (req?.packs ?? []).filter((p) => p.optional === true).flatMap((p) => p.provides ?? []),
      );
      const missing =
        keys === null ? [] : nodes.filter((cls) => !keys.has(cls) && !optional.has(cls));
      return {
        id: tpl.def.id,
        name: tpl.def.name,
        // 没查成时**不拦**（ready=true）：拦的只能是"确实缺"，不能是"查不了"
        ready: keys === null ? true : missing.length === 0,
        missing,
      };
    });
  }
}
