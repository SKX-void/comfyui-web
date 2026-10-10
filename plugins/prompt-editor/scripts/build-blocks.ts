/**
 * 预处理：把 `assets/存档.json`（WeiLin 提示词盒子的导出）转成插件认的区块库导入文件
 * `assets/block-library.json`。
 *
 * 为什么不在导入时现转：那份存档是**别人的格式**（version 5.0，`buttons` + `catOrder` + `negWords`），
 * 转它是"翻译一份数据"的一次性动作；把规则写进服务端就等于让插件永远背着一个外来的格式，
 * 还多一份每次导入都要跑的解析。产物里放转好的 `block-library.json`，导入那侧只认自己的格式。
 *
 * 四件事在转的时候定死：
 * - **一条 prompt 切成 N 个条目**（`mode: 'tag'`）：`(ass focus, facing away, ...)` 是**一个**条目
 *   —— 括号 / 方括号 / 花括号里的逗号不算分隔符（见 `splitItems`），不然权重括号会被切碎。
 * - **分类顺序按 `catOrder`**：导入时分类是"按名字现建"的，首次出现的顺序就是左栏的顺序
 *   （见 `routes-block-presets.ts`），所以这里得先把 presets 按 catOrder 排好。
 * - **负提示词单独一类**：`negWords` 在原格式里是"绑在某个按钮上、用它时自动追加"的，
 *   我们没有这种绑定 —— 折进名字里（`xxx（用于「按钮名」）`），要用的自己插。
 * - **热度高的排前面**：`count` 是原工具里的使用次数，同一类里按它降序，常用的先看见。
 *
 * 用法（换存档时才跑）：
 *   node plugins/prompt-editor/scripts/build-blocks.ts [--src <存档.json>] [--out <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));

/** 原存档里的一条按钮 / 一条负提示词 */
interface SourceButton {
  name?: string;
  prompt?: string;
  category?: string;
  count?: number;
  color?: string;
  bindTo?: string;
}

/** 负提示词那一类在左栏里的名字（原格式里它们不属于任何分类） */
const NEG_CATEGORY = '负提示词';

function parseArgs(argv: string[]): { src: string; out: string } {
  let src = path.join(pluginDir, 'assets', '存档.json');
  let out = path.join(pluginDir, 'assets');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--src') src = path.resolve(argv[(i += 1)] ?? '');
    else if (arg === '--out') out = path.resolve(argv[(i += 1)] ?? '');
  }
  return { src, out };
}

/**
 * 按逗号切条目，**括号感知**：`(ass focus, facing away:2)` 是一个条目而不是两个。
 *
 * 反斜杠转义的括号（`\(`）不计深度 —— 提示词里真有人这么写，数错了整段就切歪了。
 */
function splitItems(prompt: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cell = '';
  for (let i = 0; i < prompt.length; i += 1) {
    const ch = prompt[i] as string;
    if (ch === '\\') {
      cell += ch + (prompt[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  out.push(cell);
  // 条目里真的会有换行（源 prompt 里手敲的）：chip 上显示成两行很难看，收成一个空格
  return out.map((one) => one.replace(/\s+/g, ' ').trim()).filter((one) => one !== '');
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(args.src)) {
  console.error(`找不到存档：${args.src}`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(args.src, 'utf8')) as {
  version?: unknown;
  buttons?: SourceButton[];
  catOrder?: unknown;
  negWords?: SourceButton[];
};
const buttons = (Array.isArray(raw.buttons) ? raw.buttons : []).filter((one) => (one.name ?? '').trim() !== '' && (one.prompt ?? '').trim() !== '');
const negWords = (Array.isArray(raw.negWords) ? raw.negWords : []).filter((one) => (one.name ?? '').trim() !== '' && (one.prompt ?? '').trim() !== '');
if (buttons.length === 0) {
  console.error(`${args.src} 里没有能认出来的按钮（预期 { version, buttons, catOrder, negWords }）`);
  process.exit(1);
}

/** 左栏分类顺序：存档里的 `catOrder` 说了算，它没提到的分类排在后面（按首次出现） */
const order = (Array.isArray(raw.catOrder) ? raw.catOrder : []).filter((one): one is string => typeof one === 'string');
const rank = (name: string): number => {
  const at = order.indexOf(name);
  return at === -1 ? order.length : at;
};

/** 分类 → 它下面的按钮（同类里使用次数高的排前面） */
const byCategory = new Map<string, SourceButton[]>();
for (const button of buttons) {
  const name = (button.category ?? '').trim();
  const list = byCategory.get(name) ?? [];
  list.push(button);
  byCategory.set(name, list);
}
const categories = [...byCategory.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
if (negWords.length > 0) categories.push(NEG_CATEGORY);

const presets: Record<string, unknown>[] = [];
for (const category of categories) {
  const list =
    category === NEG_CATEGORY
      ? [...negWords].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      : [...(byCategory.get(category) ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  for (const one of list) {
    const items = splitItems((one.prompt ?? '').trim());
    if (items.length === 0) continue;
    // 负提示词的"绑在哪个按钮上"没地方放（我们不做自动追加）：折进名字里，用的时候看得见
    const name = (one.name ?? '').trim() + (category === NEG_CATEGORY && (one.bindTo ?? '').trim() !== '' ? `（用于「${(one.bindTo ?? '').trim()}」）` : '');
    presets.push({
      name,
      // title 留空：插进工作区时表头就用 name（见 useWorkspace.ts），写一遍是重复
      title: '',
      color: (one.color ?? '').trim(),
      mode: 'tag',
      items,
      category,
    });
  }
}

const doc = { kind: 'prompt-editor/block-library', version: 1, presets };
fs.mkdirSync(args.out, { recursive: true });
const target = path.join(args.out, 'block-library.json');
const json = `${JSON.stringify(doc, null, 1)}\n`;
fs.writeFileSync(target, json);

const itemTotal = presets.reduce((sum, one) => sum + (one.items as string[]).length, 0);
console.log(
  JSON.stringify(
    {
      src: args.src,
      out: target,
      bytes: Buffer.byteLength(json),
      categories: categories.length,
      presets: presets.length,
      items: itemTotal,
      perCategory: categories.map((one) => `${one} ${presets.filter((p) => p.category === one).length}`),
      longestItems: Math.max(...presets.map((one) => (one.items as string[]).length)),
    },
    null,
    1,
  ),
);
