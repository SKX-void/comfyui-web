// 一次性实验：Include 的 patches 会不会被写回 plugins.yml？
// 结论决定实现方式：不会 → 可以在启动时用 patch 注入兜底值；会 → 得换方案。
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
const rows = (values) =>
  values
    .map((v) => `- id: ${v.id}\n  name: ./probe-plugin.mjs\n  config:\n    url: "${v.url}"\n`)
    .join('');
fs.writeFileSync(manifest, rows([{ id: 'p1', url: '' }, { id: 'p2', url: 'http://own:1' }]));

const ctx = new Context();
ctx.baseUrl = pathToFileURL(dir).href + '/';
await ctx.plugin(Loader);
ctx.loader.builtins.include = Include;
await ctx.loader.create({
  name: 'cordis:include',
  config: {
    path: pathToFileURL(manifest).href,
    // 模拟宿主注入：p1 的 url 留空 → 用统一地址顶上
    patches: [{ id: 'p1', config: { url: 'INJECTED-HOST-VALUE' } }],
  },
});
await ctx.loader.await();

const find = (id) => [...ctx.loader.entries()].find((e) => e.id.includes(id));
console.log('入口 id 一览:', [...ctx.loader.entries()].map((e) => e.id).join(' | '));
console.log('1) p1 实际拿到的 config :', JSON.stringify(find('p1')?.options.config));
console.log('2) 挂载后文件仍是原样   :', JSON.stringify(fs.readFileSync(manifest, 'utf8')));

// 模拟"设置页保存另一个插件"→ Loader → Include 整体 dump
await ctx.loader.update(find('p2').id, { config: { url: 'http://changed:2' } });
await ctx.loader.await();
await new Promise((resolve) => setTimeout(resolve, 300));
console.log('3) 保存 p2 之后文件内容 :\n' + fs.readFileSync(manifest, 'utf8'));
console.log('4) p1 现在拿到的 config :', JSON.stringify(find('p1')?.options.config));
process.exit(0);
