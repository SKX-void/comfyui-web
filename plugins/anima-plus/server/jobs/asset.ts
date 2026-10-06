import type { Job, JobAsset } from '@comfyui-web/shared';
import { encodeAssetId } from './asset-id.js';

export function addAsset(
  job: Job,
  img: { filename: string; subfolder: string; type: string },
): void {
  const assetId = encodeAssetId(img);
  if (job.assets.some((a) => a.assetId === assetId)) return;
  const asset: JobAsset = {
    assetId,
    url: `/api/assets/${assetId}/raw`,
    filename: img.filename,
    subfolder: img.subfolder ?? '',
    type: img.type ?? 'output',
  };
  job.assets.push(asset);
}
