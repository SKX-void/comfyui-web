import { computed, ref } from 'vue';
import { orderTabs, orderedTabs, plugins, resolveHome, uiPrefs } from '../../store';
import type { PluginInfo } from '../../types';

/**
 * 设置页的偏好视图状态：**草稿**（输入框内容）与 store 里的真值分开。
 *
 * 输入框允许"改到一半"，所以真值只在保存成功、点「重新读取」、或首屏进页面时回填 ——
 * 设置页与各卡片就在这几个时机调 `syncDrafts()` / `syncGlobalDraft()`。
 */

/** 设置页里的顺序：以**清单**为准（含没跑起来的那些），用偏好重排 */
export const orderedPlugins = computed(() => orderTabs(plugins.value, uiPrefs.value.tabOrder));

/** 当前真正生效的首页（偏好不可用时就是回退链的结果） */
export const effectiveHome = computed(() => resolveHome(orderedTabs.value, uiPrefs.value.home));

/** 能否设为首页：现在真的能给出一个能用的 tab */
export function canBeHome(plugin: PluginInfo): boolean {
  return orderedTabs.value.some((tab) => tab.id === plugin.id && tab.error === undefined);
}

/** 统一 ComfyUI 地址（宿主给的只读默认值，不写进任何插件） */
export const globalDraft = ref('');

/** 别名草稿（插件 id → 输入框内容）；品牌名同理。保存后由后端清洗的结果回填 */
export const aliasDrafts = ref<Record<string, string>>({});
export const homeLabelDraft = ref('');

export function syncGlobalDraft(): void {
  globalDraft.value = uiPrefs.value.globals.comfyuiBaseUrl;
}

export function syncDrafts(): void {
  aliasDrafts.value = Object.fromEntries(
    orderedPlugins.value.map((plugin) => [plugin.id, uiPrefs.value.tabAliases[plugin.id] ?? '']),
  );
  homeLabelDraft.value = uiPrefs.value.homeLabel;
}
