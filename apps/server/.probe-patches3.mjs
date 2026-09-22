// 实验 3：运行期怎么让"新的兜底值"生效？
//   E3a: update(include, {config}) 之后，include 自己的 options.config.patches 有没有换掉？
//   E3b: 再 toggle 一次 include（disabled:true → false）能否让它重新挂载并应用新补丁？
//   E3c: 未受影响的另一个插件（p2）是否被保留（不重新激活）？
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
  'export const name = "probe";\nlet n = 0;\nexport function apply(ctx, config) { n += 1; ctx.logger.info("activated #%d", n); void config; }\n',
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
  config: { path: pathToFileURL(manifest).href, patches: [{ id: 'p1', config: { url: 'HOST-A' } }] },
});
await ctx.loader.await();

const entries = () => [...ctx.loader.entries()];
const includeEntry = () => entries().find((e) => e.options.name === 'cordis:include');
const find = (id) => entries().find((e) => e.id.includes(id));
const p1cfg = () => JSON.stringify(find('p1')?.options.config);
const fiberOf = (id) => find(id)?.fiber;

const before = { p2: fiberOf('p2') };
console.log('基线 p1=', p1cfg());

// E3a：换 patches（带完整 config）
await ctx.loader.update(includeEntry().id, {
  config: {
    path: pathToFileURL(manifest).href,
    patches: [{ id: 'p1', config: { url: 'HOST-B' } }],
  },
});
await ctx.loader.await();
await new Promise((r) => setTimeout(r, 200));
console.log('E3a include.options.config.patches =', JSON.stringify(includeEntry()?.options.config?.patches));
console.log('E3a p1 =', p1cfg(), '（没变说明 update 不重挂）');

// E3b：toggle include
await ctx.loader.update(includeEntry().id, { disabled: true });
await ctx.loader.await();
await new Promise((r) => setTimeout(r, 200));
await ctx.loader.update(includeEntry().id, { disabled: false });
await ctx.loader.await();
await new Promise((r) => setTimeout(r, 300));
console.log('E3b p1 =', p1cfg());
console.log('E3b 文件 urls:', [...fs.readFileSync(manifest, 'utf8').matchAll(/url: (.+)/g)].map((m) => m[1]).join(' , '));
console.log('E3c p2 的 fiber 是否还是原来那个:', fiberOf('p2') === before.p2, '| state=', fiberOf('p2')?.state);
process.exit(0);
