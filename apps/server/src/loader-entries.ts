import type { Context } from 'cordis';
import type { Entry } from '@cordisjs/plugin-loader';

/**
 * Loader 行的 id 不是插件 id：行 id 是 `<group>:<id>`（目录型 tab 挂的时候不带 group）。
 *
 * `include:anima-plus` → `anima-plus`
 */
export function shortId(entryId: string): string {
  const index = entryId.indexOf(':');
  return index === -1 ? entryId : entryId.slice(index + 1);
}

/** 按插件 id 取当前那一行；没挂上 / 已卸载时是 undefined */
export function findEntry(ctx: Context, id: string): Entry | undefined {
  for (const entry of ctx.loader.entries()) {
    if (shortId(entry.id) === id) return entry;
  }
  return undefined;
}
