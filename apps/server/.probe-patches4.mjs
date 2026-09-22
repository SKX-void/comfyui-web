// 实验 4：真实时序矩阵（决定最终实现）
//   A 改统一地址（换 patches）      → 跟随的插件拿到新值、文件保持干净、只有受影响的插件重载？
//   B 用户给某插件填了自定地址      → 该行的兜底补丁撤掉后，文件值说了算
//   C 用户把地址填回空（重新跟随）  → 再挂上补丁，拿到当前统一地址
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import Include from '@cordisjs/plugin-include';

const dir = path.join(process.cwd(), '.probe');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'probe-plugin.mjs'),
  'export const name = "probe";\nlet n = 0;\nexport function apply(ctx, config) { n += 1; void ctx; void config; }\n',
);
const manifest = path.join(dir, 'plugins.yml');
const fileUrl = pathToFileURL(manifest).href;
// 留空 = 跟随统一地址；填了 = 自定
let rows = [
  { id: 'p1', url: '' },
  { id: 'p2', url: 'http://own:1' },
];
const writeRows = () =>
  fs.writeFileSync(
    manifest,
    rows.map((r) => `- id: ${r.id}\n  name: ./probe-plugin.mjs\n  config:\n    url: "${r.url}"\n`).join(''),
  );
writeRows();

const ctx = new Context();
ctx.baseUrl = pathToFileURL(dir).href + '/';
await ctx.plugin(Loader);
ctx.loader.builtins.include = Include;

/** 宿主解析：留空 + 全局有值 → 注入 */
let globalUrl = 'HOST-A';
const patchesFor = () => rows.filter((r) => r.url === '').map((r) => ({ id: r.id, config: { url: globalUrl } }));

await ctx.loader.create({ name: 'cordis:include', config: { path: fileUrl, patches: patchesFor() } });
await ctx.loader.await();

const entries = () => [...ctx.loader.entries()];
const includeEntry = () => entries().find((e) => e.options.name === 'cordis:include');
const find = (id) => entries().find((e) => e.id.includes(id));
const cfg = (id) => JSON.stringify(find(id)?.options.config);
const fileUrls = () => [...fs.readFileSync(manifest, 'utf8').matchAll(/url: (.+)/g)].map((m) => m[1]);

/** 宿主改统一地址：换 patches */
async function setGlobal(url) {
  globalUrl = url;
  await ctx.loader.update(includeEntry().id, { config: { path: fileUrl, patches: patchesFor() } });
  await ctx.loader.await();
  await new Promise((r) => setTimeout(r, 250));
}

/** 用户在设置页保存某插件：文件先改，再让 Loader 读这行 */
async function savePlugin(id, url) {
  rows = rows.map((r) => (r.id === id ? { ...r, url } : r));
  writeRows();
  await ctx.loader.update(includeEntry().id, { config: { path: fileUrl, patches: patchesFor() } });
  await ctx.loader.await();
  await new Promise((r) => setTimeout(r, 250));
}

const p2Fiber0 = find('p2')?.fiber;
console.log('基线          p1=' + cfg('p1'), 'p2=' + cfg('p2'), '文件=' + JSON.stringify(fileUrls()));

console.log('\nA 统一地址改成 HOST-B');
await setGlobal('HOST-B');
console.log('  p1=' + cfg('p1'), '| 文件=' + JSON.stringify(fileUrls()));
console.log('  p2 的 fiber 未被换掉:', find('p2')?.fiber === p2Fiber0);

console.log('\nB 用户给 p1 填自定 http://mine:9');
await savePlugin('p1', 'http://mine:9');
console.log('  p1=' + cfg('p1'), '| 文件=' + JSON.stringify(fileUrls()));

console.log('\nC 统一地址再改成 HOST-C（p1 自定，不该被覆盖）');
await setGlobal('HOST-C');
console.log('  p1=' + cfg('p1'), '| 文件=' + JSON.stringify(fileUrls()));

console.log('\nD 用户把 p1 清空（重新跟随）');
await savePlugin('p1', '');
console.log('  p1=' + cfg('p1'), '| 文件=' + JSON.stringify(fileUrls()));
process.exit(0);
