import fs from 'node:fs/promises';

import type { HelpDoc } from '@comfyui-web/shared';

/**
 * 帮助文档：**包内的 `readme.md`**（运行本工作流需要装哪些 ComfyUI 节点包）。
 *
 * 为什么以文件为真源：这份 md 由 `scripts/gen-deps.mjs` 从模板的 `requirements`
 * 生成，人工补充的说明也可以写在里面 —— 界面里看到的与仓库里看到的必然一致。
 * 因此它**必须被拷进 tab**（`scripts/pack.mjs` 的 extras 里有 `readme.md`），
 * 否则产物里读不到它。
 *
 * 读不到**不算接口错误**：返回 `text: null` + 原因，界面退化成"按声明实时生成的清单"。
 * 这与 `/api/deps` 的三态是同一个口径 —— 能显示多少显示多少，但绝不说假话。
 */
const HELP_FILE = new URL('./readme.md', import.meta.url);

export async function readHelpDoc(): Promise<HelpDoc> {
  try {
    const [stat, text] = await Promise.all([fs.stat(HELP_FILE), fs.readFile(HELP_FILE, 'utf8')]);
    return {
      file: 'readme.md',
      text,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (err) {
    return {
      file: 'readme.md',
      text: null,
      bytes: 0,
      updatedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
