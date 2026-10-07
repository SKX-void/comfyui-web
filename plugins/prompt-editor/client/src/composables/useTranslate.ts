import { onUnmounted, reactive, type Ref } from 'vue';

import { saveTagEntry, translateTexts, type TranslateSettings } from '../api';
import type { Block, Item } from '../model';

interface TranslateJob {
  item: Item;
  block: Block;
}

/**
 * 翻译编排：词库优先 + provider 兜底（固定 en→zh）。
 *
 * 一条译文有三种来路：**词库命中**（瞬时、零请求、零配额）、**现翻**（有道体验版）、
 * **用户手填**（写回词库，之后自动命中，且永不被 API 覆盖）。
 *
 * 自动译只发生在"条目编辑完"之后，并且攒 400ms 合并成一批 —— 连着敲几条 tag 只发一次请求。
 * 队列只收**还没有译文**的条目：已有译文（手改的、之前翻好的）一律不动。
 * 没翻成的只在那个格子上留个记号（红框），不弹窗、不挡写作。
 *
 * `settings` / `flash` / `persistItems` 都是注入的：它们分别归设置、提示、工作区管。
 */
export function useTranslate(options: {
  settings: Ref<TranslateSettings>;
  flash: (message: string) => void;
  persistItems: (block: { id: string; items: Item[] }) => void;
}) {
  const { settings, flash, persistItems } = options;

  // 正在翻 / 没翻成的条目 id。reactive(Set) 才能让 `.add/.delete` 触发重渲染。
  const busyIds = reactive(new Set<string>());
  const failedIds = reactive(new Set<string>());

  const queue = new Map<string, TranslateJob>();
  let queueTimer: number | null = null;

  function enqueueAuto(block: Block): void {
    if (!settings.value.autoTranslate) return;
    for (const item of block.items) {
      if (item.translation !== '' || item.text.trim() === '') continue;
      queue.set(item.id, { item, block });
    }
    if (queue.size === 0) return;
    if (queueTimer !== null) clearTimeout(queueTimer);
    queueTimer = window.setTimeout(() => {
      queueTimer = null;
      const jobs = [...queue.values()];
      queue.clear();
      void runTranslate(jobs, false);
    }, 400);
  }

  /**
   * 逐条翻译：**一次只发一条，上一条回来才发下一条**。
   *
   * 不打包成一批，是因为 provider 那边本来就是一个 q 一次调用（体验版一次只收一条），
   * 打包只会让一次 HTTP 请求挂很久（节流 6s × 10 条 = 1 分钟），而且中途失败会连坐整批。
   * 逐条发：进度看得见（正在翻的那条显示「…」）、失败只影响那一条、每个请求都短。
   * 合并请求的好处已经由 `enqueueAuto` 的 400ms 防抖队列给了。
   */
  async function runTranslate(jobs: TranslateJob[], manual: boolean): Promise<void> {
    const live = jobs.filter((job) => job.item.text.trim() !== '');
    if (live.length === 0) {
      if (manual) flash('这里没有可翻的条目');
      return;
    }

    // 译文也算"这个组编辑完了"：不落盘的话刷新一下刚翻的译文就没了（按组去重，一组一次写）
    const touched = new Map<string, Block>();
    let hits = 0;
    let skipped = 0;
    let lastError = '';

    for (const job of live) {
      busyIds.add(job.item.id);
      failedIds.delete(job.item.id);
      try {
        const outcome = await translateTexts([job.item.text]);
        if (outcome.error !== undefined) lastError = outcome.error.message;
        const result = outcome.results[0];
        if (result === undefined) continue;
        if (result.translation !== '') {
          job.item.translation = result.translation;
          // 词库命中：导入的机翻标 import（「导」），其余标 dict（「库」）；现翻的标 api（「机」）
          job.item.source = result.source === 'api' ? 'api' : result.source === 'import' ? 'import' : 'dict';
          touched.set(job.block.id, job.block);
          if (result.source !== 'api') hits += 1;
        } else if (result.source === 'skip') {
          skipped += 1;
        } else if (result.source === 'error') {
          failedIds.add(job.item.id);
        }
      } catch (error) {
        failedIds.add(job.item.id);
        lastError = (error as Error).message;
      } finally {
        busyIds.delete(job.item.id);
      }
    }
    for (const block of touched.values()) persistItems(block);

    if (lastError !== '') flash(`翻译：${lastError}`);
    else if (manual && touched.size === 0 && skipped > 0) flash('这一条是权重语法或模型名，不需要翻');
    else if (manual) flash(hits > 0 ? `翻译完成（${hits} 条直接命中词库）` : '翻译完成');
  }

  function translateItem(block: Block, index: number): void {
    const item = block.items[index];
    if (item === undefined) return;
    void runTranslate([{ item, block }], true);
  }

  /** 整块「译」：**已经有译文的不动**（要重翻某一条就点它自己的「译」） */
  function translateBlock(block: Block): void {
    const jobs = block.items
      .filter((item) => item.enabled && item.text.trim() !== '' && item.translation === '')
      .map((item) => ({ item, block }));
    if (jobs.length === 0) {
      flash('这一块都有译文了（要重翻某一条，点它自己的「译」）');
      return;
    }
    void runTranslate(jobs, true);
  }

  /** 把机器翻的存进词库：存过之后自动译直接命中它，也不会再被覆盖 */
  function promoteTranslation(block: Block, index: number): void {
    const item = block.items[index];
    if (item === undefined || item.translation.trim() === '') return;
    void saveTagEntry({ en: item.text, zh: item.translation, source: 'user' })
      .then(() => {
        // 进库了就不再是"现翻的"（徽章只说在不在库里）—— 存成功才翻牌，失败就还是「机」
        item.source = 'dict';
        persistItems(block);
        flash(`「${item.text}」已存进词库`);
      })
      .catch((error: Error) => flash(`存词库失败：${error.message}`));
  }

  /** 手改的译文写回词库：以后自动译命中它，API 结果也不再覆盖 */
  function onTranslationEdited(text: string, translation: string): void {
    void saveTagEntry({ en: text, zh: translation, source: 'user' }).catch(() => {
      // 词库没写上不影响用：条目自己的译文已经跟着草稿落盘了
    });
  }

  // 卸载时不撤掉定时器，它还会去翻一批已经没人看的条目
  onUnmounted(() => {
    if (queueTimer !== null) clearTimeout(queueTimer);
  });

  return { busyIds, failedIds, enqueueAuto, translateItem, translateBlock, promoteTranslation, onTranslationEdited };
}
