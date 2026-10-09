/**
 * 插件产物的契约测试 —— 没有浏览器时的替代验证（`pnpm contract` 会跑到它）。
 *
 * 它按宿主消费插件的方式走一遍，只挡「产物没跟上 / 契约破了」这类机器能看见的问题：
 *   1. 前端：注入样式需要最小 document 桩，然后 `import(tabs/<id>/client.js)`，
 *      校验 `default.tabs` / `default.routes` 的形状与可见文案；
 *   2. 清单：tab 的 package.json 里有 contract / title / 六个设置项（且**没有** model）；
 *   3. 后端：`import(tabs/<id>/server.js)` 后用假 ctx 走一遍 `apply()` ——
 *      **它同时证明了 workflow.json 的绑定解析（LoadImage / WD14Tagger / PreviewAny）真的能跑**；
 *   4. 端到端不碰网络的部分：`/settings` 的形状、`/infer` 对坏 dataUrl 的 400。
 *
 * 挡不住的是真出图那一跳（上传 → /prompt → /history），那只能对真 ComfyUI 跑。
 *
 * 用法：node plugins/image-reverse-inference/scripts/contract-test.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ID = 'image-reverse-inference';
const PACKAGE = '@comfyui-web/image-reverse-inference';

// 产物顶层代码会注入 <link>，给个最小 document 桩（与 anima-plus 的契约测试同款）
const links = [];
globalThis.document = {
  querySelector: (sel) => links.find((l) => sel.includes(l.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {}, rel: '', href: '' }),
  head: { appendChild: (el) => links.push(el) },
};

const tabDir = process.env.TAB_OUT_DIR ?? fileURLToPath(new URL(`../../../tabs/${ID}/`, import.meta.url));

let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : '  → ' + detail));
  if (!ok) failed += 1;
}
function section(title) {
  console.log('\n' + title);
}

if (!existsSync(path.join(tabDir, 'client.js'))) {
  console.error(`产物不存在：${tabDir}（先跑 pnpm build:plugins）`);
  process.exit(1);
}

// tabs/<id>/ 里没有 node_modules（D16），产物里的 import 'vue' 在浏览器侧由页面 import map 解析；
// Node 侧（本测试）没人解析，所以自己挂一个 resolve 钩子把裸说明符指回本插件的 node_modules。
{
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

section('① 前端产物可被外壳加载');
const { default: plugin } = await import(pathToFileURL(path.join(tabDir, 'client.js')).href);
check('默认导出是对象', plugin !== null && typeof plugin === 'object');
check('tabs 是非空数组', Array.isArray(plugin.tabs) && plugin.tabs.length > 0);
check(`tab.id = ${ID}`, plugin.tabs?.[0]?.id === ID, plugin.tabs?.[0]?.id);
check('tab.title = 图片反推', plugin.tabs?.[0]?.title === '图片反推', plugin.tabs?.[0]?.title);
check('routes 是非空数组', Array.isArray(plugin.routes) && plugin.routes.length > 0);
check('样式 <link> 挂上了（且只挂一次）', links.length === 1, `links=${links.length}`);
// href 是相对产物自身的：浏览器里是 /plugins/<id>/client.css，Node 里是 file://…/client.css
check(
  '挂的是本插件的 client.css',
  links[0]?.href?.endsWith(`/${ID}/client.css`),
  links[0]?.href,
);

const js = readFileSync(path.join(tabDir, 'client.js'), 'utf8');
const css = readFileSync(path.join(tabDir, 'client.css'), 'utf8');
check('产物里没有裸 import vue 之外的运行时依赖', !/from\s*["'](?!vue)[a-z@]/.test(js));
check('可见文案进了产物（开始反推）', js.includes('开始反推'));
check('样式进了 client.css（.iri-textarea）', css.includes('.iri-textarea'));
check('样式没把主题色写死（用了 var(--panel)）', css.includes('var(--panel'));
check('两个阈值是滑动条（range + .iri-range）', js.includes('"range"') && css.includes('.iri-range'));
// 参数只在本次请求里生效：点反推不该偷偷写盘（挂载时读到的快照会让它看起来"没生效"）
check('产物里没有参数写盘那条路', !js.includes('/params') && !js.includes('saveParams'));

section('② tab 清单');
const manifest = JSON.parse(readFileSync(path.join(tabDir, 'package.json'), 'utf8'));
check('name 是包名', manifest.name === PACKAGE, manifest.name);
check('main = server.js', manifest.main === 'server.js', manifest.main);
check('plugin.contract = 1', manifest.plugin?.contract === 1, String(manifest.plugin?.contract));
check('plugin.client = client.js', manifest.plugin?.client === 'client.js', manifest.plugin?.client);
const settingKeys = (manifest.plugin?.settings ?? []).map((s) => s.key);
const expected = [
  'comfyuiBaseUrl',
  'threshold',
  'characterThreshold',
  'replaceUnderscore',
  'trailingComma',
  'excludeTags',
];
check('六个设置项都在', expected.every((k) => settingKeys.includes(k)), settingKeys.join(','));
// 模型固定在工作流里：它一旦回到设置里，就意味着插件又开始覆盖 workflow.json 的选择
check('设置里没有 model（模型归工作流管）', !settingKeys.includes('model'), settingKeys.join(','));

section('③ 后端 apply()（含 workflow.json 绑定解析）');
// 假的空间布局：<tmp>/host.json + <tmp>/plugins/<包名目录>/，验证"宿主统一地址当只读默认值"
const dataDir = mkdtempSync(path.join(tmpdir(), 'iri-contract-'));
const spaceRoot = path.join(dataDir, 'plugins', PACKAGE.replace('/', '+'));
mkdirSync(spaceRoot, { recursive: true });
writeFileSync(
  path.join(dataDir, 'host.json'),
  JSON.stringify({ globals: { comfyuiBaseUrl: 'http://10.9.9.9:8188' } }),
  'utf8',
);

const routes = [];
const cleanups = [];
const handlers = new Map();
const route = (method) => (p, h) => {
  routes.push(`${method} ${p}`);
  handlers.set(`${method} ${p}`, h);
};
const ctx = {
  routes: {
    for: (id) => ({
      pluginId: id,
      prefix: `/api/p/${id}`,
      get: route('GET'),
      post: route('POST'),
      put: route('PUT'),
      patch: route('PATCH'),
      delete: route('DELETE'),
      all: route('ALL'),
    }),
  },
  space: {
    for: (pkg) => ({
      packageName: pkg,
      root: spaceRoot,
      resolve: (rel) => path.join(spaceRoot, rel),
    }),
  },
  effect: (fn) => cleanups.push(fn),
  logger: { info: () => {} },
};

const server = await import(pathToFileURL(path.join(tabDir, 'server.js')).href);
check('server.js 导出 name', server.name === ID, server.name);
check('inject 要了 routes + space', JSON.stringify(server.inject) === '["routes","space"]', JSON.stringify(server.inject));

let applyError = '';
try {
  server.apply(ctx, undefined);
} catch (err) {
  applyError = err instanceof Error ? err.message : String(err);
}
check('apply() 没抛（工作流里 LoadImage + WD14Tagger 都找到了）', applyError === '', applyError);
check('五个路由都注册了', routes.length === 5, routes.join(' | '));
check('收尾函数注册了（D20 契约）', cleanups.length === 1);

const reply = () => {
  const r = {
    status: 200,
    payload: undefined,
    code(status) {
      r.status = status;
      return r;
    },
    send(payload) {
      r.payload = payload;
      return r;
    },
  };
  return r;
};

const settingsRes = reply();
const settingsBody = await handlers.get('GET /settings')({ body: undefined }, settingsRes);
check('GET /settings 有 values/effective/file', typeof settingsBody?.file === 'string', settingsBody?.file);
check(
  '宿主统一地址被当成只读默认值（10.9.9.9）',
  settingsBody?.effective?.comfyuiBaseUrl === 'http://10.9.9.9:8188',
  settingsBody?.effective?.comfyuiBaseUrl,
);
check('生效值里没有 model（模型归工作流管）', !('model' in (settingsBody?.effective ?? {})));

// 模型固定在工作流里：UI 就算送 model 上来，也不该住进设置文件
const putRes = reply();
await handlers.get('PUT /settings')({ body: { values: { model: 'wd-vit-tagger-v3', 杂物: 1 } } }, putRes);
const written = JSON.parse(readFileSync(path.join(spaceRoot, 'settings.json'), 'utf8'));
check('PUT /settings 只落认识的键（model 与杂物都不收）', Object.keys(written).length === 0, JSON.stringify(written));

// 设置面板存完要让宿主重挂才生效（D20）：路由自己声明 reloadRequired
const keepRes = reply();
const keepBody = await handlers.get('PUT /settings')(
  { body: { values: { comfyuiBaseUrl: 'http://1.2.3.4:8188', threshold: 0.2 } } },
  keepRes,
);
const kept = JSON.parse(readFileSync(path.join(spaceRoot, 'settings.json'), 'utf8'));
check('PUT /settings 落盘并要重挂', kept.comfyuiBaseUrl === 'http://1.2.3.4:8188' && keepBody?.reloadRequired === true, JSON.stringify(keepBody));
check('落盘的就是收敛前的原值（收敛发生在读取时）', kept.threshold === 0.2, JSON.stringify(kept));

const badSettings = reply();
await handlers.get('PUT /settings')({ body: { values: 'nope' } }, badSettings);
check('PUT /settings 形状不对 → 400', badSettings.status === 400, String(badSettings.status));

section('④ /infer 的入参闸门（不碰网络）');
const badRes = reply();
await handlers.get('POST /infer')({ body: { dataUrl: 'data:image/gif;base64,R0lGOD' } }, badRes);
check('不支持的 mime → 400', badRes.status === 400, String(badRes.status));
check('400 带可读原因', typeof badRes.payload?.error?.message === 'string', badRes.payload?.error?.message);

const hugeRes = reply();
const huge = 'A'.repeat(Math.ceil((3 * 1024 * 1024 * 4) / 3));
await handlers.get('POST /infer')({ body: { dataUrl: `data:image/webp;base64,${huge}` } }, hugeRes);
check('超过 2MB 的图 → 400（前端该先压缩）', hugeRes.status === 400, hugeRes.payload?.error?.message);

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
