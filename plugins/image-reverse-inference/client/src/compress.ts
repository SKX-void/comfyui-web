/**
 * 上传前的图片预处理：**全部在浏览器里做完**。
 *
 * 为什么要压：插件后端收的是 base64 JSON（原因见 server/index.ts 头注释），
 * 而宿主 fastify 的 `bodyLimit` 是 4MB —— base64 膨胀 4/3，所以原图必须留在 1MB 以内。
 *
 * 策略（按用户定的口径）：
 *   1. 长边先缩到 `MAX_EDGE`；
 *   2. 编码成 webp q0.8；
 *   3. 还超过 `TARGET_BYTES` 就等比 ×0.85 重编，直到达标或触到 `MIN_EDGE`；
 *   4. 最终仍超过 `MAX_BYTES` 就报错，不发。
 */

/** 硬上限：超过就拒发（服务端兜底 2MB，这里比它严） */
export const MAX_BYTES = 1_000_000;
/** 目标体积：一般图压到这个数就停 */
export const TARGET_BYTES = 500_000;
export const MAX_EDGE = 4096;
/** 缩放的底线：再小就没法反推了，宁可报错也不糊成一团 */
export const MIN_EDGE = 256;
export const QUALITY = 0.8;
/** 缩放轮数上限：防止病态图片把页面卡死 */
const MAX_ROUNDS = 8;

export interface PreparedImage {
  /** 发给后端的 data URL */
  dataUrl: string;
  filename: string;
  bytes: number;
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

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error(`不是图片：${file.type || '未知类型'}`);

  const decoded = await decode(file);
  try {
    const source = sizeOf(decoded);
    if (source.width === 0 || source.height === 0) throw new Error('图片解码后是 0 尺寸');

    const initial = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
    let width = Math.max(1, Math.round(source.width * initial));
    let height = Math.max(1, Math.round(source.height * initial));

    let encoded = await encode(decoded, width, height, QUALITY);
    let rounds = 0;
    while (
      encoded.blob.size > TARGET_BYTES &&
      rounds < MAX_ROUNDS &&
      Math.min(width, height) > MIN_EDGE
    ) {
      width = Math.max(MIN_EDGE, Math.round(width * 0.85));
      height = Math.max(MIN_EDGE, Math.round(height * 0.85));
      encoded = await encode(decoded, width, height, QUALITY);
      rounds += 1;
    }

    if (encoded.blob.size > MAX_BYTES) {
      throw new Error(
        `压到 ${width}×${height} 还有 ${formatBytes(encoded.blob.size)}，超过 ${formatBytes(MAX_BYTES)}，请换小一点的图`,
      );
    }

    return {
      dataUrl: await toDataUrl(encoded.blob),
      filename: renameFor(file, encoded.mime),
      bytes: encoded.blob.size,
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
