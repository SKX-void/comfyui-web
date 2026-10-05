/**
 * 插件前端产物的契约测试 —— 没有浏览器时的替代验证。
 *
 * 它按宿主外壳消费插件的方式走一遍：
 *   1. 注入样式需要一个最小 document 桩，然后 `import(tabs/<id>/client.js)`
 *   2. 校验 default.tabs / default.routes 的形状（宿主就是照这个挂 tab 的）
 *   3. 校验「看得见的改动」真的进了**产物**（不是只改了源码）：
 *      LoRA 权重滑动条、历史记录去掉「模板」列、堵住固有最小宽度的 CSS 兜底
 *   4. 校验运行期资产（模板 JSON）里的字段标签
 *
 * 挡的是「改了源码但产物没跟上 / 改回来没被发现」；拖动、SSE、出图这些交互
 * 仍然只能人眼确认。
 *
 * 用法：node plugins/anima-plus/scripts/contract-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 产物顶层代码会注入 <link>，给个最小 document 桩（与 anima-example 的契约测试同款）
const links = [];
globalThis.document = {
  querySelector: (sel) => links.find((l) => sel.includes(l.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {}, rel: '', href: '' }),
  head: { appendChild: (el) => links.push(el) },
};

// 前端产物住在 tab 目录（D16：tabs/<id>/ 里全是编译完的文件）；工作流定义是源码资产，位置不变
const tabDir =
  process.env.TAB_OUT_DIR ?? fileURLToPath(new URL('../../../tabs/anima-plus/', import.meta.url));
const clientUrl = pathToFileURL(path.join(tabDir, 'client.js'));
const js = await readFile(clientUrl, 'utf8');
const css = await readFile(path.join(tabDir, 'client.css'), 'utf8');
const template = JSON.parse(
  await readFile(new URL('../assets/form.json', import.meta.url), 'utf8'),
);

let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : '  → ' + detail));
  if (!ok) failed += 1;
}
function section(title) {
  console.log('\n' + title);
}

// tabs/<id>/ 里没有 node_modules（D16），产物里的 import 'vue' 在浏览器侧由页面 import map 解析；
// Node 侧（本测试）没人解析，所以自己挂一个 resolve 钩子把裸说明符指回本插件的 node_modules。
{
  // 插件目录里没有的（比如 vue-router 只有外壳装了），退到 apps/web 解析
  const parents = [import.meta.url, new URL('../../../apps/web/package.json', import.meta.url).href];
  const MAP = {};
  for (const spec of ['vue', 'vue-router']) {
    for (const from of parents) {
      try {
        MAP[spec] = import.meta.resolve(spec, from);
        break;
      } catch {
        /* 两处都没有就算了：产物里没 import 它 */
      }
    }
  }
  const source =
    'const MAP = ' + JSON.stringify(MAP) + ';\n' +
    'export async function resolve(specifier, context, next) {\n' +
    '  if (Object.prototype.hasOwnProperty.call(MAP, specifier)) {\n' +
    '    return { url: MAP[specifier], shortCircuit: true };\n' +
    '  }\n' +
    '  return next(specifier, context);\n' +
    '}\n';
  register('data:text/javascript,' + encodeURIComponent(source));
}
section('产物可被外壳加载');
const { default: plugin, renderMarkdown } = await import(clientUrl.href);
check('默认导出是对象', plugin !== null && typeof plugin === 'object');
check('tabs 是非空数组', Array.isArray(plugin.tabs) && plugin.tabs.length > 0);
check('tab.id = anima-plus', plugin.tabs?.[0]?.id === 'anima-plus', plugin.tabs?.[0]?.id);
check('routes 是非空数组', Array.isArray(plugin.routes) && plugin.routes.length > 0);

section('LoRA 权重是滑动条（0 ~ 1，步进 0.05）');
// 产物可能被压缩，所以一律用 \s* 容忍：模板里的 min="0" 会编译成 min:"0"
const rangeAt = js.search(/type:\s*"range"/);
check('产物里有 type="range"', rangeAt >= 0);
if (rangeAt >= 0) {
  const window = js.slice(rangeAt, rangeAt + 240);
  check('滑动条下限 min="0"', /min:\s*"0"/.test(window));
  check('滑动条上限 max="1"', /max:\s*"1"/.test(window));
  check('滑动条步进 step="0.05"', /step:\s*"0\.05"/.test(window));
}
check('权重数值可见（toFixed(2)）', /toFixed\(2\)/.test(js));

section('历史记录不再有「模板」列');
for (const kept of ['任务', '状态', '产出']) {
  check(`保留 data-label="${kept}"`, new RegExp(`"data-label":\\s*"${kept}"`).test(js));
}
check('没有 data-label="模板"', !/"data-label":\s*"模板"/.test(js));

section('窄屏不被「固有最小宽度」撑破');
check(
  '全局兜底：.cw-anima-plus input 带 min-width:0',
  /\.cw-anima-plus input[^{]*\{[^}]*min-width:\s*0/.test(css),
);
check(
  '全局兜底：.cw-anima-plus input 带 max-width:100%',
  /\.cw-anima-plus input[^{]*\{[^}]*max-width:\s*100%/.test(css),
);
check('LoRA 浏览器轨道给了可收缩下限', /clamp\(56px,\s*15vw,\s*88px\)\s*minmax\(0,\s*1fr\)/.test(css));
check('标签浏览器两列固定宽可收缩', /minmax\(0,\s*130px\)/.test(css));

section('标签插入：纯追加 + 下划线转空格');
// 只追加、不再把整段按逗号重排（旧行为会把 `(a, b:1.2)` 拆开、吃掉换行）
check('插入时把 `_` 换成空格', /replace\(\/_\/g\s*,\s*" "\)/.test(js));
check('不再用 parts.join(", ") 重排整段', !/parts\.join\(["'`],\s*["'`]\)/.test(js));
// 整理改成手动按钮（算法见 client/src/prompt-cleanup.ts）
check('「整理 / 撤销整理」按钮进了产物', js.includes('撤销整理') && js.includes('没有可整理的'));

section('布局：说明挂在自己字段上、外层不重复留白');
check('行内说明用 .row-desc 渲染', /class:\s*"row-desc"/.test(js));
check('.row 改为顶端对齐', /\.row\[data-v-[0-9a-f]+\]\{[^}]*align-items:\s*flex-start/.test(css));
check(
  '插件根元素不再自带 padding（外壳已给）',
  /\.cw-anima-plus\{[^}]*padding:\s*0[;}]/.test(css),
);
check('.page 不再自带 padding', /\.page\[data-v-[0-9a-f]+\]\{[^}]*padding:\s*0[;}]/.test(css));

section('工作流定义：字段标签');
const byKey = new Map((template.inputs ?? []).map((i) => [i.key, i]));
check('prompt 标签 = 描述提示词', byKey.get('prompt')?.label === '描述提示词', byKey.get('prompt')?.label);
check(
  '已无「正向提示词」标签',
  !(template.inputs ?? []).some((i) => i.label === '正向提示词'),
);

section('依赖声明：图里用到的节点类必须都有出处');
const graph = JSON.parse(
  await readFile(new URL('../workflow.json', import.meta.url), 'utf8'),
);
const used = [...new Set(Object.values(graph).map((n) => n.class_type))];
const req = template.requirements ?? {};
const declared = new Set([
  ...(req.builtin ?? []),
  ...(req.packs ?? []).flatMap((p) => p.provides ?? []),
]);
const uncovered = used.filter((cls) => !declared.has(cls));
check(
  `图里 ${used.length} 个节点类全部有出处（内置或某个包）`,
  uncovered.length === 0,
  uncovered.join('、'),
);
check('需求节点不再手写（由 graph 推导，避免漂移）', req.nodes === undefined);
check(
  '每个包都有 http(s) 地址与非空 provides',
  (req.packs ?? []).length > 0 &&
    (req.packs ?? []).every((p) => /^https?:\/\//.test(p.url) && (p.provides ?? []).length > 0),
  `${(req.packs ?? []).length} 个包`,
);
check('内置节点清单非空', (req.builtin ?? []).length > 0, `${(req.builtin ?? []).length} 个`);

section('依赖清单文档与声明同步');
const { compareDocs } = await import('./gen-deps.mjs');
for (const doc of compareDocs()) {
  check(
    `${doc.file.split('/').pop()} 与声明一致`,
    doc.ok,
    doc.ok ? '' : '跑 pnpm --filter @comfyui-web/anima-plus deps:sync',
  );
}

section('依赖检查：前后端都接上了');
const serverJs = await readFile(path.join(tabDir, 'server.js'), 'utf8');
const depsSrc = await readFile(new URL('../server/deps.ts', import.meta.url), 'utf8');
const managerSrc = await readFile(new URL('../server/jobs/manager.ts', import.meta.url), 'utf8');
check('产物里有 GET /api/deps 路由', /\/api\/deps/.test(serverJs));
check('客户端调它、并且能绕过缓存', /\/api\/deps/.test(js) && /refresh=1/.test(js));
check('三态：不可达时 ok=null（不谎报缺失）', /ok:\s*null/.test(depsSrc));
check('没查成时不拦模板（ready 仍为 true）', /keys === null \? true/.test(depsSrc));
check('提交前检查走同一份缓存（不再每次拉 9MB）', /this\.deps[\s\S]{0,24}\.nodeKeys\(\)/.test(managerSrc));

section('帮助面板：md 渲染器（零依赖，先转义再套标签）');
check('renderMarkdown 是函数', typeof renderMarkdown === 'function');
const scripthtml = renderMarkdown('<script>alert(1)</script>');
check(
  'HTML 被转义（不会变成真标签）',
  scripthtml.includes('&lt;script&gt;') && !scripthtml.includes('<script'),
);
check('隐藏 HTML 注释（生成器的“别手改”提示不上界面）',
  !renderMarkdown('a\n<!-- 内部提示 -->\nb').includes('内部提示'));
check(
  'http 链接渲染成新窗口打开的可点链接',
  /<a href="https:\/\/github\.com\/[^"]+" target="_blank" rel="noreferrer">WeiLin<\/a>/.test(
    renderMarkdown('- [WeiLin](https://github.com/weilin9999/WeiLin-Comfyui-Tools.git)'),
  ),
);
check('相对链接不生成 <a>（浏览器里没有意义）', !renderMarkdown('[readme](./readme.md)').includes('<a '));
check('javascript: 链接被挡下', !renderMarkdown('[x](javascript:alert(1))').includes('<a '));
check(
  '列表 / 表格 / 行内码 / 粗体 都渲染',
  renderMarkdown('- a').includes('<ul>') &&
    renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<table>') &&
    renderMarkdown('`x`').includes('<code>x</code>') &&
    renderMarkdown('**b**').includes('<strong>b</strong>'),
);

section('帮助面板：md 是运行期真源');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
check(
  'readme.md 被搬进 tab 目录（服务端按 import.meta.url 找它）',
  existsSync(path.join(tabDir, 'readme.md')),
  tabDir,
);
check('服务端提供 /api/help', /\/api\/help/.test(serverJs));
check('客户端调用 /api/help', /\/api\/help/.test(js));
check('读不到时有兜底清单（不留白屏）', /读不到/.test(js));

section('配置：设置项声明与接线');
const pkg2 = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const settingFields = new Map((pkg2.plugin?.settings ?? []).map((field) => [field.key, field]));
for (const key of [
  'comfyuiBaseUrl',
  'maxQueueDepth',
  'maxJobsRetained',
  'depsWarmupOnStart',
  'depsCacheTtlMinutes',
]) {
  check(`声明了设置项 ${key}`, settingFields.has(key));
}
check(
  'ComfyUI 地址默认 localhost:8188',
  settingFields.get('comfyuiBaseUrl')?.default === 'http://localhost:8188',
  String(settingFields.get('comfyuiBaseUrl')?.default),
);
check(
  '默认值与代码一致（5 / 200 / true / 5）',
  settingFields.get('maxQueueDepth')?.default === 5 &&
    settingFields.get('maxJobsRetained')?.default === 200 &&
    settingFields.get('depsWarmupOnStart')?.default === true &&
    settingFields.get('depsCacheTtlMinutes')?.default === 5,
);
check(
  '数值项带范围（表单能用）',
  settingFields.get('maxQueueDepth')?.min === 1 &&
    settingFields.get('maxQueueDepth')?.max === 16 &&
    settingFields.get('maxJobsRetained')?.min === 10 &&
    settingFields.get('maxJobsRetained')?.max === 5000 &&
    settingFields.get('depsCacheTtlMinutes')?.min === 0 &&
    settingFields.get('depsCacheTtlMinutes')?.max === 1440,
);
check(
  '每项都有人话标签与说明（设置页直接渲染它们）',
  [...settingFields.values()].every(
    (field) => typeof field.label === 'string' && field.label !== '' && typeof field.description === 'string',
  ),
);
check(
  '接线到了产物里（队列 / 保留 / 预热 / 缓存时长）',
  /maxQueueDepth/.test(serverJs) &&
    /maxJobsRetained/.test(serverJs) &&
    /depsWarmupOnStart/.test(serverJs) &&
    /depsCacheTtlMs/.test(serverJs),
);
check('配置解析留了排障出口（configFiles 记来源）', /configFiles/.test(serverJs));

section('缩略图：纯 JS 引擎真的进了产物（没有原生模块）');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
check(
  '依赖是精确锁版本（pre-1.0，而且会被打进单文件产物）',
  pkg2.devDependencies?.purejsimage === '0.17.0',
  String(pkg2.devDependencies?.purejsimage),
);
check(
  '产物里没有原生模块 sharp（它的 .node 没法内联，这正是当年放弃它的原因）',
  !/require\(['"]sharp['"]\)|from ['"]sharp['"]|import\(['"]sharp['"]\)/.test(serverJs),
);
check('引擎 tag 进了产物（换引擎才会换缓存键）', serverJs.includes('purejs-jpeg-v1'));
check('缩略图产物声明为 JPEG（前端 <img> 按 content-type 走）', serverJs.includes('image/jpeg'));
check('没有把 wasm 加速器带进来（只走纯 JS 路径）', !serverJs.includes('.wasm'));
check(
  'README 的缩略图说明与实现对得上（提到引擎与阈值判定）',
  readme.includes('purejsimage') && readme.includes('shouldPassThrough'),
);

console.log(failed === 0 ? '\n✅ 契约测试通过' : `\n❌ 契约测试失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
