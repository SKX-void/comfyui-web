/**
 * 依赖清单生成器。
 *
 * 从工作流声明（`assets/form.json` 的 `requirements`）生成两份**给人看**
 * 的文件，避免"声明一处、文档另一处"再次漂移：
 *
 *   readme.md   ← 纯清单：装什么、去哪装（使用者核对安装情况的第一入口）
 *                 **只替换 `<!-- deps:start -->` … `<!-- deps:end -->` 之间**，
 *                 标记外的内容（标题、人工补充说明）不动 —— 它同时是界面"帮助"面板的真源。
 *   README.md   ← `<!-- deps:start -->` … `<!-- deps:end -->` 之间的表格
 *
 * 包名与地址**由模板手写**、不查 ComfyUI-Manager：它的"类 → 包"推测会猜错，
 * 而且不在 Manager 上的包（例如 WeiLin）根本查不到 —— 作者本来就知道自己用的是哪个仓库。
 * 详见 `plugins/anima-plus/README.md`「依赖声明与检查」；来龙去脉见 `docs/archive/v2-implementation-notes.md` §14.1f。
 *
 * 用法：
 *   node scripts/gen-deps.mjs           # 写入两份文件
 *   node scripts/gen-deps.mjs --check   # 只校验（契约测试用，不一致就退出 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const FORM = path.join(PKG, 'assets', 'form.json');
const README = path.join(PKG, 'README.md');
const PLAIN = path.join(PKG, 'readme.md');
const MARK_START = '<!-- deps:start';
const MARK_END = '<!-- deps:end -->';

/** 工作流（唯一一份）的依赖声明 */
export function collectDeps() {
  const packs = new Map();
  const builtin = new Set();
  const def = JSON.parse(fs.readFileSync(FORM, 'utf8'));
  const req = def.requirements ?? {};
  for (const cls of req.builtin ?? []) builtin.add(cls);
  for (const pack of req.packs ?? []) {
    packs.set(pack.name, { ...pack, provides: [...pack.provides] });
  }
  return { packs: [...packs.values()], builtin: [...builtin].sort() };
}

/** readme.md 里那段的正文：使用者拿去核对安装情况的清单 */
export function renderPlainBody(packs, builtin) {
  const lines = [];
  for (const pack of packs) {
    const tag = pack.optional === true ? '（可选）' : '';
    lines.push(`- [${pack.name}](${pack.url})${tag} — ${pack.provides.join('、')}`);
  }
  lines.push('');
  lines.push(`其中 ComfyUI 自带（缺了说明 ComfyUI 版本太老，装插件包没用）：${builtin.join('、')}`);
  return lines.join('\n');
}

/** README.md 里那段的正文（不含标记行） */
export function renderBlockBody(packs, builtin) {
  const lines = [
    '依赖 ComfyUI 上装好这些自定义节点包。**地址由模板声明手写**（不用 ComfyUI-Manager 的',
    '推测 —— 它会猜错，且不在 Manager 上的包查不到），机器可读清单见',
    '[`readme.md`](./readme.md)，两者都由 `scripts/gen-deps.mjs` 从声明生成。',
    '',
    '插件启动后拿 `/object_info` 对一遍：缺哪个节点、出自哪个包、去哪装，界面直接给出来，',
    '缺依赖时还会拦住生成（不至于提交后才从 ComfyUI 拿到一句 node type not exist）。',
    '',
    '| 节点包 | 提供的节点 | 安装地址 |',
    '| --- | --- | --- |',
  ];
  for (const pack of packs) {
    const name = pack.optional === true ? `${pack.name}（可选）` : pack.name;
    lines.push(
      `| ${name} | ${pack.provides.map((c) => `\`${c}\``).join('、')} | <${pack.url}> |`,
    );
  }
  lines.push('');
  lines.push(
    `ComfyUI 自带（缺了说明版本太老，装插件包解决不了）：${builtin.map((c) => `\`${c}\``).join('、')}。`,
  );
  return lines.join('\n');
}

/** 把文本里 `<!-- deps:start … -->` 与 `<!-- deps:end -->` 之间换成新正文 */
export function replaceBlock(text, body) {
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md 里找不到 ${MARK_START} … ${MARK_END} 标记`);
  }
  const head = text.slice(0, start);
  const startLineEnd = text.indexOf('\n', start);
  const startLine = text.slice(start, startLineEnd === -1 ? undefined : startLineEnd);
  return `${head}${startLine}\n${body}\n${text.slice(end)}`;
}

/** 两份文件与声明是否一致（契约测试用） */
export function compareDocs() {
  const { packs, builtin } = collectDeps();
  const readme = fs.readFileSync(README, 'utf8');
  const plain = fs.readFileSync(PLAIN, 'utf8');
  return [
    { file: PLAIN, ok: plain === replaceBlock(plain, renderPlainBody(packs, builtin)) },
    { file: README, ok: readme === replaceBlock(readme, renderBlockBody(packs, builtin)) },
  ];
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { packs, builtin } = collectDeps();
  const plain = fs.readFileSync(PLAIN, 'utf8');
  const nextPlain = replaceBlock(plain, renderPlainBody(packs, builtin));
  const readme = fs.readFileSync(README, 'utf8');
  const next = replaceBlock(readme, renderBlockBody(packs, builtin));

  if (process.argv.includes('--check')) {
    const stale = [
      ...(plain === nextPlain ? [] : [PLAIN]),
      ...(readme === next ? [] : [README]),
    ];
    if (stale.length > 0) {
      console.error(`❌ 依赖清单与声明不一致：${stale.map((f) => path.relative(PKG, f)).join('、')}`);
      console.error('   跑 node scripts/gen-deps.mjs（或 pnpm deps:sync）重新生成。');
      process.exit(1);
    }
    console.log(`✅ 依赖清单与声明一致（${packs.length} 个包 / ${builtin.length} 个内置节点）`);
  } else {
    fs.writeFileSync(PLAIN, nextPlain);
    fs.writeFileSync(README, next);
    console.log(`✔ 已生成 readme.md 与 README.md 的依赖段（${packs.length} 个包 / ${builtin.length} 个内置节点）`);
  }
}
