import type { LoraRef, ResolvedTriggerWord } from '@comfyui-web/shared';
import type { WeilinClient } from '../weilin/client.js';
import type { TriggerStore } from './store.js';
import { normalizeLora } from '../templates/transforms.js';

/** 默认词（WeiLin 标签库）的进程内缓存：一条 71KB，提交时不该每次都拉 */
const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * 触发词解析：**自定义词 → 默认词（WeiLin 标签库）→ 关默认则什么都不注入**。
 *
 * 解析只发生在这里，提交（manager.submit）与预览（POST /api/triggers/resolve）共用同一条路径，
 * 所以界面上显示的就是真正注入的 —— 这正是换掉全能节点后要补回来的确定性。
 *
 * 注入文本**不带权重**：Anima 的提示词解析器不认 `词:权重` 这种写法，带上只会污染 token。
 * （全能节点的 `f"{word}:{weight}"` 是历史包袱，不跟。）
 */
export class TriggerResolver {
  private readonly cache = new Map<string, { at: number; word: string }>();

  constructor(
    private readonly store: TriggerStore,
    private readonly weilin: WeilinClient,
    private readonly log?: (msg: string, meta?: unknown) => void,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** 逐条明细：三态 + 默认词 + 最终词（界面三行直接渲染这个） */
  async resolve(rawLoras: unknown): Promise<ResolvedTriggerWord[]> {
    const list = Array.isArray(rawLoras) ? rawLoras : [];
    const out: ResolvedTriggerWord[] = [];

    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      let lora: LoraRef;
      try {
        lora = normalizeLora(raw);
      } catch {
        // 非法条目留给 render 报错（那里有字段级提示），这里只是解析不出词
        continue;
      }

      const custom = this.store.get(lora.name) ?? '';
      const suppressed = this.store.isSuppressed(lora.name);
      const useDefault = !custom && !suppressed;
      // 第 1 行永远要显示默认词（哪怕开关是关的），所以照查；命中缓存时不发请求
      const defaultWord = await this.defaultWord(lora);

      const word = useDefault ? defaultWord : custom;
      const source: ResolvedTriggerWord['source'] = useDefault
        ? defaultWord
          ? 'weilin'
          : 'none'
        : custom
          ? 'override'
          : 'none';

      out.push({ name: lora.name, word, source, useDefault, custom, defaultWord });
    }
    return out;
  }

  /** 注入前缀 = 各 LoRA 最终词按顺序拼接（空的不参与；全部为空则返回空串 = 不注入） */
  async prefix(rawLoras: unknown): Promise<string> {
    const all = await this.resolve(rawLoras);
    return all
      .map((r) => r.word)
      .filter(Boolean)
      .join(', ');
  }

  /** WeiLin 标签库的默认词：`loraWorks` 优先，其次第一个 `trainedWords` */
  private async defaultWord(lora: LoraRef): Promise<string> {
    const file = lora.lora ?? `${lora.name}.safetensors`;
    const hit = this.cache.get(file);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.word;

    let word = '';
    try {
      const meta = await this.weilin.getLoraInfo(file);
      word = (meta.loraWorks || meta.triggerWords[0] || '').trim();
    } catch (err) {
      // WeiLin 不可用绝不能挡住出图：降级成"没有默认词"
      this.log?.('读取触发词失败，按无默认词处理', { file, error: String(err) });
    }
    this.cache.set(file, { at: Date.now(), word });
    return word;
  }
}
