# 归档：历史文档

这里的文件**不是现行文档**，只回答"当时是怎么想的、怎么做的"。写代码时不要照着实现——
现行文档在上一层：[`docs/README.md`](../README.md)（索引）、[`architecture.md`](../architecture.md)（设计）、
[`config.md`](../config.md)（配置）。

| 文件 | 是什么 | 它的现行替代 |
|---|---|---|
| `v1-readme.md` | v1 **单体服务**的操作手册（`apps/server` :8086，已删除） | 仓库根 `README.md` |
| `v1-architecture.md` | v1 单体架构设计（含当时的句柄 `db`/`buffer` 设想） | `architecture.md` §3–§5 |
| `v1-plan.md` | v1 项目计划（目标、调研结论、风险登记） | 无 |
| `v1-roadmap.md` | v1 里程碑 M0–M5 与验收标准 | 无 |
| `v1-api.md` | v1 的对外 API 讨论稿 + ComfyUI 上游接口笔记 | 对外接口看 `architecture.md` §5；上游调用看 `plugins/anima-*/server/` |
| `v1-templates.md` | 模板层设计（`ui.max` / `transform` 那套） | 工作流定义现在是插件私有资产（D22：不存在「模板」这层抽象），见 `plugins/anima-plus/README.md` |
| `v2-implementation-notes.md` | v2 第一批落地的过程记录（交付计划、14.1b–14.1h、实测证据） | `architecture.md` §11–§14 |
| `架构思路.md` | v1 时代的架构思路稿（这套插件化设计的出发点，中文） | `architecture.md` §0–§2 |

两个**插件的**设计记录没有放这里，而是放在插件旁边（它们是活文档，只是写得比代码早）：

- [`plugins/anima-plus/docs/weilin.md`](../../plugins/anima-plus/docs/weilin.md) —— WeiLin 对接方案
- [`plugins/anima-plus/docs/safety.md`](../../plugins/anima-plus/docs/safety.md) —— 硬件安全护栏规则

> 约定：**新文档不要再往这里丢过程叙事**。落地过程写进归档只有一种情况——它已经完成、结论已经进主文档，
> 而"为什么踩了这个坑"值得留个记录。
