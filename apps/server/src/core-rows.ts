import type { Context } from 'cordis';

import type { TabsFacade } from './core-host.js';
import { findEntry } from './loader-entries.js';
import type { PluginPackageManifest, PluginSettingField } from './plugin-package.js';
import type { ScannedTab } from './tabs.js';

export type Phase =
  | 'active'
  | 'pending'
  | 'loading'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'unresolved'
  | 'disabled'
  | 'rejected';

const FIBER_STATE_LABEL: Record<number, Phase> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
};

export interface PluginRow {
  id: string;
  /** 服务端入口绝对路径（设置页拿它排障） */
  entry: string;
  enabled: boolean;
  phase: Phase;
  title: string;
  icon?: string;
  order: number;
  packageName?: string;
  version?: string;
  clientUrl?: string;
  /** 字段**形状**（元数据，来自 package.json）；值住在插件自己的空间里 */
  settings: PluginSettingField[];
  error?: string;
}

/**
 * 取一格 tab 的完整描述（含失败原因）；entry 可能不存在（没挂上 / 挂失败）。
 *
 * `enabled` 由调用方给（今天来自 `tabs.rows()`：宿主写盘的那个启停状态）。
 */
export async function describeRow(ctx: Context, tab: ScannedTab, enabled: boolean): Promise<PluginRow> {
  const id = tab.id;
  const entry = findEntry(ctx, id);
  const manifest: PluginPackageManifest = tab.pkg?.manifest ?? {};

  let phase: Phase;
  let error: string | undefined;

  if (tab.problem !== undefined) {
    // 目录本身没通过检查：它以 disabled 挂着，这里把原因原样交给设置页
    phase = 'rejected';
    error = tab.problem;
  } else if (entry === undefined) {
    phase = 'unresolved';
    error = '没有挂进 Loader（重扫后仍未装载）';
  } else if (entry.disabled) {
    phase = 'disabled';
  } else if (entry.fiber === undefined) {
    // 导入失败的判据：无 fiber 且未禁用（与 dsh 的 assertEntriesLoaded 同款）
    phase = 'unresolved';
    error = await importFailure(ctx, entry.options.name);
  } else {
    const state = entry.fiber.state;
    phase = FIBER_STATE_LABEL[state] ?? 'pending';
    if (phase === 'failed') {
      try {
        await entry.fiber.await();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const clientUrl =
    manifest.client !== undefined
      ? `/plugins/${id}/${manifest.client.replace(/^\.\//, '')}`
      : undefined;

  return {
    id,
    entry: tab.entry,
    enabled,
    phase,
    title: manifest.title ?? id,
    ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
    order: manifest.order ?? 100,
    ...(tab.pkg?.packageName !== undefined ? { packageName: tab.pkg.packageName } : {}),
    ...(tab.pkg?.version !== undefined ? { version: tab.pkg.version } : {}),
    ...(clientUrl !== undefined ? { clientUrl } : {}),
    settings: manifest.settings ?? [],
    ...(error !== undefined ? { error } : {}),
  };
}

export async function listRows(ctx: Context, tabs: TabsFacade): Promise<PluginRow[]> {
  const rows: PluginRow[] = [];
  // 只列**已装载**的 tab（含没通过检查的那些，它们也要显示原因）：目录里刚放进来、
  // 还没点重扫的插件不出现在这里 —— 免得界面显示一个"看得见但点不开"的 tab
  for (const { tab, enabled } of tabs.rows()) {
    rows.push(await describeRow(ctx, tab, enabled));
  }
  rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return rows;
}

/** 为"模块导入失败"的行补一条可读原因（错误只进了 Loader 日志，这里复现一次） */
async function importFailure(ctx: Context, specifier: string): Promise<string> {
  try {
    await ctx.loader.import(specifier);
    return '插件模块未激活（可能依赖的服务缺席）';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
