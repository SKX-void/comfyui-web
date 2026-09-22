// 实验 6：把最终的保存时序跑一遍（先摘补丁 → 写用户值 → 重算补丁）
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
  'export const name = "probe";\nexport function apply(ctx, config) { void ctx; void config; }\n',
);
const manifest = path.join(dir, 'plugins.yml');
const fileUrl = pathToFileURL(manifest).href;
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

let globalUrl = 'HOST-A';
/** 宿主解析：留空 + 全局有值 → 这一行挂兜底补丁 */
const patches = () => rows.filter((r) => r.url === '').map((r) => ({ id: r.id, config: { url: globalUrl } }));

await ctx.loader.create({ name: 'cordis:include', config: { path: fileUrl, patches: patches() } });
await ctx.loader.await();

const entries = () => [...ctx.loader.entries()];
const includeEntry = () => entries().find((e) => e.options.name === 'cordis:include');
const rowOf = (id) => entries().find((e) => e.id.endsWith(':' + id));
const cfg = (id) => JSON.stringify(rowOf(id)?.options.config);
const fileUrls = () => [...fs.readFileSync(manifest, 'utf8').matchAll(/url: (.+)/g)].map((m) => m[1]).join(',');
const wait = () => new Promise((r) => setTimeout(r, 250));
const applyPatches = async (next) => {
  await ctx.loader.update(includeEntry().id, { config: { path: fileUrl, patches: next } });
  await ctx.loader.await();
  await wait();
};

/** 统一地址变化 */
async function setGlobal(url) {
  globalUrl = url;
  await applyPatches(patches());
}

/** 设置页保存：先摘这一行的补丁 → 写用户值（落盘）→ 按新值重算全部补丁 */
async function save(id, url) {
  await applyPatches(patches().filter((p) => p.id !== id));
  rows = rows.map((r) => (r.id === id ? { ...r, url } : r));
  await ctx.loader.update(rowOf(id).id, { config: { url } });
  await ctx.loader.await();
  await wait();
  await applyPatches(patches());
}

const p2f0 = rowOf('p2')?.fiber;
console.log('基线                p1=' + cfg('p1'), '文件=' + fileUrls());

await save('p1', 'http://mine:9');
console.log('S1 存自定 mine:9    p1=' + cfg('p1'), '文件=' + fileUrls());

await setGlobal('HOST-B');
console.log('S2 统一改成 HOST-B  p1=' + cfg('p1'), '（自定不被覆盖）文件=' + fileUrls());

await save('p1', '');
console.log('S3 清空=重新跟随    p1=' + cfg('p1'), '文件=' + fileUrls());

await setGlobal('HOST-C');
console.log('S4 统一改成 HOST-C  p1=' + cfg('p1'), '文件=' + fileUrls(), '| p2 fiber 未动:', rowOf('p2')?.fiber === p2f0);

await save('p2', '');
console.log('S5 p2 也改成跟随    p1=' + cfg('p1'), 'p2=' + cfg('p2'), '文件=' + fileUrls());
process.exit(0);
