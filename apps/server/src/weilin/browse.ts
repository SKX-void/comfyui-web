import type { WeilinLoraEntry } from './client.js';

export interface LoraBrowseItem {
  name: string;
  lora: string;
  displayName: string;
  folder: string;
}

export interface LoraBrowseFolder {
  path: string;
  name: string;
  /** 该目录**直属**的 LoRA 数（不含更深层） */
  count: number;
}

export interface LoraBrowseResult {
  path: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  folders: LoraBrowseFolder[];
  items: LoraBrowseItem[];
  total: number;
}

function trimSlashes(s: string): string {
  return s.replace(/^\\+|\\+$/g, '');
}

/**
 * 目录浏览切片：**只返回指定目录的直属内容，不递归子目录**。
 *
 * 子目录以 folders 形式返回，由前端逐层进入。
 * 这样每层响应都很小，也避免一次性把几百个 LoRA 全丢给浏览器。
 *
 * 抽成纯函数是为了让"不递归"这条规则可被单测覆盖 —— 它太容易回归了。
 *
 * @param all 全量 LoRA 列表（WeiLin 的 get_lora_folder_list，服务端已缓存）
 * @param dir 当前目录；空字符串表示根
 */
export function browseLoras(all: WeilinLoraEntry[], dir: string): LoraBrowseResult {
  const current = trimSlashes(dir);
  const prefix = current ? `${current}\\` : '';

  const items: LoraBrowseItem[] = [];
  const childCounts = new Map<string, number>();

  for (const l of all) {
    // 1) 当前目录直属的文件
    if (l.folder === current) {
      items.push({
        name: l.name,
        lora: l.path,
        displayName: l.displayName,
        folder: l.folder,
      });
      continue;
    }
    // 2) 必须在当前目录之下，否则与本次浏览无关
    if (!l.folder.startsWith(prefix)) continue;

    const rest = l.folder.slice(prefix.length);
    const seg = rest.split('\\')[0];
    if (!seg) continue;

    const childPath = prefix + seg;
    // 先登记子目录：即使它只有更深层内容、直属数为 0，也要能进入
    if (!childCounts.has(childPath)) childCounts.set(childPath, 0);
    // 只有"正好落在该子目录"的才算它的直属文件
    if (l.folder === childPath) {
      childCounts.set(childPath, childCounts.get(childPath)! + 1);
    }
  }

  const folders: LoraBrowseFolder[] = [...childCounts.entries()]
    .map(([p, count]) => ({ path: p, name: p.split('\\').pop() ?? p, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));

  const segments = current ? current.split('\\') : [];
  const breadcrumbs = [{ name: '全部', path: '' }];
  for (let i = 0; i < segments.length; i++) {
    breadcrumbs.push({ name: segments[i]!, path: segments.slice(0, i + 1).join('\\') });
  }

  return { path: current, breadcrumbs, folders, items, total: items.length };
}
