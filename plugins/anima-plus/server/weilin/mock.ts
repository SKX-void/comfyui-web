import type { WeilinLoraEntry, WeilinTag, WeilinTopGroup } from './types.js';

// ---------------------------------------------------------------------------
// mock 数据：让前端在无 WeiLin 时也能开发
// ---------------------------------------------------------------------------

export const MOCK_LORAS: WeilinLoraEntry[] = [
  // 根目录直属
  { path: 'root-lora.safetensors', name: 'root-lora', folder: '', displayName: 'root-lora' },
  // 一级目录直属
  { path: 'Anima\\Anima Turbo LoRA-v0.2.safetensors', name: 'Anima\\Anima Turbo LoRA-v0.2', folder: 'Anima', displayName: 'Anima Turbo LoRA-v0.2' },
  // 二级目录直属（用于验证"不递归"）
  { path: 'Anima\\画师\\taffy-style.safetensors', name: 'Anima\\画师\\taffy-style', folder: 'Anima\\画师', displayName: 'taffy-style' },
  { path: 'Anima\\人物\\mock character.safetensors', name: 'Anima\\人物\\mock character', folder: 'Anima\\人物', displayName: 'mock character' },
];

export const MOCK_TAGS: { tags: WeilinTag[]; groups: WeilinTopGroup[] } = {
  tags: [
    { id: 1, text: 'blue hair', translate: '蓝色头发', color: 'rgba(0,255,255,.4)', topGroup: '人物', group: '头发' },
    { id: 2, text: 'long hair', translate: '长发', color: 'rgba(0,255,255,.4)', topGroup: '人物', group: '头发' },
    { id: 3, text: 'solo', translate: '单人', color: 'rgba(255,123,2,.4)', topGroup: '人物', group: '人数' },
    { id: 4, text: 'looking at viewer', translate: '看向观者', color: 'rgba(120,200,80,.4)', topGroup: '镜头', group: '视线' },
    { id: 5, text: 'simple background', translate: '简单背景', color: 'rgba(200,120,255,.4)', topGroup: '场景', group: '背景' },
  ],
  groups: [
    {
      id: 1, name: '人物', color: 'rgba(255,123,2,.4)', tagCount: 3,
      subgroups: [
        { id: 11, name: '头发', color: 'rgba(255,123,2,.4)', tagCount: 2 },
        { id: 12, name: '人数', color: 'rgba(255,123,2,.4)', tagCount: 1 },
      ],
    },
    {
      id: 2, name: '镜头', color: 'rgba(120,200,80,.4)', tagCount: 1,
      subgroups: [{ id: 21, name: '视线', color: 'rgba(120,200,80,.4)', tagCount: 1 }],
    },
    {
      id: 3, name: '场景', color: 'rgba(200,120,255,.4)', tagCount: 1,
      subgroups: [{ id: 31, name: '背景', color: 'rgba(200,120,255,.4)', tagCount: 1 }],
    },
  ],
};
