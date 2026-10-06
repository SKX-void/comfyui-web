import { AppError } from '../errors.js';

/** 产出图片在 ComfyUI 侧的三元组（也是 /view 的查询参数） */
export interface AssetRef {
  type: string;
  subfolder: string;
  filename: string;
}

/** 把「产出图片」编码成可逆的 assetId，避免额外持久化 */
export function encodeAssetId(a: AssetRef): string {
  return Buffer.from(`${a.type}\u0000${a.subfolder}\u0000${a.filename}`).toString('base64url');
}

export function decodeAssetId(id: string): AssetRef {
  const raw = Buffer.from(id, 'base64url').toString('utf8');
  const [type, subfolder, filename] = raw.split('\u0000');
  if (!type || !filename) throw AppError.badRequest(`非法 assetId: ${id}`);
  return { type, subfolder: subfolder ?? '', filename };
}
