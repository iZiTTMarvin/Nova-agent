# Changelog

## 2026-05-21

- **feat**: 实现 S9 SessionStore + 回退能力
  - 新增 `src/runtime/sessions/types.ts`：会话类型定义（SessionSummary、SessionData、SessionMessage、SessionToolCall）
  - 新增 `src/runtime/sessions/SessionStore.ts`：会话持久化模块，支持创建/加载/列表/删除会话、追加消息
  - 新增 `src/runtime/checkpoints/restore.ts`：按文件拒绝（rejectFile）和按消息回退（revertToMessage），清理 checkpoint 目录和会话历史
  - 新增 `src/main/ipc/sessionHandler.ts`：会话管理和回退操作的 IPC handler（load-sessions、load-session、create-session、accept-file、reject-file、rollback-message）
  - 更新 `shared/session/types.ts`：新增 SessionDetail 类型（继承 Session + messages）
  - 更新 `shared/ipc/types.ts` 和 `channels.ts`：新增 create-session IPC 通道，load-session 返回 SessionDetail
  - 更新 `main/ipc/agentHandler.ts`：注入 CheckpointManager 和 SessionStore，每轮消息后保存会话快照
  - 更新 `main/ipc/registerHandlers.ts`：注册 sessionHandler
  - 更新 `renderer/stores/useAppStore.ts`：selectProject 通过 IPC 创建真实会话，selectSession 从后端加载历史消息，新增 rollbackMessage 和 rejectFile 方法
  - 新增 30 个单元测试（SessionStore 17 + restore 13）

## 2026-05-21

- **feat**: 实现 S8 Settings UI（模型配置）
  - 新增 `src/runtime/model/config.ts`：配置持久化与校验的统一模块
    - `validateModelConfig`：字段级校验（baseUrl 必须 http/https 开头、apiKey 非空、modelId 非空），trim 前后空白
    - `saveModelConfig`：校验通过后持久化到磁盘，校验失败抛异常；返回 trim 后的合法配置
    - `loadModelConfig`：从磁盘加载配置，复用 `validateModelConfig` 做强校验，坏配置静默返回 null
  - 重构 `configHandler.ts`：去除冗余校验逻辑，统一由 `saveModelConfig` / `loadModelConfig` 负责校验和读写
  - 重构 `main/index.ts`：启动加载配置改用 `loadModelConfig` 模块，移除内联 fs 读写
  - 完善 `SettingsModal.tsx`：字段级错误展示、URL 格式校验、输入变化时自动清除对应错误
  - 修复 `OpenAICompatibleModelClient` URL 拼接：从 `/v1/chat/completions` 改为 `/chat/completions`，避免用户填写含 `/v1` 的 baseUrl 后请求打到 `/v1/v1/`
  - 新增 25 个单元测试覆盖：校验成功/失败/边界、配置读写/覆盖/容错、save 校验抛异常、load 校验拦截坏配置（缺 apiKey、空 apiKey、非法 URL）

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
