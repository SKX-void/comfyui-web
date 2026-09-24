#!/usr/bin/env node
/**
 * 插件 CLI —— profile 的包管理器外壳。
 *
 * 设计要点（docs/architecture.md §6「清单与配置分层」）：
 *   - **不重新发明包管理**：安装/卸载直接转调 profile 目录里的 pnpm；
 *   - 清单 plugins.yml 是唯一真源，CLI 只负责增删行；**它不入库**（本机部署状态），
 *     入库的是 `plugin snapshot` 生成的 plugins.example.yml 模板；
 *   - 宿主的产物与插件无关，所以增删插件**只需要重启宿主**，不需要重新构建。
 *
 * 用法：
 *   node apps/server/scripts/plugin.mjs list
 *   node apps/server/scripts/plugin.mjs add ./plugins/anima-example --id anima-example
 *   node apps/server/scripts/plugin.mjs remove anima-example   # 会问是否连数据一起删
 *   node apps/server/scripts/plugin.mjs enable|disable <id>
 *   node apps/server/scripts/plugin.mjs snapshot   # 清单 → plugins.example.yml（剥掉部署值）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import yaml from 'js-yaml';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? 'list';
const profile = typeof flags.profile === 'string' ? flags.profile : 'default';
const profileDir = path.join(repoRoot, 'profiles', profile);
const manifestFile = path.join(profileDir, 'plugins.yml');

function die(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function readManifest() {
  if (!fs.existsSync(manifestFile)) return [];
  const data = yaml.load(fs.readFileSync(manifestFile, 'utf8'));
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) die(`${manifestFile} 的顶层必须是数组`);
  return data;
}

function writeManifest(rows) {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  // 注意：重写会丢掉注释。plugins.yml 请勿写注释（说明放 profiles/<name>/README.md）。
  fs.writeFileSync(manifestFile, yaml.dump(rows, { lineWidth: 120 }), 'utf8');
}

function resolvePackage(specifier) {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const abs = path.isAbsolute(specifier) ? specifier : path.resolve(profileDir, specifier);
    let dir = path.dirname(abs);
    for (;;) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
  const require = createRequire(path.join(profileDir, 'package.json'));
  try {
    return require(`${specifier}/package.json`);
  } catch {
    return undefined;
  }
}

/**
 * 输入说明符 → 写进 plugins.yml 的模块说明符。
 *
 * 关键：清单里的 name 必须是**从 profile 目录能解析到的东西**。
 * 所以本地路径插件要落成它的**包名**（`@comfyui-web/anima-example`，由 profile/node_modules 里的 link 解析），
 * 而不是 `./plugins/anima-example`（那是相对 CLI 的路径，宿主按 profile 目录解析会找不到）。
 */
function manifestNameFor(specifier) {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return specifier;
  const abs = path.isAbsolute(specifier) ? specifier : path.resolve(repoRoot, specifier);
  const pkgJson = path.join(abs, 'package.json');
  if (!fs.existsSync(pkgJson)) die(`${abs} 下没有 package.json，不是插件包`);
  const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  if (typeof parsed.name !== 'string' || parsed.name === '') {
    die(`${pkgJson} 缺少 name 字段：插件包必须有包名，清单才能解析它`);
  }
  return parsed.name;
}

function requireProfile() {
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    die(`profile 目录不存在或缺少 package.json：${profileDir}`);
  }
}

function pnpm(args) {
  console.log(`$ pnpm ${args.join(' ')}   (cwd=${profileDir})`);
  execFileSync('pnpm', args, { cwd: profileDir, stdio: 'inherit' });
}

function defaultId(specifier) {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    return path.basename(specifier.replace(/\/+$/, '')).replace(/^@/, '').replace(/\//g, '-');
  }
  const parts = specifier.split('/');
  return (parts.length > 1 && specifier.startsWith('@') ? parts[1] : parts[0]).replace(/^@/, '');
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.log('（非交互环境，默认保留）');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

/**
 * 空间目录规则必须与宿主的 `src/handles/space.ts` 一致：
 * 包名 → 目录名，只把作用域那一个斜杠换成 `+`（插件数据是插件的私有财产，
 * 核不解析里面的内容，所以"清数据"就是删这一个目录）。
 */
function spaceDirName(packageName) {
  return packageName.trim().replace('/', '+');
}

function spaceDir(packageName) {
  return path.join(repoRoot, 'data', 'plugins', spaceDirName(packageName));
}

async function dropPluginData(packageName) {
  const dir = spaceDir(packageName);
  if (!fs.existsSync(dir)) {
    console.log(`  （还没有空间目录 ${dir}）`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  已删除空间目录 ${dir}`);
}

// ---------------------------------------------------------------------------

if (command === 'list') {
  const rows = readManifest();
  console.log(`profile   ${profile}`);
  console.log(`清单      ${manifestFile}`);
  console.log(`插件目录  ${path.join(profileDir, 'node_modules')}`);
  console.log('');
  if (rows.length === 0) {
    console.log('（清单为空：还没有插件）');
  }
  for (const row of rows) {
    const pkg = resolvePackage(row.name);
    const state = pkg ? `${pkg.name}@${pkg.version ?? '?'}` : '❌ 未安装';
    const off = row.disabled === true ? ' [已禁用]' : '';
    console.log(`  ${row.id.padEnd(16)} ${row.name.padEnd(24)} ${state}${off}`);
  }
  process.exit(0);
}

if (command === 'add') {
  requireProfile();
  const specifier = positional[1] ?? flags.specifier;
  if (typeof specifier !== 'string') die('用法：add <包名或路径> [--id <id>]');
  const id = typeof flags.id === 'string' ? flags.id : defaultId(specifier);
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    die(`插件 id "${id}" 非法：必须小写字母开头、只含 [a-z0-9_-]（它决定路由前缀与表前缀）`);
  }
  const rows = readManifest();
  if (rows.some((row) => row.id === id)) die(`清单里已经有 id=${id} 的行`);

  // 仓库内的插件写**相对** link，不要写绝对路径：绝对路径会被"仓库改名/搬迁"打伤
  // （改过一次仓库名，三个 link 就全指向了不存在的目录，而 pnpm 因为缓存着旧映射
  // 当时没报错，下一次干净安装才会炸）。pnpm 内部本来也按相对路径落盘，
  // 见 profiles/<name>/pnpm-lock.yaml 里的 `version: link:../../plugins/anima-example`。
  const abs = path.resolve(repoRoot, specifier);
  const target = specifier.startsWith('.') || path.isAbsolute(specifier)
    ? `link:${abs.startsWith(repoRoot) ? path.relative(profileDir, abs) : abs}`
    : specifier;
  pnpm(['add', target]);

  const name = manifestNameFor(specifier);
  if (resolvePackage(name) === undefined) {
    console.warn(`⚠️  profile 里解析不到 "${name}"：宿主会拒绝加载这一行。`);
  }

  rows.push({ id, name });
  writeManifest(rows);
  console.log(`\n✅ 已在 ${manifestFile} 增加一行：id=${id} name=${name}`);
  console.log('   重启宿主后 tab 与路由会自动出现（不需要重新构建宿主）。');
  process.exit(0);
}

if (command === 'remove') {
  requireProfile();
  const id = positional[1];
  if (id === undefined) die('用法：remove <id> [--drop-data|--keep-data]');
  const rows = readManifest();
  const row = rows.find((item) => item.id === id);
  if (row === undefined) die(`清单里没有 id=${id}`);
  // 空间按**包名**分配（不是行 id），所以删数据要知道包名
  const packageName = typeof row.name === 'string' ? row.name : id;

  // 卸载决策（T4）：默认保留数据，删数据必须显式同意
  let drop = false;
  if (flags['drop-data'] === true) drop = true;
  else if (flags['keep-data'] === true) drop = false;
  else drop = await confirm(`要连数据一起删掉吗？（整个空间目录 ${spaceDir(packageName)}）`);

  if (drop) {
    console.log('删除插件数据：');
    await dropPluginData(packageName);
  } else {
    console.log(`保留插件数据（空间目录 ${spaceDir(packageName)} 不动）。`);
  }

  writeManifest(rows.filter((item) => item.id !== id));
  console.log(`已从 ${manifestFile} 移除 id=${id}`);
  if (typeof row.name === 'string' && !row.name.startsWith('.')) {
    pnpm(['remove', row.name]);
  }
  console.log('重启宿主后该 tab 会消失。');
  process.exit(0);
}

if (command === 'enable' || command === 'disable') {
  const id = positional[1];
  if (id === undefined) die(`用法：${command} <id>`);
  const rows = readManifest();
  const row = rows.find((item) => item.id === id);
  if (row === undefined) die(`清单里没有 id=${id}`);
  if (command === 'disable') row.disabled = true;
  else delete row.disabled;
  writeManifest(rows);
  console.log(`已${command === 'disable' ? '禁用' : '启用'} ${id}（重启宿主生效；运行期可用设置页切换）`);
  process.exit(0);
}

if (command === 'snapshot') {
  if (!fs.existsSync(manifestFile)) {
    die(`${manifestFile} 不存在：没有可快照的清单（先 pnpm plugin add <包>）`);
  }
  const rows = readManifest();
  for (const row of rows) {
    if (typeof row?.id !== 'string' || typeof row?.name !== 'string') {
      die('清单里有形状不对的行（缺 id 或 name）：先修好再快照，别把坏行写进模板');
    }
  }
  // 模板是**基线**，只保留"这个 profile 装了什么"：
  //   config   —— 每台机器一份的部署值（地址、并发…），设置页会往清单里写；
  //   disabled —— 这批部署的启停状态，运行期也能在设置页切换。
  // 两者都属于本机状态，剥掉才不会一提交就把某台机器的地址/开关带给别人。
  const baseline = rows.map((row) => ({ id: row.id, name: row.name }));
  const target = path.join(profileDir, 'plugins.example.yml');
  fs.writeFileSync(target, yaml.dump(baseline, { lineWidth: 120 }), 'utf8');
  console.log(`已写出模板 ${target}（${baseline.length} 行，不含 config/disabled）`);
  console.log('  它是入库的基线：新克隆/换机器时，宿主启动发现没有 plugins.yml 会从它复制一份。');
  process.exit(0);
}

die(`未知命令 "${command}"：可用 list / add / remove / enable / disable / snapshot`);
