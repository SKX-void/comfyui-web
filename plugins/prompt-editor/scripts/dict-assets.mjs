#!/usr/bin/env node
/**
 * prompt-editor 两份大资产（机翻词库 / 共现表）的"明文 ↔ .gz"约定。
 *
 * git 里**只存 `.gz`**（6.2MB / 0.67MB 普通 blob）：压缩后是二进制，git 不再显示 diff；
 * 而且普通 blob 跟 git 对象一起走 SSH —— 不受 git-lfs 那条 HTTP 通道（外网域名 ~100KB/s、
 * 单连接 ~100s 上限，12.6MB 那份永远传不完）的约束。判据仍是"生成物不该有 diff"，不是大小。
 *
 * 明文是**本地工作副本**（.gitignore）：开发时要能直接用编辑器看/改，所以留一份解压出来的。
 * 规则：**明文优先，没有就解压 .gz** —— 新克隆/CI 只有 .gz 也能跑（构建与契约测试都不必先 unpack）。
 *
 * 命令（根目录）：pnpm dict:unpack / dict:pack / dict:check
 * 小资产（weilin-zh.csv / block-library.json / 存档.json）不压缩，明文入库。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const pluginDir = fileURLToPath(new URL('..', import.meta.url));
export const assetsDir = path.join(pluginDir, 'assets');

/** 走 .gz 的资产（顺序即 unpack/pack/check 的处理顺序） */
export const GZ_ASSETS = ['danbooru-zh.csv', 'cooccur.tsv'];

/** 不写时间戳、不写文件名 → 同一输入永远同一字节（否则每次 pack 都产生假 diff） */
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });
const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file));

/** 明文优先；null = 两样都没有 */
export function readAsset(name) {
  const plain = path.join(assetsDir, name);
  if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8');
  const gz = `${plain}.gz`;
  return fs.existsSync(gz) ? gunzip(gz).toString('utf8') : null;
}

/** 任意路径的"明文或同名 .gz"（build-dict / build-weilin 的 --hot 用，可指向 assets 之外） */
export function readTextOrGz(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const gz = `${file}.gz`;
  return fs.existsSync(gz) ? gunzip(gz).toString('utf8') : null;
}

/** 明文 + 同名 .gz 一起写（build-dict 重新生成资产时调）；返回明文字节数 */
export function writeAssetPair(name, text, outDir = assetsDir) {
  const buf = Buffer.from(text, 'utf8');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), buf);
  fs.writeFileSync(path.join(outDir, `${name}.gz`), gzip(buf));
  return buf.length;
}

/**
 * 产物里运行期读的是明文（`server/tagcsv.ts` 按 import.meta.url 找 assets/*.csv）：
 * 把 .gz 解压进产物目录并删掉 .gz —— 产物不需要它，6.2MB 别跟着进 tabs/ 和 dist/。
 */
export function unpackInto(destDir) {
  let done = 0;
  for (const name of GZ_ASSETS) {
    const gz = path.join(destDir, `${name}.gz`);
    if (!fs.existsSync(gz)) continue;
    fs.writeFileSync(path.join(destDir, name), gunzip(gz));
    fs.rmSync(gz);
    done += 1;
  }
  return done;
}

/** 每份资产的三种状态；明文不在时 same = null（新克隆态，正常） */
export function inspectAssets(dir = assetsDir) {
  return GZ_ASSETS.map((name) => {
    const plain = path.join(dir, name);
    const gz = `${plain}.gz`;
    const hasPlain = fs.existsSync(plain);
    const hasGz = fs.existsSync(gz);
    const same = hasPlain && hasGz ? fs.readFileSync(plain).equals(gunzip(gz)) : null;
    return { name, plain, gz, hasPlain, hasGz, same };
  });
}

function cli(argv) {
  const cmd = argv[0] ?? 'check';
  if (cmd === 'unpack') {
    for (const name of GZ_ASSETS) {
      const gz = path.join(assetsDir, `${name}.gz`);
      const plain = path.join(assetsDir, name);
      if (!fs.existsSync(gz)) {
        console.log(`跳过 ${name}：没有 ${name}.gz`);
        continue;
      }
      fs.writeFileSync(plain, gunzip(gz));
      console.log(`解出 ${name}  ${fs.statSync(plain).size} B（明文不入库，改完跑 pnpm dict:pack）`);
    }
    return 0;
  }
  if (cmd === 'pack') {
    for (const name of GZ_ASSETS) {
      const plain = path.join(assetsDir, name);
      if (!fs.existsSync(plain)) {
        console.log(`跳过 ${name}：没有明文（先 pnpm dict:unpack）`);
        continue;
      }
      const buf = fs.readFileSync(plain);
      fs.writeFileSync(`${plain}.gz`, gzip(buf));
      console.log(`压好 ${name}.gz  ${buf.length} → ${fs.statSync(`${plain}.gz`).size} B`);
    }
    return 0;
  }
  if (cmd !== 'check') {
    console.error(`未知子命令：${cmd}（unpack / pack / check）`);
    return 2;
  }
  let bad = 0;
  for (const one of inspectAssets()) {
    if (!one.hasGz) {
      console.log(`✘ ${one.name}：缺 ${one.name}.gz（git 里存的就是它）`);
      bad += 1;
    } else if (one.same === false) {
      console.log(`✘ ${one.name}：明文与 .gz 不一致 —— 改了明文要跑 pnpm dict:pack`);
      bad += 1;
    } else {
      console.log(`✔ ${one.name}：${one.hasPlain ? '明文与 .gz 一致' : '只有 .gz（新克隆态，正常）'}`);
    }
  }
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(cli(process.argv.slice(2)));
