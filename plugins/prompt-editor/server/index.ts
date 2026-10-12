/**
 * 插件入口：宿主按 tab 的 package.json 的 main 加载**产物** `server.js`
 * （由 scripts/build-server.mjs 从本目录打出来）。
 *
 * 这里只做两件事：装配（`apply` 把路由挂到宿主句柄上）与再导出
 * （契约测试按名字取函数，见 scripts/contract-test.ts）。逻辑各归其模块。
 *
 * 只 import node 内置模块，**不 import cordis**：宿主已经把 cordis 打进自己的产物，
 * 插件再引一份就是两个实例。
 */
import { registerRoutes } from './routes.js';
import type { PluginContext } from './types.js';

export const name = 'prompt-editor';

export const inject = ['routes', 'space'];

export function apply(ctx: PluginContext): void {
  registerRoutes(ctx);
}

export { LIMITS } from './constants.js';
export { docFromStored, rawFromStored, sanitizeDoc, storedFromDoc, storedFromRaw } from './doc.js';
export { maskPromptSyntax, tagKey } from './prompt.js';
export { PROVIDERS } from './providers.js';
export { isLlmReasoning, llmSettingsView, mergeApiKey, sanitizeSettings, sanitizeUsage } from './settings.js';
export { splitByMode, splitSentences, splitTags } from './split.js';
export {
  composePrompt,
  interpolatePrompt,
  isLlmPromptRole,
  LLM_PROMPTS_VERSION,
  loadLlmPrompts,
  sanitizeLlmPrompt,
  sanitizePromptSegment,
} from './llm-prompts.js';
export { LlmError, openAiCompatibleChat } from './llm-providers.js';
export { LLM_TOOLS, runLlmAgent } from './llm.js';
export { buildItems, describeWorkspace, makeToolkit } from './llm-toolkit.js';
export { createLlmRunner, joinBlockContent } from './llm-run.js';
export {
  chatTitle,
  loadLlmChats,
  makeChat,
  makeTurn,
  replayHistory,
  sanitizeChat,
  sanitizeTurn,
  saveLlmChats,
  summarizeChat,
  turnAction,
} from './llm-chats.js';
export { registerLlmRoutes } from './routes-llm.js';
export { registerTranslateRoutes } from './routes-translate.js';
export { registerLlmChatRoutes } from './routes-llm-chats.js';
export { escapeLike, machineCategory, mergeTag, sanitizeTags, tagSearchBlob } from './tags.js';
export {
  BUNDLED_BUILTIN,
  BUNDLED_COOC,
  BUNDLED_CSV,
  foldUnderscore,
  looksLikeLfsPointer,
  parseCooccurTsv,
  parseTagCsv,
} from './tagcsv.js';
export { registerBlockCategoryRoutes } from './routes-block-categories.js';
export { registerBlockPresetRoutes } from './routes-block-presets.js';
export {
  categorySummaries,
  loadBlockLibrary,
  reorderCategories,
  sanitizeBlockCategory,
  sanitizeBlockPreset,
  saveBlockLibrary,
  summarize,
  uncategorizedCount,
} from './blockstore.js';
export { openTagDb } from './tagdb.js';
export { translateTexts } from './translate.js';
