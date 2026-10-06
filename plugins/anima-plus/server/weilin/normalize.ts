import type { FolderNode, WeilinLoraEntry, WeilinLoraInfo, WeilinTag, WeilinTopGroup } from './types.js';

/** 上游响应 → 领域对象：只做字段搬运与兜底，不发请求。 */

export function toEntry(path: string): WeilinLoraEntry {
  const base = path.replace(/\.safetensors$/i, '');
  const sep = base.lastIndexOf('\\');
  const folder = sep >= 0 ? base.slice(0, sep) : '';
  const displayName = sep >= 0 ? base.slice(sep + 1) : base;
  return { path, name: base, folder, displayName };
}

export function normalizeLoraInfo(file: string, d: Record<string, unknown>): WeilinLoraInfo {
  const raw = (d.raw ?? {}) as Record<string, unknown>;
  const civitai = (raw.civitai ?? {}) as Record<string, unknown>;
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;

  // 触发词：优先用户编辑的 trainedWords / loraWorks，其次 Civitai
  const triggerWords: string[] = [];
  const trained = d.trainedWords;
  if (Array.isArray(trained)) {
    for (const w of trained) {
      if (w && typeof w === 'object' && typeof (w as { word?: string }).word === 'string') {
        triggerWords.push((w as { word: string }).word);
      }
    }
  }
  if (Array.isArray(civitai.trainedWords)) {
    for (const w of civitai.trainedWords) {
      if (typeof w === 'string' && !triggerWords.includes(w)) triggerWords.push(w);
    }
  }

  return {
    file,
    triggerWords,
    loraWorks: typeof d.loraWorks === 'string' ? d.loraWorks : '',
    civitaiName: typeof civitai.name === 'string' ? civitai.name : '',
    nsfwLevel: typeof civitai.nsfwLevel === 'number' ? civitai.nsfwLevel : null,
    baseModel: typeof metadata['ss_base_model_version'] === 'string'
      ? (metadata['ss_base_model_version'] as string)
      : '',
  };
}

/** prompt/get_group_tags_paginated 的返回（只列用到的字段） */
export interface TagGroupPayload {
  id_index: number;
  name: string;
  color: string;
  groups?: Array<{
    id_index: number;
    name: string;
    color: string;
    tags?: Array<{ id_index: number; text: string; desc: string; color: string }>;
  }>;
}

export function normalizeTagTree(data: TagGroupPayload[] | undefined): { tags: WeilinTag[]; groups: WeilinTopGroup[] } {
  const tags: WeilinTag[] = [];
  const groups: WeilinTopGroup[] = [];
  for (const top of data ?? []) {
    const subgroups: WeilinTopGroup['subgroups'] = [];
    let topCount = 0;
    for (const sub of top.groups ?? []) {
      const subTags = sub.tags ?? [];
      subgroups.push({
        id: sub.id_index,
        name: sub.name,
        color: sub.color,
        tagCount: subTags.length,
      });
      topCount += subTags.length;
      for (const t of subTags) {
        tags.push({
          id: t.id_index,
          text: t.text,
          translate: t.desc ?? '',
          color: t.color ?? '',
          topGroup: top.name,
          group: sub.name,
        });
      }
    }
    groups.push({
      id: top.id_index,
      name: top.name,
      color: top.color,
      subgroups,
      tagCount: topCount,
    });
  }

  const value = { tags, groups };
  return value;
}

/** prompt/fast/autocomplete 的返回 */
export interface AutocompleteItem {
  text: string;
  desc: string;
  color: string;
  color_id: number;
}

export function normalizeAutocomplete(data: AutocompleteItem[] | undefined): WeilinTag[] {
  return (data ?? []).map((t) => ({
    id: t.color_id ?? 0,
    text: t.text,
    translate: t.desc ?? '',
    color: t.color ?? '',
    topGroup: '',
    group: '',
  }));
}

/** prompt/local/translate 的返回 */
export interface TranslateResponse {
  original: string;
  translated: { translate: string; color: string } | string;
}

export function normalizeTranslate(r: TranslateResponse, phrase: string): { original: string; translated: string; color: string } {
  const t = r.translated;
  return {
    original: r.original ?? phrase,
    translated: typeof t === 'string' ? t : (t?.translate ?? ''),
    color: typeof t === 'string' ? '' : (t?.color ?? ''),
  };
}
