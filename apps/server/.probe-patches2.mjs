// 实验 2：运行期怎么改兜底值才既生效又不污染文件？
//   E1: ctx.loader.update(插件行, { config }) —— 设置页保存走的就是这条（用户值，应该落盘）
//   E2: ctx.loader.update(include 行, { patches }) —— 宿主改兜底值想走这条（应该只改内存）
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
fs.writeFileSync(
  manifest,
  '- id: p1\n  name: ./probe-plugin.mjs\n  config:\n    url: ""\n' +
    '- id: p2\n  name: ./probe-plugin.mjs\n  config:\n    url: http://own:1\n',
);

const ctx = new Context();
ctx.baseUrl = pathToFileURL(dir).href + '/';
await ctx.plugin(Loader);
ctx.loader.builtins.include = Include;
await ctx.loader.create({
  name: 'cordis:include',
  config: {
    path: pathToFileURL(manifest).href,
    patches: [{ id: 'p1', config: { url: 'HOST-A' } }],
  },
});
await ctx.loader.await();

const includeEntry = () => [...ctx.loader.entries()].find((e) => e.options.name === 'cordis:include');
const find = (id) => [...ctx.loader.entries()].find((e) => e.id.includes(id));
const p1 = () => JSON.stringify(find('p1')?.options.config);
const file = () => fs.readFileSync(manifest, 'utf8');

console.log('基线            p1=', p1());
console.log('基线            文件 urls:', [...file().matchAll(/url: (.+)/g)].map((m) => m[1]).join(' , '));

// E1：像设置页那样直接改插件行（用户填的值，本来就该落盘）
await ctx.loader.update(find('p2').id, { config: { url: 'USER-TYPED' } });
await ctx.loader.await();
await new Promise((r) => setTimeout(r, 200));
console.log('\nE1 改 p2（用户值）→ p2=', JSON.stringify(find('p2')?.options.config));
console.log('E1 改 p2（用户值）→ 文件 urls:', [...file().matchAll(/url: (.+)/g)].map((m) => m[1]).join(' , '));
console.log('E1 之后 p1 仍=', p1());

// E2：宿主改统一地址 → 只动 include 的 patches
await ctx.loader.update(includeEntry().id, {
  path: pathToFileURL(manifest).href,
  patches: [{ id: 'p1', config: { url: 'HOST-B' } }],
});
await ctx.loader.await();
await new Promise((r) => setTimeout(r, 200));
console.log('\nE2 改 patches → p1=', p1());
console.log('E2 改 patches → 文件 urls:', [...file().matchAll(/url: (.+)/g)].map((m) => m[1]).join(' , '));
console.log('E2 之后 p1 是否被重新激活（fiber.state 2=active）:', find('p1')?.fiber?.state);
process.exit(0);
