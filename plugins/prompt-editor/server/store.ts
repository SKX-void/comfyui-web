/**
 * 落盘：整文件 JSON + 原子替换（存储形态自管 —— 核不参与、不迁移、不清理）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 读 JSON；不存在 / 读坏了都退化成 fallback：这里没有"必须炸"的理由，坏文件不该让 tab 起不来 */
export function readJson(file: string, fallback: null): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 先写临时文件再 rename：进程在写一半时被杀，旧文件仍然完整 */
export function writeJson(file: string, value: unknown): void {
  // 目录可能被人手动删掉（docs/config.md 就把"删掉＝回到默认"写成用法）——
  // 不补建的话运行期每次写都是 500，得重挂插件才好
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}
