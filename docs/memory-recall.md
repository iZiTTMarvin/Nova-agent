# 跨会话记忆

记忆默认关闭。在设置中开启后，新会话首次发送消息时加载核心记忆，Agent 可用 `memory_read` 查看列出的文件，用 `memory_search` 查找未展示的内容，用 `memory_manage` 保存已确认、值得跨会话保留的信息。“自动从对话中学习”是独立开关，默认关闭，开启后可能产生模型费用。

当前用户指令和工作区事实始终优先。记忆可能过时，observed 偏好只作参考；需要核对的条目不会进入开局核心记忆。

## 文件与职责

数据位于 Electron userData 下的 `memory/`：

```text
memory/
├─ global/
│  ├─ preferences.md
│  ├─ conventions.md
│  ├─ decisions.md
│  ├─ workflow.md
│  ├─ gotchas.md
│  ├─ inbox.md
│  ├─ archive.md
│  ├─ MEMORY.md
│  └─ .ledger.jsonl
├─ projects/<name-slug>-<hash16>/
│  ├─ preferences.md / conventions.md / facts.md
│  ├─ decisions.md / workflow.md / gotchas.md
│  ├─ inbox.md / archive.md / MEMORY.md / notes.md
│  ├─ episodic/YYYY-MM.md
│  └─ .ledger.jsonl
├─ _legacy/<old-hash16>/
├─ memory.db
├─ .migration.json
├─ extract-state.json
└─ maintenance-state.json
```

全局范围允许除 `project_fact` 外的所有类别；纯工作区证据归项目。Windows 项目身份按规范化小写路径计算，目录名中的可读项目名不改变身份。

| 职责 | Owner |
| --- | --- |
| 主题、候选、归档和来源账本写入 | MemoryEntryStore |
| 可重建的结构化 SQLite 检索投影 | MemoryIndex |
| 普通 Markdown 文档索引与操作摘要 | MemoryService |
| 核心选择、字符预算、快照文本与派生 MEMORY.md | 纯快照渲染器 |
| 首轮快照与本会话记忆选择的持久化 | SessionStore，通过 turn 准备和专用更新入口 |
| 提炼队列、单飞与持久游标 | MemoryExtractScheduler |
| 保留期、整理计划和定时执行 | MemoryMaintenanceHost |
| 旧数据迁移与未关联目录认领 | LegacyMemoryMigrator |

主题 Markdown 和账本是事实来源，SQLite 可删除后重建。索引不可用时保留文件能力并提供降级诊断。托管文件不会再作为普通文档被重复索引。

## 编辑格式

```markdown
<!-- nova-memory v1 -->
# Conventions

- 发布前检查变更日志  <!-- id=m_7f3ak2q9xd by=user added=2026-10-08 key=release.check aliases=release,deploy pin=1 -->
```

条目是单行 `- ` 列表；元数据放在 HTML 注释中，值使用 URL 编码。`id` 是短稳定标识，`by` 可为 `user`、`verified`、`observed`、`inferred`；`verify=1` 表示需要重新核对。`inbox.md` 中的条目尚未确认，`archive.md` 保留被替代或撤回的历史，并记录类别和状态。

可直接添加没有元数据的列表项，下次同步会补齐标识和手写来源；修改正文会按用户编辑处理。未知元数据和非条目内容保留，损坏行显示解析问题；未来格式只读。文件写入使用指纹校验和原子替换，失败回滚时不会覆盖外部编辑。

`MEMORY.md` 是自动生成的只读视图。普通手写说明请放在 `notes.md`；普通文档正文按需读取，不直接加入核心快照。设置页可预览开局记忆、切换项目/全局范围、编辑文件、置顶和遗忘条目、批准或拒绝候选、查看索引/账本问题与未关联旧目录。含敏感内容的手写保存会先确认；确认框不展示密钥。

## 快照和缓存

只在会话首次发送时生成一次快照，并保存到会话元数据；继续聊天、重新加载和压缩恢复复用原字节。旧会话不会中途补生成。英文包装说明明确记忆是参考数据，不是特权指令。

核心预算分别为全局 800 字符/10 条、项目 1800 字符/20 条；文件索引最多 1400 字符，整个记忆层最多 4000 字符。优先置顶、显式确认和较新的合格条目，超出预算有省略提示。聊天区只收到条数和时间，不收到快照正文。

快照位于 system prompt 最后一层。记忆文件变化不会改写已冻结的快照；按需读取结果通过普通工具历史回放。现有压缩仍可能追加交接包或改变动态工具目录，不能把记忆层稳定理解为整个请求在压缩前后完全相同。

这保护记忆引入的前缀稳定性，不保证供应商缓存命中，也不证明成本一定下降。真实模型效果和缓存收益需要独立付费评测。

## 自动学习和隐私

开启自动学习后，每五轮完成的对话或离开会话可排队提炼；等待空闲后执行，同一时间只有一个后台提炼请求。游标持久化，输入窗口最多 50 条新消息，已有条目提示最多 40 条；模型请求有 30 秒超时和 2000 输出 token 上限。失败最多三次，启动补跑仅处理最近七天最多五个合格会话。

偏好、约定和流程类提炼必须有用户原话证据；工具结果只进入项目范围。候选最多八条，密钥候选整条丢弃。`memory_read`、`memory_search` 和 `memory_manage` 的结果均不作为新的采集或提炼证据。

子代理和学习模式不进入通用记忆。在聊天区或侧栏会话菜单选择“本会话不记忆”后，后续 turn 不注入快照、不注册记忆工具，不写操作摘要；后台请求取消，游标推进到末尾。重新开启前再次推进，关闭期间的对话不会补提炼。当前正在执行的 turn 继续使用其已准备的工具和快照。

工具写入拒绝敏感内容，后台丢弃敏感候选，账本摘录先脱敏再截断。识别包括带连字符的 sk key、Google key、常见 JSON 头 JWT、私钥块和 Authorization 头。记忆文件路径拒绝穿越、隐藏内部文件和符号链接。

## 保留期、整理和迁移

候选超过 60 天清除，最多保留 100 条；归档保留 90 天，操作摘要保留 60 天。后台按本地日期每天维护一次。主题超过 80 条或 24KB 时可提示整理；自动整理需要开启自动学习，手动整理先确认模型费用。整理计划整体校验，用户或置顶条目不能被 retire；每个范围保留最近五份整理备份。学习规则版本提升只清除对应后台生成的 observed/inferred 条目。

遗忘会清除主题、候选、归档、来源账本、索引和派生视图，并连带清除被该条目取代或合并的旧版本。设置页遗忘、拒绝候选和用户要求的 `memory_manage` 撤回走同一入口，按固定顺序执行：先改写所有会话里冻结的记忆快照与 system prompt 记忆层（含草稿和恢复副本）、迁移备份库，再清理整理备份并删除记忆文件，最后合并索引段并截断 WAL；记忆库启用 secure_delete，迁移完成后执行 VACUUM。任一派生副本清理失败时报错且记忆保留，可直接重试；记忆已删除但索引清理失败时会提示，并在下次启动时重试。

被改写快照的旧会话下一轮会失去一次缓存前缀；正在运行的 turn 继续使用已发出的上下文，下一轮起生效，期间的迟到保存不会把已遗忘内容写回。聊天记录本身（包括 `memory_search`、`memory_read` 的工具结果）属于对话事实，不随遗忘改写；如需清除请删除对应会话。操作摘要不随单条遗忘清除，可单独清除；迁移前旧目录里的手写文档也不在单条遗忘范围内。使用工具证据撤回的条目进入归档。

迁移先备份旧数据库和文件，导出并校验后才删除旧结构化表。旧全局 convention/decision/gotcha 保留类别迁入相应主题文件。旧手写 MEMORY.md 转入 notes.md；未能关联的旧项目目录暂存在 `_legacy/`，工作区再次打开后认领。迁移失败保留旧数据并只读降级；不要手动删除备份来解除错误。

## 验证

```powershell
npm run test:memory-integration
npm run test -- tests/unit/runtime/memory tests/unit/runtime/tools tests/unit/main tests/unit/renderer/MemorySettingsPanel.test.tsx
npm run test -- tests/unit/architecture/importBoundaries.test.ts
npm run typecheck
npm run build
```

`test:memory-integration` 自动切换到 Node ABI，并在结束时恢复 Electron ABI。仓库未配置 lint。

`tests/live/memoryUtility.spec.ts` 准备了 `off`、`tool`、`snapshot` 三组隔离项目，按实际文件判定结果，记录工具调用、完整请求前缀断裂、累计与各 turn 首请求缓存命中率、输入 token。`ephemeral` 仅供显式选择的历史负向对照。运行步骤与费用边界见 [真实 API 验证说明](../tests/live/README.md)。这些用例不在默认测试中执行；只有获得用户明确授权后才可运行。
