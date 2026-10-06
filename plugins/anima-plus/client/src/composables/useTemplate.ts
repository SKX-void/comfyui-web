/**
 * 工作流定义 + 表单值 + 参数快照（回填 / 保存）。
 *
 * 抽出来是因为 App.vue 是装配根：状态与流程按主题分组，根上只留接线。
 */
import { ref } from 'vue';
import type { TemplateDetail } from '@comfyui-web/shared';
import { api } from '@/api';
import { defaultValues, restoreValues, type FieldModel } from '@/form';

export function useTemplate(pushLog: (line: string) => void) {
const template = ref<TemplateDetail | null>(null);

const values = ref<FieldModel>({});

const models = ref<Record<string, string[]>>({});

/** 参数快照的状态说明（回填 / 已保存），显示在「参数」卡右上角 */
const stateNote = ref<string | null>(null);

/** 初始化阶段的致命错误（页面会显示横幅，而不是静默残缺） */
const fatalError = ref<string | null>(null);

/** 把一个致命错误同时写进日志与页面横幅 */
function fail(message: string): void {
  fatalError.value = message;
  pushLog(`✘ ${message}`);
}

async function loadTemplate(): Promise<void> {
  fatalError.value = null;
  const tpl = await api.getTemplate();
  template.value = tpl;
  // 先算好表单值再声明成功：否则会留下"定义已设但表单为空"的半截状态
  values.value = defaultValues(tpl.inputs);
  pushLog(
    `工作流已加载: ${tpl.name}（${tpl.graphNodeCount} 个节点 / ${tpl.inputs?.length ?? 0} 个输入）`,
  );

  await restoreLastState(tpl);

  // 预取 model-select 需要的模型列表
  const folders = new Set(
    (tpl.inputs ?? [])
      .filter((i) => i.type === 'model-select' && i.source?.folder)
      .map((i) => i.source!.folder!),
  );
  for (const folder of folders) {
    try {
      const res = await api.listModels(folder);
      models.value[folder] = res.items;
      pushLog(`模型目录 ${folder}: ${res.items.length} 项`);
    } catch (err) {
      models.value[folder] = [];
      pushLog(`模型目录 ${folder} 读取失败: ${(err as Error).message}`);
    }
  }
}

/** 时间戳 → 本地可读（快照里存的是 ISO，直接显示太丑） */
function formatMoment(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 回填上次提交的参数（每次点「开始生成」写一次，见 `submit()`）。
 *
 * 读不到**不是错误**：快照本来就可能还没写过（第一次用），模板默认值照用就行。
 * 所以这里只记一条日志，不设 fatalError。
 */
async function restoreLastState(tpl: TemplateDetail): Promise<void> {
  try {
    const saved = await api.getLastState();
    if (saved.error !== undefined) {
      pushLog(`参数快照读不出来，改用模板默认值: ${saved.error}`);
    }
    const filled = restoreValues(tpl.inputs, saved.values);
    const count = Object.keys(filled).length;
    if (count === 0) return;
    values.value = { ...values.value, ...filled };
    const at = formatMoment(saved.savedAt);
    stateNote.value = at ? `已回填上次参数 · ${at}` : '已回填上次参数';
    pushLog(`已回填上次提交的参数 ${count} 项${at ? `（${at}）` : ''}`);
  } catch (err) {
    // 后端不在 / 老版本没有这个端点 —— 都只影响"回填"，不影响出图
    pushLog(`参数快照读取失败（改用模板默认值）: ${(err as Error).message}`);
  }
}

/**
 * 存快照：**以每次按下生成按钮为准**（值就是这次真正提交出去的那一份）。
 * 不 await —— 存不上不该拦住出图，失败只在日志里说一声。
 */
async function saveLastState(payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await api.saveLastState(payload);
    const at = formatMoment(res.savedAt);
    stateNote.value = at ? `已保存本次参数 · ${at}` : '已保存本次参数';
    pushLog(`参数快照已保存（${Object.keys(payload).length} 项）`);
  } catch (err) {
    pushLog(`参数快照保存失败: ${(err as Error).message}`);
  }
}

  return {
    template,
    values,
    models,
    stateNote,
    fatalError,
    fail,
    loadTemplate,
    restoreLastState,
    saveLastState,
  };
}
