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

export interface WeilinLoraEntry {
  /** 含扩展名的完整名，如 "Anima\\画师\\taffy-style.safetensors" */
  path: string;
  /** 不含扩展名，可直接写入模板的 lora 字段 */
  name: string;
  /** 所在目录（可能是多级，如 "Anima\\画师"） */
  folder: string;
  /** 末级文件名（用于展示） */
  displayName: string;
}

/** get_lora_folder_list 的返回：{ all: [...], <folder>: { all: [...], ... } } */
type FolderNode = { all?: string[]; [k: string]: FolderNode | string[] | undefined };

export interface WeilinTag {
  id: number;
  text: string;
  /** 中文释义 */
  translate: string;
  color: string;
  /** 所属顶层组名，如 "人物" */
  topGroup: string;
  /** 所属子组名，如 "头发" */
  group: string;
}

export interface WeilinTopGroup {
  id: number;
  name: string;
  color: string;
  subgroups: Array<{ id: number; name: string; color: string; tagCount: number }>;
  tagCount: number;
}

export interface WeilinLoraInfo {
  file: string;
  /** 触发词（来自 Civitai trainedWords 或元数据） */
  triggerWords: string[];
  /** 用户编辑的触发词（节点不读取，仅展示） */
  loraWorks: string;
  civitaiName: string;
  nsfwLevel: number | null;
  baseModel: string;
}

export interface WeilinStatus {
  available: boolean;
  /** LoRA 索引是否加载完成 */
  isLoading: boolean;
  progress: number;
  total: number;
  current: number;
  message?: string;
}

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
  private readonly baseUrl: string;
  private readonly mode: 'real' | 'mock';
  private readonly timeoutMs: number;
  private readonly log: (msg: string, meta?: unknown) => void;

  private tagCache: CacheEntry<{ tags: WeilinTag[]; groups: WeilinTopGroup[] }> | null = null;
  private folderCache: CacheEntry<WeilinLoraEntry[]> | null = null;
  private statusCache = { available: false, at: 0 };

  constructor(opts: WeilinClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.mode = opts.mode;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.log ?? (() => {});
  }

  private url(pathname: string): string {
    return `${this.baseUrl}/weilin/prompt_ui/api/${pathname}`;
  }

  private async post<T>(pathname: string, body: unknown = {}): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WeiLin ${pathname} 返回 ${res.status}`);
    return (await res.json()) as T;
  }

  private async get<T>(pathname: string): Promise<T> {
    const res = await fetch(this.url(pathname), {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WeiLin ${pathname} 返回 ${res.status}`);
    return (await res.json()) as T;
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
      const r = await this.get<{ data: { isLoading: boolean; progress: number; total: number; current: number } }>(
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

  private static toEntry(path: string): WeilinLoraEntry {
    const base = path.replace(/\.safetensors$/i, '');
    const sep = base.lastIndexOf('\\');
    const folder = sep >= 0 ? base.slice(0, sep) : '';
    const displayName = sep >= 0 ? base.slice(sep + 1) : base;
    return { path, name: base, folder, displayName };
  }

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
    const r = await this.post<{ data: FolderNode }>('get_lora_folder_list');
    const all = Array.isArray(r.data?.all) ? (r.data.all as string[]) : [];
    const entries = all.map(WeilinClient.toEntry);
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
    const r = await this.get<{ status: number; data: Record<string, unknown> }>(
      `lorainfo/api/loras/info?file=${encodeURIComponent(file)}`,
    );
    const d = (r.data ?? {}) as Record<string, unknown>;
    const raw = (d.raw ?? {}) as Record<string, unknown>;
    const civitai = (raw.civitai ?? {}) as Record<string, unknown>;
    const metadata = (raw.metadata ?? {}) as Record<string, unknown>;

    // 触发词：优先用户编辑的 trainedWords / loraWorks，其次 Civitai
    const triggerWords: string[] = [];
    const trained = d.trainedWords;
    if (Array.isArray(trained)) {
      for (const w of trained) {
        if (w && typeof w === 'object' && typeof (w as { word?: string }).word === 'string') {
          triggerWords.push((w as { word: string }).word);
        }
      }
    }
    if (Array.isArray(civitai.trainedWords)) {
      for (const w of civitai.trainedWords) {
        if (typeof w === 'string' && !triggerWords.includes(w)) triggerWords.push(w);
      }
    }

    return {
      file,
      triggerWords,
      loraWorks: typeof d.loraWorks === 'string' ? d.loraWorks : '',
      civitaiName: typeof civitai.name === 'string' ? civitai.name : '',
      nsfwLevel: typeof civitai.nsfwLevel === 'number' ? civitai.nsfwLevel : null,
      baseModel: typeof metadata['ss_base_model_version'] === 'string'
        ? (metadata['ss_base_model_version'] as string)
        : '',
    };
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

    const r = await this.get<{
      data: Array<{
        id_index: number;
        name: string;
        color: string;
        groups?: Array<{
          id_index: number;
          name: string;
          color: string;
          tags?: Array<{ id_index: number; text: string; desc: string; color: string }>;
        }>;
      }>;
    }>('prompt/get_group_tags_paginated?page=1&page_size=1000');

    const tags: WeilinTag[] = [];
    const groups: WeilinTopGroup[] = [];
    for (const top of r.data ?? []) {
      const subgroups: WeilinTopGroup['subgroups'] = [];
      let topCount = 0;
      for (const sub of top.groups ?? []) {
        const subTags = sub.tags ?? [];
        subgroups.push({
          id: sub.id_index,
          name: sub.name,
          color: sub.color,
          tagCount: subTags.length,
        });
        topCount += subTags.length;
        for (const t of subTags) {
          tags.push({
            id: t.id_index,
            text: t.text,
            translate: t.desc ?? '',
            color: t.color ?? '',
            topGroup: top.name,
            group: sub.name,
          });
        }
      }
      groups.push({
        id: top.id_index,
        name: top.name,
        color: top.color,
        subgroups,
        tagCount: topCount,
      });
    }

    const value = { tags, groups };
    this.tagCache = { value, at: now };
    this.log('WeiLin 标签树已缓存', { tags: tags.length, groups: groups.length });
    return value;
  }

  /** 输入补全（轻量，不缓存） */
  async autocomplete(query: string): Promise<WeilinTag[]> {
    if (this.mode === 'mock') {
      const k = query.toLowerCase();
      return MOCK_TAGS.tags.filter((t) => t.text.toLowerCase().includes(k)).slice(0, 20);
    }
    const r = await this.post<{
      data: Array<{ text: string; desc: string; color: string; color_id: number }>;
    }>('prompt/fast/autocomplete', { query });
    return (r.data ?? []).map((t) => ({
      id: t.color_id ?? 0,
      text: t.text,
      translate: t.desc ?? '',
      color: t.color ?? '',
      topGroup: '',
      group: '',
    }));
  }

  /** 本地翻译（中英） */
  async translate(
    phrase: string,
  ): Promise<{ original: string; translated: string; color: string }> {
    if (this.mode === 'mock') {
      return { original: phrase, translated: `【译】${phrase}`, color: '' };
    }
    const r = await this.post<{
      original: string;
      translated: { translate: string; color: string } | string;
    }>('prompt/local/translate', { phrase });
    const t = r.translated;
    return {
      original: r.original ?? phrase,
      translated: typeof t === 'string' ? t : (t?.translate ?? ''),
      color: typeof t === 'string' ? '' : (t?.color ?? ''),
    };
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
    const url = `${this.url('lorainfo/api/loras/img')}?file=${encodeURIComponent(file)}`;
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

// ---------------------------------------------------------------------------
// mock 数据：让前端在无 WeiLin 时也能开发
// ---------------------------------------------------------------------------

const MOCK_LORAS: WeilinLoraEntry[] = [
  // 根目录直属
  { path: 'root-lora.safetensors', name: 'root-lora', folder: '', displayName: 'root-lora' },
  // 一级目录直属
  { path: 'Anima\\Anima Turbo LoRA-v0.2.safetensors', name: 'Anima\\Anima Turbo LoRA-v0.2', folder: 'Anima', displayName: 'Anima Turbo LoRA-v0.2' },
  // 二级目录直属（用于验证"不递归"）
  { path: 'Anima\\画师\\taffy-style.safetensors', name: 'Anima\\画师\\taffy-style', folder: 'Anima\\画师', displayName: 'taffy-style' },
  { path: 'Anima\\人物\\mock character.safetensors', name: 'Anima\\人物\\mock character', folder: 'Anima\\人物', displayName: 'mock character' },
];

const MOCK_TAGS: { tags: WeilinTag[]; groups: WeilinTopGroup[] } = {
  tags: [
    { id: 1, text: 'blue hair', translate: '蓝色头发', color: 'rgba(0,255,255,.4)', topGroup: '人物', group: '头发' },
    { id: 2, text: 'long hair', translate: '长发', color: 'rgba(0,255,255,.4)', topGroup: '人物', group: '头发' },
    { id: 3, text: 'solo', translate: '单人', color: 'rgba(255,123,2,.4)', topGroup: '人物', group: '人数' },
    { id: 4, text: 'looking at viewer', translate: '看向观者', color: 'rgba(120,200,80,.4)', topGroup: '镜头', group: '视线' },
    { id: 5, text: 'simple background', translate: '简单背景', color: 'rgba(200,120,255,.4)', topGroup: '场景', group: '背景' },
  ],
  groups: [
    {
      id: 1, name: '人物', color: 'rgba(255,123,2,.4)', tagCount: 3,
      subgroups: [
        { id: 11, name: '头发', color: 'rgba(255,123,2,.4)', tagCount: 2 },
        { id: 12, name: '人数', color: 'rgba(255,123,2,.4)', tagCount: 1 },
      ],
    },
    {
      id: 2, name: '镜头', color: 'rgba(120,200,80,.4)', tagCount: 1,
      subgroups: [{ id: 21, name: '视线', color: 'rgba(120,200,80,.4)', tagCount: 1 }],
    },
    {
      id: 3, name: '场景', color: 'rgba(200,120,255,.4)', tagCount: 1,
      subgroups: [{ id: 31, name: '背景', color: 'rgba(200,120,255,.4)', tagCount: 1 }],
    },
  ],
};
