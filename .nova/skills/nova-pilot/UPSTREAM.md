# 领航方法来源

本目录的领航工作流参考并改编自 `cursor/plugins` 的 `pstack` 插件。它只作为方法来源，不是 Nova 的运行时依赖。

- 上游仓库：https://github.com/cursor/plugins
- 上游目录：`pstack/`
- 参考版本：`0.15.36`
- 固定提交：`c742dd61706fbacc1b95f1a20b7b988cf096ce6c`
- 许可证：MIT，Copyright (c) 2026 Lauren Tan（完整许可见仓库根目录 `THIRD_PARTY_NOTICES.md`）

升级时另取一个明确提交，对照本文件逐项比较差异，只吸收对领航目标有实际收益的改动，并同步更新固定提交与第三方许可信息。不要在工作区直接拉取上游覆盖本目录。

## 来源与目标对应

| 上游来源（固定提交） | Nova 目标 | 主要删除或改写 |
| --- | --- | --- |
| `skills/poteto-mode/SKILL.md` | `SKILL.md` | 模型角色与模型 slug、默认子代理派遣、Task 参数、PR 与 babysit 流程、Cursor Custom Mode 操作、`/loop`、Arena 与对抗审查、外部动作自由执行、人格化品牌 |
| `skills/in-your-own-words/SKILL.md` | `SKILL.md` 的目标复述规则 | 新增等待确认门 |
| `skills/poteto-mode/playbooks/investigation.md` | `workflows/investigation.md` | 上游 `how` / `why` 技能路由、throughput checkpoint、PR 与 babysit 步骤 |
| `skills/poteto-mode/playbooks/feature.md` | `workflows/feature.md` | 强制 code 子代理、固定模型、Arena、四段 throughput 待办、commit 与 Opening a PR |
| `skills/poteto-mode/playbooks/bug-fix.md` | `workflows/bug-fix.md` | 强制委托修复、固定模型、自动提交复现、`/loop`、PR 流程 |
| `skills/poteto-mode/playbooks/refactoring.md` | `workflows/refactoring.md` | 自动子代理、Arena、rebase、commit 与 PR 流程 |
| `skills/poteto-mode/playbooks/prototype.md` | `workflows/prototype.md` | control 技能依赖、Cursor 专属草稿目录约定 |
| `skills/poteto-mode/playbooks/perf-issue.md` | `workflows/performance.md` | 固定模型、固定子代理、benchmark-checklist 技能依赖、PR 流程 |
| `skills/figure-it-out/SKILL.md` | `workflows/general.md` | 内部 Phase A–E 状态机、强制审查者、审计文件与提交、PR 工作流 |
| `skills/architect/SKILL.md` | `workflows/general.md` 的设计重估部分 | 强制 Arena、多模型设计竞赛、默认接口草模提交 |
| `skills/create-verification-skill/SKILL.md` | `workflows/verification.md` | Cursor 专属目录、强制生成大型 feature map、每日维护循环 |
| `skills/create-formal-verification-skill/SKILL.md` | `workflows/verification.md` 的高风险边界部分 | 作为普通任务默认步骤、pstack `/statechart` 技能引用 |
| `skills/principle-prove-it-works/SKILL.md` | `SKILL.md` 交付与 `workflows/verification.md` | 新增独立验证角色或阶段、审计产物提交要求 |
| `skills/principle-experience-first/SKILL.md` | `SKILL.md` 汇报原则 | 用体验原则引入无边界原型工作 |
| `skills/principle-fix-root-causes/SKILL.md` | `workflows/bug-fix.md` | 无（保留根因定位与同模式排查） |
| `skills/principle-laziness-protocol/SKILL.md` | `workflows/general.md` 与 `workflows/refactoring.md` | 把“最小”当成不验证或漏做范围的借口 |
| `skills/principle-guard-the-context-window/SKILL.md` | `SKILL.md` 按需读取工作流 | 所有任务默认派生子代理、固定 phase 预算 |
| `skills/principle-never-block-on-the-human/SKILL.md` | `SKILL.md` 自主推进边界 | 对外部写入、高风险动作或真实偏好问题也不询问 |

上游其余文件（Arena、swarm、interrogate、babysit、shipping、autopilot、worktree、eval 等）没有纳入首版领航方法包，因为它们要么依赖 Nova 不提供的执行面，要么会与领航“不自动审查、不自动发布”的边界冲突。

## 保留的上游原则

- 先复述目标，再开始工作，不为确认而停顿。
- 能靠观察回答的问题不问用户；只有目标、偏好和不可逆动作需要用户决定。
- 先理解系统与数据形状，再写代码。
- 修复要追到最早的破坏点，不在下游打补丁。
- 结构改变必须固定行为契约，并在真实产物上证明等价。
- 原型只用于做决策，不进入生产。
- 验证要看真实产物，自述和“能编译”不算证明。
- 证据存在不等于验证通过，未验证的部分要明说。
- 上下文按需加载，不把所有方法一次性塞进主线程。
