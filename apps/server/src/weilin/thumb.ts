import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ThumbResult {
  data: Buffer;
  contentType: string;
}

/**
 * 图像缩放器（可选依赖）。
 *
 * `sharp` 是原生模块，对"纯 JS 源码构建"不友好，因此**不静态依赖**它：
 * 运行时惰性 `import('sharp')`，拿不到就退化为「原图直出 + 缓存」。
 *
 * 两条替代路线（见 README「预览图体积」）：
 * 1. **离线预缩放**（推荐）：在 ComfyUI 主机上跑
 *    `scripts/resize-lora-previews.py`，把预览图缩到 512px WebP（3MB → ~40KB）。
 *    此后服务端无需任何缩放能力。
 * 2. 浏览器端压缩后回传缓存 —— 首次仍需拉原图，收益有限，故未采用。
 */
export interface Resizer {
  resize(src: Buffer, width: number, height: number): Promise<Buffer | null>;
}

/**
 * sharp 的最小结构化类型。
 *
 * 刻意**不引用 sharp 的类型声明**：它是可选依赖，未安装时不应该
 * 让类型检查失败（纯 JS 构建场景）。
 */
type SharpPipeline = {
  webp(opts: { quality: number }): { toBuffer(): Promise<Buffer> };
};
type SharpFactory = (input: Buffer) => {
  resize(
    width: number,
    height: number,
    opts: { fit: string; position: string },
  ): SharpPipeline;
};

let resizerPromise: Promise<Resizer | null> | undefined;

/**
 * 模块名用变量承载，让 TypeScript **无法静态解析**这个 import。
 *
 * 原因：sharp 是完全可选的运行时依赖（默认不安装）。
 * 若写成字面量 `import('sharp')`，未安装时 tsc 会报 TS2307，
 * 而这正是我们要支持的场景。用变量则编译期不检查，运行时 try/catch 兜底。
 */
const OPTIONAL_SHARP_MODULE = 'sharp';

async function loadResizer(): Promise<Resizer | null> {
  if (resizerPromise === undefined) {
    resizerPromise = (async (): Promise<Resizer | null> => {
      try {
        const mod = (await import(OPTIONAL_SHARP_MODULE)) as unknown as {
          default?: unknown;
        };
        // CJS/ESM 互操作：有时挂 default，有时是模块本身
        const sharp = (mod.default ?? mod) as SharpFactory;
        if (typeof sharp !== 'function') return null;
        return {
          async resize(src, width, height) {
            try {
              return await sharp(src)
                .resize(width, height, { fit: 'cover', position: 'attention' })
                .webp({ quality: 74 })
                .toBuffer();
            } catch {
              // 损坏/不支持的图片：当作"无法处理"
              return null;
            }
          },
        };
      } catch {
        return null;
      }
    })();
  }
  return resizerPromise;
}

/** 当前是否具备缩放能力（启动时打印，便于排查） */
export async function resizerAvailable(): Promise<boolean> {
  return (await loadResizer()) !== null;
}

/** 缩放能力的标识，参与缓存 key —— 切换模式后不会误用旧的缓存尺寸 */
export async function resizerTag(): Promise<'sharp' | 'none'> {
  return (await loadResizer()) ? 'sharp' : 'none';
}

/** 尝试生成缩略图；无缩放能力或解码失败时返回 null */
export async function makeThumbnail(
  src: Buffer,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const resizer = await loadResizer();
  if (!resizer) return null;
  return resizer.resize(src, width, height);
}

/**
 * 按 magic bytes 推断真实图片类型。
 *
 * 必要性：WeiLin 的 `lorainfo/api/loras/img` 会把 PNG 字节标成 `image/jpeg`
 * （实测 `taffy-style` 是 4.87 MB 的 PNG，Content-Type 却写 jpeg）。
 * 浏览器会嗅探所以能显示，但缓存/工具链可能被误导。
 */
export function sniffContentType(buf: Buffer, fallback: string): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return fallback;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// 尺寸解析
// ---------------------------------------------------------------------------

const THUMB_MIN = 32;
const THUMB_MAX = 640;
const THUMB_DEFAULT_W = 112;
const THUMB_DEFAULT_H = 112;

function clampSide(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(n)));
}

/**
 * 解析缩略图尺寸。
 *
 * 支持非正方形：LoRA 预览图多为竖构图，一律切方形会丢掉大半画面。
 * 卡片式列表用 3:4 更合适。
 */
export function normalizeThumbSize(
  rawW: unknown,
  rawH: unknown,
): { width: number; height: number } {
  const width = clampSide(rawW, THUMB_DEFAULT_W);
  const height = rawH === undefined || rawH === '' ? width : clampSide(rawH, width);
  return { width, height };
}

// ---------------------------------------------------------------------------
// 磁盘缓存
// ---------------------------------------------------------------------------

/**
 * 预览图缓存。
 *
 * 即使没有缩放能力也值得存在：避免同一个 LoRA/产出图被反复从 ComfyUI 拉取。
 * （ComfyUI 的 /view 不支持条件请求，缓存是唯一避免重复传输的手段。）
 */
export class ThumbnailCache {
  private readonly inflight = new Map<string, Promise<ThumbResult | null>>();

  constructor(
    private readonly dir: string,
    private readonly log: (msg: string, meta?: unknown) => void = () => {},
  ) {}

  private key(...parts: Array<string | number>): string {
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  }

  private filePath(key: string, contentType: string): string {
    const ext = contentType.includes('webp')
      ? 'webp'
      : contentType.includes('jpeg')
        ? 'jpg'
        : contentType.includes('png')
          ? 'png'
          : 'bin';
    return path.join(this.dir, `${key}.${ext}`);
  }

  /** 缓存目录里可能因 content-type 变化留下不同扩展名的同 key 文件 */
  private async find(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    for (const [ext, ct] of [
      ['webp', 'image/webp'],
      ['jpg', 'image/jpeg'],
      ['png', 'image/png'],
      ['bin', 'application/octet-stream'],
    ] as const) {
      try {
        const data = await fs.readFile(path.join(this.dir, `${key}.${ext}`));
        return { data, contentType: ct };
      } catch {
        // 继续找下一个扩展名
      }
    }
    return null;
  }

  async getOrCreate(
    cacheKey: string,
    produce: () => Promise<ThumbResult | null>,
  ): Promise<ThumbResult | null> {
    const key = this.key(cacheKey);

    const cached = await this.find(key);
    if (cached) return cached;

    // 并发去重：列表里同一项可能被重复请求
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = (async (): Promise<ThumbResult | null> => {
      try {
        const out = await produce();
        if (!out) return null;
        try {
          await fs.mkdir(this.dir, { recursive: true });
          await fs.writeFile(this.filePath(key, out.contentType), out.data);
        } catch (err) {
          this.log('预览图写缓存失败', { err: String(err) });
        }
        return out;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    try {
      const names = await fs.readdir(this.dir);
      let bytes = 0;
      for (const n of names) {
        const st = await fs.stat(path.join(this.dir, n)).catch(() => null);
        if (st?.isFile()) bytes += st.size;
      }
      return { count: names.length, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }
}
