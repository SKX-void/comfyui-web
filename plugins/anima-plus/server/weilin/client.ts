/**
 * WeiLin 适配层（plugins/anima-plus/docs/weilin.md §3）。
 *
 * 复用 WeiLin 注册在 ComfyUI 上的 REST 路由（前缀 /weilin/prompt_ui/api/），
 * 不重新实现标签库 / LoRA 索引逻辑。
 *
 * 实测的体积约束（2026-09-18，真机 288 个 LoRA / 4215 个标签）决定了接口选型：
 *   get_lora_list                    → 41 MB   ❌ 绝不使用
 *   get_lora_folder_list             → 98 KB   ✅ 列表/目录树
 *   get_lora_list_by_search          → 视命中数 ✅ 搜索
 *   lorainfo/api/loras/info          → 71 KB/条 ❌ 只能按需查详情
 *   prompt/get_group_tags_paginated  → 848 KB  ✅ 一次性拉全量并在服务端缓存
 *   prompt/fast/autocomplete         → 3 KB    ✅ 输入补全
 *   prompt/local/translate           → 132 B   ✅ 翻译
 */

import type {
  FolderNode,
  WeilinLoraEntry,
  WeilinLoraInfo,
  WeilinStatus,
  WeilinTag,
  WeilinTopGroup,
} from './types.js';
import { WeilinHttp } from './http.js';
import { MOCK_LORAS, MOCK_TAGS } from './mock.js';
import {
  normalizeAutocomplete,
  normalizeLoraInfo,
  normalizeTagTree,
  normalizeTranslate,
  toEntry,
} from './normalize.js';
import type { AutocompleteItem, TagGroupPayload, TranslateResponse } from './normalize.js';

// 导出面保持不变：调用方仍然只从 weilin/client.js 拿 WeilinClient 与这些类型。
export type {
  WeilinLoraEntry,
  WeilinLoraInfo,
  WeilinStatus,
  WeilinTag,
  WeilinTopGroup,
} from './types.js';

const TAG_TREE_TTL_MS = 10 * 60_000;
const FOLDER_TREE_TTL_MS = 5 * 60_000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

interface WeilinClientOptions {
  baseUrl: string;
  mode: 'real' | 'mock';
  timeoutMs?: number;
  log?: (msg: string, meta?: unknown) => void;
}

export class WeilinClient {
  private readonly mode: 'real' | 'mock';
  private readonly timeoutMs: number;
  private readonly log: (msg: string, meta?: unknown) => void;
  private readonly http: WeilinHttp;

  private tagCache: CacheEntry<{ tags: WeilinTag[]; groups: WeilinTopGroup[] }> | null = null;
  private folderCache: CacheEntry<WeilinLoraEntry[]> | null = null;
  private statusCache = { available: false, at: 0 };

  constructor(opts: WeilinClientOptions) {
    this.mode = opts.mode;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.log ?? (() => {});
    this.http = new WeilinHttp(opts.baseUrl, this.timeoutMs);
  }

  // -------------------------------------------------------------------------
  // 探活
  // -------------------------------------------------------------------------

  /** 能力探测（plugins/anima-plus/docs/weilin.md §3.2）。失败即视为不可用，前端降级。 */
  async probe(): Promise<WeilinStatus> {
    if (this.mode === 'mock') {
      return { available: true, isLoading: false, progress: 100, total: 6, current: 6 };
    }
    try {
      const r = await this.http.get<{ data: { isLoading: boolean; progress: number; total: number; current: number } }>(
        'get_lora_load_status',
      );
      this.statusCache = { available: true, at: Date.now() };
      return {
        available: true,
        isLoading: Boolean(r.data?.isLoading),
        progress: Number(r.data?.progress ?? 0),
        total: Number(r.data?.total ?? 0),
        current: Number(r.data?.current ?? 0),
      };
    } catch (err) {
      this.statusCache = { available: false, at: Date.now() };
      this.log('WeiLin 探活失败', { err: String(err) });
      return {
        available: false,
        isLoading: false,
        progress: 0,
        total: 0,
        current: 0,
        message: String(err),
      };
    }
  }

  isAvailable(): boolean {
    return this.statusCache.available;
  }

  // -------------------------------------------------------------------------
  // LoRA
  // -------------------------------------------------------------------------

  /**
   * LoRA 全量列表（来自 98KB 的目录树，缓存 5 分钟）。
   * 目录浏览由路由层在这份缓存上做"只看当前层"的切片，不递归下发。
   */
  async listLoras(): Promise<WeilinLoraEntry[]> {
    if (this.mode === 'mock') return MOCK_LORAS;
    const now = Date.now();
    if (this.folderCache && now - this.folderCache.at < FOLDER_TREE_TTL_MS) {
      return this.folderCache.value;
    }
    const r = await this.http.post<{ data: FolderNode }>('get_lora_folder_list');
    const all = Array.isArray(r.data?.all) ? (r.data.all as string[]) : [];
    const entries = all.map(toEntry);
    this.folderCache = { value: entries, at: now };
    this.log('WeiLin LoRA 列表已缓存', { count: entries.length });
    return entries;
  }

  /** LoRA 详情（71KB/条，仅在用户选中时调用） */
  async getLoraInfo(file: string): Promise<WeilinLoraInfo> {
    if (this.mode === 'mock') {
      return {
        file,
        triggerWords: ['mock-trigger'],
        loraWorks: '',
        civitaiName: '',
        nsfwLevel: null,
        baseModel: 'mock',
      };
    }
    const r = await this.http.get<{ status: number; data: Record<string, unknown> }>(
      `lorainfo/api/loras/info?file=${encodeURIComponent(file)}`,
    );
    return normalizeLoraInfo(file, (r.data ?? {}) as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // 标签
  // -------------------------------------------------------------------------

  /** 全量标签树（848KB，缓存 10 分钟；服务端展平后供前端分页消费） */
  async getTagTree(): Promise<{ tags: WeilinTag[]; groups: WeilinTopGroup[] }> {
    if (this.mode === 'mock') return MOCK_TAGS;
    const now = Date.now();
    if (this.tagCache && now - this.tagCache.at < TAG_TREE_TTL_MS) {
      return this.tagCache.value;
    }

    const r = await this.http.get<{ data: TagGroupPayload[] }>(
      'prompt/get_group_tags_paginated?page=1&page_size=1000',
    );
    const value = normalizeTagTree(r.data);
    this.tagCache = { value, at: now };
    this.log('WeiLin 标签树已缓存', { tags: value.tags.length, groups: value.groups.length });
    return value;
  }

  /** 输入补全（轻量，不缓存） */
  async autocomplete(query: string): Promise<WeilinTag[]> {
    if (this.mode === 'mock') {
      const k = query.toLowerCase();
      return MOCK_TAGS.tags.filter((t) => t.text.toLowerCase().includes(k)).slice(0, 20);
    }
    const r = await this.http.post<{ data: AutocompleteItem[] }>(
      'prompt/fast/autocomplete',
      { query },
    );
    return normalizeAutocomplete(r.data);
  }

  /** 本地翻译（中英） */
  async translate(
    phrase: string,
  ): Promise<{ original: string; translated: string; color: string }> {
    if (this.mode === 'mock') {
      return { original: phrase, translated: `【译】${phrase}`, color: '' };
    }
    const r = await this.http.post<TranslateResponse>('prompt/local/translate', { phrase });
    return normalizeTranslate(r, phrase);
  }

  // -------------------------------------------------------------------------
  // 预览图代理
  // -------------------------------------------------------------------------

  /**
   * 按 LoRA 文件路径取预览图原始字节（LoRA 同名图片）。
   *
   * ⚠️ WeiLin 在**没有预览图**时返回的是 `HTTP 200 + JSON`
   * （`{"status":"404","error":"No Lora found at path"}`），
   * 所以不能只看 HTTP 状态码，必须检查 content-type / 内容特征。
   */
  async fetchLoraPreview(
    file: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    if (this.mode === 'mock') return null;
    const url = `${this.http.url('lorainfo/api/loras/img')}?file=${encodeURIComponent(file)}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      this.log('取预览图失败', { file, err: String(err) });
      return null;
    }
    if (!res.ok) return null;

    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return null; // 无预览图的 JSON 占位

    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0) return null;
    // 再兜一层：极小的响应基本不是图片
    if (data.length < 64) return null;

    return { data, contentType: ct || 'image/png' };
  }

  invalidate(): void {
    this.tagCache = null;
    this.folderCache = null;
  }
}
