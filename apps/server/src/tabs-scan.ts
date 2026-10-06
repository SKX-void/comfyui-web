import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

import {
  resolvePluginPackage,
  SUPPORTED_CONTRACT,
  type ResolvedPluginPackage,
} from './plugin-package.js';
import { message } from './util.js';

/** 目录名即 id：它同时决定路由前缀（/api/p/<id>）与前端资源前缀（/plugins/<id>/） */
const TAB_ID_RE = /^[a-z][a-z0-9_-]*$/;

export interface ScannedTab {
  id: string;
  dir: string;
  /** 服务端入口绝对路径；`problem` 存在时它可能并不存在 */
  entry: string;
  pkg?: ResolvedPluginPackage;
  /** 不能加载的原因：这一行仍会以 disabled 挂上，好让设置页把原因显示出来 */
  problem?: string;
  /**
   * 目录内容指纹（相对路径 + 大小 + mtime）。变了就说明**代码变了**，
   * 需要卸载后用带 cache-buster 的新说明符重挂（Node 的 ESM 缓存按 URL 记）。
   */
  fingerprint: string;
}

/**
 * 扫 `<tabsDir>` 下的子目录。
 *
 * 坏目录不抛异常、也不消失，而是带着 `problem` 回来：它仍会以 disabled 挂上，
 * 清单页把原因显示出来，运维看得见才有得修。
 */
export function scanTabs(tabsDir: string, logger?: Logger): ScannedTab[] {
  if (!fs.existsSync(tabsDir)) return [];

  const tabs: ScannedTab[] = [];
  const broken: Array<{ id: string; problem: string }> = [];

  for (const dirent of fs.readdirSync(tabsDir, { withFileTypes: true })) {
    // `.` / `_` 前缀留给草稿与备注；只认目录
    if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name.startsWith('_')) continue;

    const id = dirent.name;
    const dir = path.join(tabsDir, id);
    const fallbackEntry = path.join(dir, 'server.js');
    const fingerprint = fingerprintDir(dir);
    const bad = (problem: string, entry = fallbackEntry): void => {
      tabs.push({ id, dir, entry, problem, fingerprint });
      broken.push({ id, problem });
    };

    if (!TAB_ID_RE.test(id)) {
      bad(`目录名非法：必须小写字母开头、只含 [a-z0-9_-]`);
      continue;
    }

    const pkgJson = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      bad('缺少 package.json（manifest 与入口都写在里面）');
      continue;
    }

    let main = 'server.js';
    try {
      const raw = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { main?: unknown };
      if (typeof raw.main === 'string' && raw.main !== '') main = raw.main;
    } catch (err) {
      bad(`package.json 解析失败：${message(err)}`);
      continue;
    }

    const entry = path.resolve(dir, main);
    if (!fs.existsSync(entry)) {
      bad(`入口不存在：${main}`, entry);
      continue;
    }

    // 解析基准是这一格 tab 目录本身（入口是绝对路径，baseDir 只兜相对路径/裸包名）
    const pkg = resolvePluginPackage(entry, dir);
    if (pkg === undefined) {
      bad('解析不到 manifest（package.json 缺 plugin 段？）', entry);
      continue;
    }

    const contract = pkg.manifest.contract;
    if (contract !== undefined && contract !== SUPPORTED_CONTRACT) {
      bad(`契约版本不符：声明 contract=${String(contract)}，宿主支持 ${SUPPORTED_CONTRACT}`, entry);
      continue;
    }

    tabs.push({ id, dir, entry, pkg, fingerprint });
  }

  tabs.sort((a, b) => a.id.localeCompare(b.id));
  if (logger !== undefined && broken.length > 0) {
    logger.warn({ broken }, '有 tab 目录没通过检查（仍会以禁用状态出现在清单里）');
  }
  return tabs;
}

/**
 * 目录内容指纹：任一文件的相对路径 / 大小 / mtime 变了它就变。
 *
 * 用它而不是"看文件事件报的名字"，是为了对**编辑器写盘方式**不敏感
 * （直接写 vs 临时文件 + rename 都只是 mtime 变化），也顺手挡掉"事件到了但内容没变"的空重扫。
 * 排除 `.` 前缀与 `node_modules`：前者是草稿，后者按约定不该存在。
 */
function fingerprintDir(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        const stat = fs.statSync(abs);
        parts.push(`${path.relative(dir, abs)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      } catch {
        // 扫描途中文件消失：忽略，下一次重扫会看到
      }
    }
  };
  walk(dir);
  return parts.join('|');
}
