import fs from 'node:fs';

import type { TriggerWordsMap } from '@comfyui-web/shared';
import { AppError } from '../errors.js';

/**
 * 本插件自管的 LoRA 触发词表（plugins/anima-plus/docs/weilin.md §5.3 方案 B）。
 *
 * 为什么由我们注入：LoRA 节点已换成 `WeiLinPromptUIOnlyLoraStack`（Lora堆），它没有注入能力；
 * 而全能提示词（`WeiLinPromptUI`）的注入只读 Civitai 缓存（`loras_tags.json`）与 safetensors
 * 元数据 —— 在 WeiLin LoRA 详情里编辑的词写进的是 `lora_userdatas`，对注入完全无效。
 *
 * 每个 LoRA 有**三态**（对应界面上那三行）：
 *
 * | 状态 | words | suppressDefault | 注入 |
 * |------|-------|-----------------|------|
 * | 用默认（开关开） | — | — | WeiLin 标签库的词 |
 * | 自定义（开关关 + 有词） | `name → 词` | — | 表里的词 |
 * | 关默认且留空 | — | 含 `name` | **什么都不注入** |
 *
 * 第三态必须单独存（`suppressDefault`）：只靠"words 里有没有这个键"区分不出
 * "用默认"和"我不想用默认但也没填词"。形态是普通 JSON，排障时直接看。
 */

const FILE_NAME = 'triggers.json';
const FORMAT_VERSION = 2;
/** 触发词长度上限：超长的多半是误把整段提示词粘了进来 */
const WORD_MAX = 200;
const NAME_MAX = 300;

/** 只要空间句柄的这两件事，省得为了一个路径去 import 宿主类型 */
export interface TriggersSpace {
  readonly root: string;
  resolve(rel: string): string;
}

export function triggersFile(space: TriggersSpace): string {
  return space.resolve(FILE_NAME);
}

/** 单个 LoRA 的三态（前端那两行直接用这个渲染） */
export interface TriggerEntryState {
  /** 开关：是否使用 WeiLin 标签库的默认词 */
  useDefault: boolean;
  /** 自定义词；`useDefault=true` 或"关默认但留空"时为空串 */
  word: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** key = LoRA 名（不含扩展名），与 `LoraRef.name`、`lora_str` 的 `name` 同形 */
function normalizeName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/\.safetensors$/i, '')
    .trim();
  if (!name) throw AppError.badRequest('LoRA 名不能为空');
  if (name.length > NAME_MAX) throw AppError.badRequest(`LoRA 名过长（上限 ${NAME_MAX} 字符）`);
  return name;
}

function normalizeWord(raw: unknown): string {
  const word = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (word.length > WORD_MAX) throw AppError.badRequest(`触发词过长（上限 ${WORD_MAX} 字符）`);
  return word;
}

export class TriggerStore {
  private readonly file: string;
  private readonly words = new Map<string, string>();
  private readonly suppressed = new Set<string>();

  constructor(
    space: TriggersSpace,
    private readonly log?: (msg: string, meta?: unknown) => void,
  ) {
    this.file = triggersFile(space);
    this.load();
  }

  /** 启动期读盘。读坏了不算致命（只影响触发词），但要让运维看见 */
  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      // 没建过这张表是正常状态；读坏了才是异常
      if ((err as { code?: string }).code !== 'ENOENT') {
        this.log?.(`触发词表读不出来，按空表处理`, { file: this.file, error: String(err) });
      }
      return;
    }
    // 兼容 v1（只有 {words}）与更早的裸 map：那时没有第三态，读出来就是"都用默认/自定义"
    const words = isPlainObject(raw) && isPlainObject(raw.words) ? raw.words : raw;
    if (isPlainObject(words)) {
      for (const [key, value] of Object.entries(words)) {
        const name = key.trim();
        const word = typeof value === 'string' ? value.trim() : '';
        if (name && word) this.words.set(name, word);
      }
    } else if (raw !== undefined) {
      this.log?.(`触发词表不是对象，按空表处理`, { file: this.file });
    }

    const suppressed = isPlainObject(raw) ? raw.suppressDefault : undefined;
    if (Array.isArray(suppressed)) {
      for (const item of suppressed) {
        const name = typeof item === 'string' ? item.trim() : '';
        if (name) this.suppressed.add(name);
      }
    }

    if (this.words.size > 0 || this.suppressed.size > 0) {
      this.log?.(`触发词表已加载`, {
        file: this.file,
        words: this.words.size,
        suppressDefault: this.suppressed.size,
      });
    }
  }

  /** 自定义词表（不含第三态） */
  all(): TriggerWordsMap {
    return Object.fromEntries(this.words);
  }

  /** 关掉默认但没填词的那批 LoRA */
  suppressedNames(): string[] {
    return [...this.suppressed];
  }

  get(name: string): string | undefined {
    return this.words.get(name);
  }

  isSuppressed(name: string): boolean {
    return this.suppressed.has(name);
  }

  stateOf(rawName: unknown): TriggerEntryState {
    const name = normalizeName(rawName);
    const word = this.words.get(name) ?? '';
    return { useDefault: !word && !this.suppressed.has(name), word };
  }

  /**
   * 写入三态（界面上的开关 + 输入框一次提交）。
   *
   * - `useDefault=true` → 两处都清掉（回到"用默认"）
   * - `useDefault=false` 且词非空 → 记进 words
   * - `useDefault=false` 且词为空 → 记进 suppressDefault（"不注入"）
   */
  apply(rawName: unknown, rawUseDefault: unknown, rawWord: unknown): TriggerEntryState {
    const name = normalizeName(rawName);
    const useDefault = rawUseDefault !== false;
    const word = useDefault ? '' : normalizeWord(rawWord);

    this.words.delete(name);
    this.suppressed.delete(name);
    if (!useDefault) {
      if (word) this.words.set(name, word);
      else this.suppressed.add(name);
    }

    this.persist();
    return { useDefault, word };
  }

  /** 先写临时文件再改名：写到一半崩了也不会留下半截 JSON */
  private persist(): void {
    const payload = {
      version: FORMAT_VERSION,
      words: this.all(),
      suppressDefault: this.suppressedNames(),
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
    this.log?.(`触发词表已更新`, {
      file: this.file,
      words: this.words.size,
      suppressDefault: this.suppressed.size,
    });
  }
}
