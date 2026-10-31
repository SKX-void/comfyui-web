/**
 * 上传前的图片预处理：**全部在浏览器里做完**。
 *
 * 卡的是**请求体**，不是图片本身：宿主 fastify 的 `bodyLimit` 是 4 MiB
 * （实测 4,194,304 B 通过、4,194,305 B → 413 `FST_ERR_CTP_BODY_TOO_LARGE`），
 * 而图要装进 base64 JSON（膨胀 4/3，见 `server/index.ts` 头注释）。
 * 所以预算一律按 body 字节算：图 ≤ (body 预算 − JSON 余量) × 3/4。
 *
 * 前面若还挂着一层反向代理，真实上限会比 4 MiB **小** —— nginx 没写
 * `client_max_body_size` 时默认就是 `1m`，这种 413 只有请求发出去才看得见。
 * 所以 body 预算做成入参：撞到 413 就减半、等比缩完重试（`App.vue`）。
 *
 * 策略（按用户定的口径）：
 *   1. 格式不限：浏览器能解码就收（gif/avif/bmp 都行），长边先缩到 `MAX_EDGE`；
 *   2. 统一编码成 webp q0.8（不支持 webp 退 jpeg）；
 *   3. 超过 `TARGET_BYTES` 或 body 预算就**等比**缩 —— 面积的比 ≈ 字节的比，
 *      线性缩放 ≈ √(目标 / 现在)，两个方向同一个系数，绝不变形；
 *   4. 仍超过 body 预算就报错，不发。
 */

/** 宿主 fastify 的 `bodyLimit`（`apps/server/src/index.ts`），实测 4,194,305 B 就 413 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** data URL 前缀 + JSON 外壳（`dataUrl` / `filename` / `params` 的键名）的余量 */
const JSON_HEADROOM = 512;

/** 图片字节 → 装进 JSON 之后的 body 字节（base64 膨胀 4/3，向上取整到 3 的倍数） */
function bodyBytesOf(imageBytes: number): number {
  return Math.ceil(imageBytes / 3) * 4 + 64 + JSON_HEADROOM;
}

/** 反过来：这个 body 预算最多装多大的图（默认 4 MiB 预算 → ≈3.00 MB） */
export function maxImageBytes(bodyBudget: number): number {
  return Math.floor(((bodyBudget - 64 - JSON_HEADROOM) * 3) / 4);
}

/** 目标体积：一般图压到这个数就停（比硬上限小得多，上传也快） */
export const TARGET_BYTES = 500_000;
export const MAX_EDGE = 4096;
/** 软目标（压到 `TARGET_BYTES`）的缩放下限：再小就没法反推了 */
export const MIN_EDGE = 256;
/** 硬预算的下限：为了塞进请求体，允许比 `MIN_EDGE` 更小一点，但不无限缩 */
const HARD_MIN_EDGE = 96;
export const QUALITY = 0.8;
/** 缩放轮数上限：防止病态图片把页面卡死 */
const MAX_ROUNDS = 8;

export interface PreparedImage {
  /** 发给后端的 data URL */
  dataUrl: string;
  filename: string;
  bytes: number;
  /** 这份 dataUrl 装进 JSON 之后大约多少字节（判断 413 的口径） */
  bodyBytes: number;
  width: number;
  height: number;
  mime: string;
  rounds: number;
  originalBytes: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

type Decoded = ImageBitmap | HTMLImageElement;

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 走下面的 <img> 兜底（个别浏览器对 webp/avif 的 bitmap 解码更挑剔） */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(
      `浏览器解不开这个文件（${file.type || file.name || '未知类型'}）：转成 webp / png / jpeg 再试`,
    );
  } finally {
    // img.decode() 之后像素已经进内存，objectURL 可以立刻回收
    URL.revokeObjectURL(url);
  }
}

function sizeOf(decoded: Decoded): { width: number; height: number } {
  return decoded instanceof HTMLImageElement
    ? { width: decoded.naturalWidth, height: decoded.naturalHeight }
    : { width: decoded.width, height: decoded.height };
}

async function encode(
  decoded: Decoded,
  width: number,
  height: number,
  quality: number,
): Promise<{ blob: Blob; mime: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('拿不到 canvas 2d 上下文');
  // 缩图用高质量插值；背景先铺白，免得透明图转 webp/jpeg 后边缘发黑
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(decoded, 0, 0, width, height);

  for (const mime of ['image/webp', 'image/jpeg']) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), mime, quality);
    });
    if (blob !== null && blob.size > 0) return { blob, mime };
  }
  throw new Error('canvas 编码失败（webp / jpeg 都不支持）');
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读不出压缩结果'));
    reader.readAsDataURL(blob);
  });
}

function renameFor(file: File, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : 'webp';
  const stem = file.name.replace(/\.[A-Za-z0-9]+$/, '');
  return `${stem === '' ? 'image' : stem}.${ext}`;
}

/**
 * 把任意能解码的图收敛成「装得进 `bodyBudget` 的 webp」。
 *
 * `bodyBudget` 默认是宿主实测的 4 MiB；撞到代理的 413 时由调用方传入更小的值重来。
 */
export async function prepareImage(
  file: File,
  bodyBudget: number = MAX_BODY_BYTES,
): Promise<PreparedImage> {
  if (file.size === 0) throw new Error('这个文件是空的');
  const budgetImage = maxImageBytes(bodyBudget);
  if (budgetImage <= 0) {
    throw new Error(`请求体预算 ${formatBytes(bodyBudget)} 装不下任何图，先把代理的上限调大`);
  }

  const decoded = await decode(file);
  try {
    const source = sizeOf(decoded);
    if (source.width === 0 || source.height === 0) throw new Error('图片解码后是 0 尺寸');

    // 软目标：一般就是 500 KB；body 预算小（撞过 413、代理卡得紧）时按预算的一半收，
    // 否则「压到 500 KB」会造出 667 KB 的 body，永远撞在那条更低的线上
    const target = Math.min(TARGET_BYTES, Math.floor(budgetImage / 2));
    const initial = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
    let width = Math.max(1, Math.round(source.width * initial));
    let height = Math.max(1, Math.round(source.height * initial));

    let encoded = await encode(decoded, width, height, QUALITY);
    let rounds = 0;
    while (rounds < MAX_ROUNDS) {
      const size = encoded.blob.size;
      const overBudget = size > budgetImage;
      if (!overBudget && size <= target) break;
      // 等比：面积 ∝ 字节 → 边长 ∝ √(目标/现在)；×0.95 留余量，免得差一点再来一轮
      const goal = overBudget ? budgetImage : target;
      const scale = Math.min(0.95, Math.sqrt(goal / size) * 0.95);
      const floor = overBudget ? HARD_MIN_EDGE : MIN_EDGE;
      if (Math.min(width, height) * scale < floor) break;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      encoded = await encode(decoded, width, height, QUALITY);
      rounds += 1;
    }

    const bodyBytes = bodyBytesOf(encoded.blob.size);
    if (bodyBytes > bodyBudget) {
      throw new Error(
        `压到 ${width}×${height} 还有 ${formatBytes(encoded.blob.size)}（请求体 ${formatBytes(bodyBytes)}），` +
          `超过上限 ${formatBytes(bodyBudget)}：换小一点的图，或者把前面那层代理的请求体上限调大`,
      );
    }

    return {
      dataUrl: await toDataUrl(encoded.blob),
      filename: renameFor(file, encoded.mime),
      bytes: encoded.blob.size,
      bodyBytes,
      width,
      height,
      mime: encoded.mime,
      rounds,
      originalBytes: file.size,
    };
  } finally {
    if (decoded instanceof ImageBitmap) decoded.close();
  }
}
