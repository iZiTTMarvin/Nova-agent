# Skill 投递与历史恢复

用户消息保存原始 slash 文本。实际发送的技能正文和任务提示冻结在对应 assistant 的 `userDelivery.skillInput` 中，与 `sessionPrefix`、`modeInstruction` 一起先写入现有 `turnDraft`，再随回复归档。恢复不读取当前技能文件。

首发与恢复共用 `projectUserMessages`。普通用户输入使用 `{ messageId: userMessageId, step: 0 }`；技能正文使用 step 0，实际用户提示使用 step 1。技能正文上的本地 `inputPrelude` 标记让压缩切点与历史切尾回退到整个输入单元的起点，不进入模型请求。账本拒绝只折叠正文、留下孤立任务提示的区间。原始用户约束仍从用户消息提取，不把展开指令改写为用户原话。

压缩仍只要求待折叠的持久化前缀一致。执行中的技能输入、assistant 和 tool 尾部不必先归档；它们留在尾部，不阻塞旧前缀的提交。

## 原生命令

`src/shared/commands/index.ts` 是内置命令目录、参数校验与命令名称的唯一来源；Renderer 候选和主进程路由不得各自维护同名清单。当前 `/init` 进入普通 Agent 回合，用户消息保存原始 `/init` 文本，展开后的工作区初始化指令记录在 `userDelivery.deliveredInput`，不得写入 `skillInput` 或按当前文件重算历史。

`/compact` 通过普通 durable run 调用压缩 Owner，复用同一会话的互斥、取消、执行 fence 与终态提交。当前命令原文先进入运行时上下文，再提交 `manual` 类型的压缩账本，避免持久化叶子与压缩前沿错位。无可折叠内容或不减少上下文时返回真实回执，不伪造压缩结果。

`/plan` 直接请求 WorkspaceService 切换模式，不创建模型回合。用户命令与模式切换回执由 SessionStore 持久化，再通过 `messagesRevision` 驱动 Renderer 重新水合；本地完成结果不等待 run snapshot。

## 兼容与回退

新写入的消息使用 `messageSchemaVersion: 5`。读取器继续接受无版本和版本 1–4 的历史消息。没有 `skillInput` 的记录保持原有回放行为，不猜测历史技能正文；该兼容行为只有在不再支持这些存量记录时才能删除。旧格式读取、完整事实往返和中断草稿恢复由 session 与 message facts 测试保护。

旧版本读取器不支持版本 5。回退程序前应恢复升级前的会话与 run 存储备份；不能只降低消息版本号，因为旧投影不理解技能输入的两个坐标。新产生的未归档 run 草稿同样不能交给旧程序恢复。没有无损的自动降级转换；回退备份会失去备份之后的对话。

## 直接委托终态

直接 `/skill` fork 在分派前通过现有投递事实保存父用户坐标，不为父模型伪造未发送的技能正文或模式指令。即使正式归档暂时失败，遗留草稿仍能按原用户消息恢复。

直接 `/skill` fork 的子任务状态经 `AgentTurnOutcome` 传递，不以摘要存在或 Promise resolve 作为成功证据。失败、取消、中断分别收敛为既有 durable 终态；截断保留 `incompleteReason`，durable 状态仍是 completed。缺少截断原因的结果按失败处理，不捏造停止原因。普通 task 与 invoke_skill 工具仍返回工具结果，由父模型决定是否继续。
