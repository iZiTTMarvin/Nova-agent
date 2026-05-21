# Changelog

## 2026-05-21

- **feat**: 实现 S7 PermissionManager + bashTool
  - 实现 `PermissionManager`：三模式权限决策引擎（plan deny / default ask / auto allow 危险 deny）
  - 实现 `rules.ts`：规则表 + 危险命令黑名单检测（Unix + Windows 双平台覆盖）
  - 实现 `permissions/types.ts`：权限查询、决策结果、风险等级类型定义
  - 实现 `bashTool`：Shell 命令执行，基于 `child_process.exec`，支持超时终止 + AbortSignal 取消
  - 更新 `AgentLoop`：集成权限判断，ask 模式发射 `permission_request`（含 messageId、riskLevel、reason）
  - 更新 `agentHandler`：注册全部 7 个工具、注入 PermissionManager、同步运行模式、注册 respond-permission IPC
  - 修复 IPC 类型 `permission_request` 补齐 messageId，risk 改为结构化（riskLevel + reason）
  - 新增 33 个单元测试（PermissionManager 23 个 + bashTool 10 个）
  - 补齐 renderer 权限确认弹窗与状态管理，允许/拒绝可回传 runtime
  - 修复 `bashTool` 取消只杀 shell 不杀子进程的问题，改为终止整棵命令进程树
  - 额外新增 5 个回归测试（AgentLoop 权限链路 2 个 + renderer 权限状态 2 个 + bash 后台子进程清理 1 个）

## 2026-05-21

- **feat**: 实现 S6 CheckpointManager + 写入工具
  - 实现 `CheckpointManager`：写前备份、manifest 管理、事务边界控制
  - 实现 `editTool`：精确字符串替换修改已有文件，支持歧义检测
  - 实现 `writeTool`：整文件写入/新建，自动创建目录
  - 更新 `AgentLoop`：集成 checkpoint 事务管理、plan 模式写入拦截
  - 扩展 `ToolContext` 类型，支持 checkpoint 注入
  - 新增 24 个单元测试（CheckpointManager 9 个 + 写入工具 15 个）
