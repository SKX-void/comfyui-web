/**
 * 导入导出在浏览器这侧的两下子：把对象存成 `.json` 下载、把用户挑的文件读成对象。
 *
 * 单开一个文件是因为两边面板都要用，而且"下载"有一串容易漏的收尾（临时 URL 得 revoke、
 * 临时 `<a>` 得摘掉）—— 漏了就是内存里堆 blob，或者点第二次没反应。
 */

/** 文件名里的时间戳：本地时间 `20250101-1200`（同一天导两次不会互相覆盖） */
export function stamp(now = Date.now()): string {
  const at = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/**
 * 存成文件。`JSON.stringify(…, null, 2)`：这份文件是给人看、给人手改的，
 * 压成一行的话"导出 → 手改两条 → 导入"这条路就没法走了。
 */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // 有的浏览器要求 <a> 在文档里才认 click()
  document.body.append(link);
  link.click();
  link.remove();
  // 立刻 revoke 会把还没开始的下载掐掉（Safari 上尤其明显）：放到下一个宏任务
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 读用户挑的 `.json`。读不了 / 不是 JSON 一律抛 —— 面板把它当"这份文件用不了"显示出来 */
export async function readJsonFile(file: File): Promise<unknown> {
  const raw = await file.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`读不了 ${file.name}：不是合法的 JSON 文件`);
  }
}
