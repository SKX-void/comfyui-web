import { createImageLibrary } from 'purejsimage';
import { jpegCodec } from 'purejsimage/codecs/jpeg';
import { pngCodec } from 'purejsimage/codecs/png';
import { webpCodec } from 'purejsimage/codecs/webp';

/**
 * 缩略图编解码：**纯 JS**，没有原生模块。
 *
 * 历史：这里原本是"惰性 `import('sharp')`，拿不到就原图直出"。sharp 是原生模块，
 * 和"esbuild 打成单文件 `lib/server.js`"的目标冲突（`.node` 二进制没法内联），
 * 所以一直没装；替代方案是在 ComfyUI 主机上跑离线脚本
 * `scripts/resize-lora-previews.py` 把预览图预先缩小。
 *
 * 现在换成 `purejsimage`（strict TS、零运行时依赖、14 个稳定编解码器；
 * 那 8 个 `.wasm` 是**可选加速器**，要显式注册才会用到，我们只注册纯 JS 路径）。
 * 于是服务端自己就能转，离线脚本从"必须"降级为"可选"。
 *
 * 三条策略：
 * 1. **只在划算时转**（`shouldPassThrough`）：源 ≤128KB 且尺寸不超过目标 2 倍就直接透传。
 *    库里那些已经预缩过的 20~30KB WebP 预览图因此完全不花 CPU，
 *    真正要转的是"新加的 LoRA"（几 MB 的 PNG）和产出图（ComfyUI 的 PNG）。
 * 2. 输出统一 **JPEG progressive q74**：本机实测比纯 JS 的 WebP 编码快一倍
 *    （512px 预览 91ms vs 191ms；3072x2048 PNG 474ms vs 566ms），大图产物还更小。
 * 3. 任何解码/编码失败都返回 `null`（调用方回退成原图直出），**绝不 500**。
 *
 * 实测（ARM64 弱主机）：3072x2048 PNG 转码 474ms，期间事件循环最长只阻塞 32ms
 * （编码器内部在分块 await），所以不需要 worker；内存增量 14MB。
 * 详见 docs/architecture.md §14.1g 与 README「缩略图」。
 */

/** 只注册用得到的三个：预览图 13/14 是 WebP，产出图是 PNG，另有少量 JPEG */
const images = createImageLibrary({ codecs: [jpegCodec, pngCodec, webpCodec] });

export const THUMB_QUALITY = 74;

/**
 * 引擎与策略的版本号，**参与缓存 key**。
 *
 * 缓存目录里的文件是按 `sha1(键|tag)` 命名的：换了引擎/阈值/输出格式之后
 * tag 必须变，否则会拿旧的（比如 sharp 时代或"原图直出"时代的）缓存糊弄人。
 */
export const RESIZER_TAG = 'purejs-jpeg-v1';

/** 小于这个体积、且尺寸离目标不远 → 直接透传，省一次解码+重编码 */
const PASSTHROUGH_MAX_BYTES = 128 * 1024;
/** 源边长 ≤ 目标边长 × 这个倍数时才考虑透传（列表要 112px 时，512px 的原图仍会被缩） */
const PASSTHROUGH_SCALE = 2;
/** 再大就不碰了：保护弱主机的内存（解码后一像素 4 字节，24MB 压缩图可能上亿像素） */
const MAX_INPUT_BYTES = 24 * 1024 * 1024;

interface CodecStats {
  /** 真的解码+缩放+重编码的张数 */
  transcoded: number;
  /** 因为"划算"而直接透传的张数 */
  passthrough: number;
  /** 解码/编码失败（调用方已回退原图）的张数 */
  failed: number;
  lastError: string | null;
}

const stats: CodecStats = { transcoded: 0, passthrough: 0, failed: 0, lastError: null };

/**
 * 值不值得转？纯函数，便于自检与日后调阈值。
 *
 * 注意"尺寸"用的是**源的真实像素**（解码头部就能拿到，不必整张解码）。
 */
export function shouldPassThrough(
  srcBytes: number,
  srcWidth: number,
  srcHeight: number,
  width: number,
  height: number,
): boolean {
  if (srcBytes > PASSTHROUGH_MAX_BYTES) return false;
  if (srcWidth > width * PASSTHROUGH_SCALE) return false;
  if (srcHeight > height * PASSTHROUGH_SCALE) return false;
  return true;
}

/**
 * 尝试生成缩略图。
 *
 * - 返回 `Buffer`：已转成 `width`×`height` 的 JPEG（`fit: cover` 居中裁切）
 * - 返回 `null`：**用原图**（源够小不必转 / 太大不敢转 / 格式不支持 / 解码失败）
 *
 * 顺带 `autoOrient()`：JPEG 预览图带 EXIF 旋转时，不摆正会缩出一张躺着的图。
 */
export async function makeThumbnail(
  src: Buffer,
  width: number,
  height: number,
): Promise<Buffer | null> {
  if (src.length > MAX_INPUT_BYTES) {
    stats.passthrough += 1;
    return null;
  }
  try {
    const image = await images.open(src);
    const meta = await image.metadata();
    if (shouldPassThrough(src.length, meta.width, meta.height, width, height)) {
      stats.passthrough += 1;
      return null;
    }
    // position 只在 fit: 'contain' 下合法，所以这里只给 fit/尺寸；
    // JPEG 无 alpha，白底压平（预览图基本不透明，产出图偶有 alpha）
    const out = await image
      .autoOrient()
      .resize({ width, height, fit: 'cover' })
      .jpeg({ quality: THUMB_QUALITY, progressive: true, background: '#ffffff' })
      .toBuffer();
    stats.transcoded += 1;
    return Buffer.from(out);
  } catch (err) {
    stats.failed += 1;
    stats.lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/** 现在一定有缩放能力（纯 JS 随包走，不需要"探测可选依赖"） */
export async function resizerAvailable(): Promise<boolean> {
  return true;
}

/** 参与缓存 key 的引擎标识 */
export async function resizerTag(): Promise<string> {
  return RESIZER_TAG;
}

/** 排障用：`GET /api/loras/thumb/stats` 会带上它 */
export function thumbStatus(): CodecStats & { engine: string; quality: number } {
  return { ...stats, engine: RESIZER_TAG, quality: THUMB_QUALITY };
}
