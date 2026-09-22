// 实验 5：补丁还在的时候写用户值，会落到文件还是被补丁吃掉？
//   1 直接 update 被补丁盖住的那一行（用户填了自定值）
//   2 先撤掉补丁，再刷新
//   3 撤掉补丁后写用户值
//   4 再挂上补丁 + 把用户值写回空（= 用户改成"跟随"）
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
fs.writeFileSync(manifest, '- id: p1\n  name: ./probe-plugin.mjs\n  config:\n    url: ""\n');

const ctx = new Context();
ctx.baseUrl = pathToFileURL(dir).href + '/';
await ctx.plugin(Loader);
ctx.loader.builtins.include = Include;
await ctx.loader.create({
  name: 'cordis:include',
  config: { path: fileUrl, patches: [{ id: 'p1', config: { url: 'HOST-A' } }] },
});
await ctx.loader.await();

const entries = () => [...ctx.loader.entries()];
const includeEntry = () => entries().find((e) => e.options.name === 'cordis:include');
const row = () => entries().find((e) => e.id.endsWith(':p1'));
const cfg = () => JSON.stringify(row()?.options.config);
const fileUrl2 = () => [...fs.readFileSync(manifest, 'utf8').matchAll(/url: (.+)/g)].map((m) => m[1]).join(',');

const wait = () => new Promise((r) => setTimeout(r, 250));
const setPatches = async (patches) => {
  await ctx.loader.update(includeEntry().id, { config: { path: fileUrl, patches } });
  await ctx.loader.await();
  await wait();
};
const saveRow = async (url) => {
  await ctx.loader.update(row().id, { config: { url } });
  await ctx.loader.await();
  await wait();
};

console.log('基线（补丁 HOST-A，文件空）        p1=' + cfg(), '文件=' + fileUrl2());

await saveRow('USER-DIRECT');
console.log('1 补丁还在时写 USER-DIRECT        p1=' + cfg(), '文件=' + fileUrl2());

await setPatches([]);
console.log('2 撤掉补丁后                      p1=' + cfg(), '文件=' + fileUrl2());

await saveRow('USER-AFTER-UNPATCH');
console.log('3 撤补丁后写 USER-AFTER-UNPATCH   p1=' + cfg(), '文件=' + fileUrl2());

await setPatches([{ id: 'p1', config: { url: 'HOST-D' } }]);
await saveRow('');
console.log('4 挂上 HOST-D 后写空              p1=' + cfg(), '文件=' + fileUrl2());
process.exit(0);
