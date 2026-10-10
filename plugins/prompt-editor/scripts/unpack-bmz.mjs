/**
 * 解开第三方词库包（`词库.bmz`）→ 5 个原始层，供 `scripts/build-dict.ts` 预处理。
 *
 * 词库包不是标准格式，7z / unzip 都打不开（这是它故意的：内嵌口令只是为了挡网盘扫描，
 * 不是安全边界 —— 口令就在它自带的那个单文件 HTML 工具里）。格式逆向自那个 HTML：
 *
 *   `BMZ1`(4B) + salt(16B) + iv(12B) + AES-256-GCM 密文（authTag = 密文末 16B）
 *   key = PBKDF2-SHA256(口令, salt, 120000 轮, 32B)
 *   明文 = gzip → 重复的 [u16le 名字长][名字][u32le 数据长][数据]
 *
 * 用法：
 *   node plugins/prompt-editor/scripts/unpack-bmz.mjs <词库.bmz> [输出目录=.cache/dictpack]
 *
 * 输出**不要**放进 `plugins/prompt-editor/assets/`：`pack.mjs` 的 extras 是整个 `assets/` 目录，
 * 15MB 会跟着进 `tabs/` 和 `dist/`。默认落到仓库根的 `.cache/`（git 不跟踪）。
 *
 * 实测（2026-10 那份包）：解出 danbooru_tags.txt / 标签分类.tsv / 机翻词表.tsv / 共现邻居.tsv /
 * 手动翻译.tsv，与那个 HTML 工具导出的同一份逐字节相同。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/** 包内嵌的口令：挡网盘扫描用的，不是密钥管理 */
const PASSWORD = 'bmz-dict-pack-2026-9f3c1a7e5b2d8046c1afe37b95';

const [src = '', outArg = ''] = process.argv.slice(2);
if (src === '' || !fs.existsSync(src)) {
  console.error('用法：node plugins/prompt-editor/scripts/unpack-bmz.mjs <词库.bmz> [输出目录]');
  process.exit(1);
}
const outDir = outArg === '' ? fileURLToPath(new URL('../../../.cache/dictpack', import.meta.url)) : path.resolve(outArg);

const buf = fs.readFileSync(src);
if (buf.subarray(0, 4).toString('latin1') !== 'BMZ1') {
  console.error(`${src} 不是 BMZ1 词库包`);
  process.exit(1);
}
const salt = buf.subarray(4, 20);
const iv = buf.subarray(20, 32);
const cipher = buf.subarray(32);
const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.pbkdf2Sync(PASSWORD, salt, 120000, 32, 'sha256'), iv);
decipher.setAuthTag(cipher.subarray(cipher.length - 16));
const raw = zlib.gunzipSync(Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]));

fs.mkdirSync(outDir, { recursive: true });
const layers: { name: string; bytes: number; lines: number }[] = [];
for (let at = 0; at + 2 <= raw.length; ) {
  const nameLength = raw.readUInt16LE(at);
  const name = raw.subarray(at + 2, at + 2 + nameLength).toString('utf8');
  const dataLength = raw.readUInt32LE(at + 2 + nameLength);
  const text = raw.subarray(at + 6 + nameLength, at + 6 + nameLength + dataLength).toString('utf8');
  at += 6 + nameLength + dataLength;
  fs.writeFileSync(path.join(outDir, name), text);
  layers.push({ name, bytes: Buffer.byteLength(text), lines: text.split('\n').length });
}
console.log(JSON.stringify({ out: outDir, layers }, null, 1));
