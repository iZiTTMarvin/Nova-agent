# Changelog

## 2026-05-21

- **feat**: 实现 S6 CheckpointManager + 写入工具
  - 实现 `CheckpointManager`：写前备份、manifest 管理、事务边界控制
  - 实现 `editTool`：精确字符串替换修改已有文件，支持歧义检测
  - 实现 `writeTool`：整文件写入/新建，自动创建目录
  - 更新 `AgentLoop`：集成 checkpoint 事务管理、plan 模式写入拦截
  - 扩展 `ToolContext` 类型，支持 checkpoint 注入
  - 新增 24 个单元测试（CheckpointManager 9 个 + 写入工具 15 个）
