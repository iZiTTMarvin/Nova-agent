# Edit 工具文档验证与升级规划

## 文档验证结论

`docs/edit-tool-comparison.md` 是一份**跨项目设计对比文档**，分析了三个外部参考项目（Pi、DeepSeek Reasonix、Claude Code Open）的 Edit 工具实现，并在第四章提出了融合各家精华的"更优异 Edit 工具"设计方案。

### 验证结果摘要

| 项目 | 文档路径 | 实际路径 | 文档描述准确性 |
|------|---------|---------|-------------|
| Pi | `packages/coding-agent/src/core/tools/edit.ts` | `A_Projects\pi-main\packages\coding-agent\src\core\tools\edit.ts` | **已验证** — 所有特性描述与代码一致 |
| DeepSeek Reasonix | `src/tools/fs/edit.ts` | `A_Projects\DeepSeek-Reasonix-main\src\tools\fs\edit.ts` | **已验证** — 所有特性描述与代码一致 |
| Claude Code Open | `src/tools/FileEditTool/` | `Bi_She_Projects\Claude-code-open\src\tools\FileEditTool\` | **已验证** — 所有特性描述与代码一致 |

> **重要说明**：文档中的路径指向的是外部参考项目，而非 nova-agent 自身代码。nova-agent 当前的编辑工具位于 `src/runtime/tools/editTool.ts`，是一个仅 108 行的简单单点替换工具，不具备文档中描述的任何高级特性。

---

## Todo 清单

### Phase 1：文档最终确认（补齐遗漏验证）

- [x] **1.1 验证 Pi edit.ts 核心特性**
  - `edits[]` 多编辑点数组 + 全匹配原始文件语义
  - BOM + 行尾规范处理（`stripBom` / `normalizeToLF` / `restoreLineEndings`）
  - 可插拔操作层 `EditOperations` 接口
  - 文件级突变队列 `withFileMutationQueue`
  - `AbortSignal` 细粒度检查
  - 参数输入容错（JSON 自动 parse、旧格式兼容）
  - 重叠检测
  - 参考文件：`D:\visual_ProgrammingSoftware\A_Projects\pi-main\packages\coding-agent\src\core\tools\edit.ts`

- [x] **1.2 验证 DeepSeek edit.ts 核心特性**
  - `hasRead` 强制先读后改回调
  - 多文件事务回滚 `applyMultiEdit`
  - 多编码支持 `decodeFileBuffer` / `encodeFile`
  - 行尾自适应
  - LCS 动态规划 diff
  - 唯一性校验
  - 增量匹配语义（`state.buf`）
  - 参考文件：`D:\visual_ProgrammingSoftware\A_Projects\DeepSeek-Reasonix-main\src\tools\fs\edit.ts`

- [x] **1.3 修正文档中的路径引用**
  - 文档中的路径是相对于各外部项目根目录的，建议在文档顶部补充说明这三个路径的实际绝对路径，避免混淆
  - 补充说明这三段代码**不在** nova-agent 项目中，是外部参考实现

- [x] **1.4 补充文档缺失的上下文说明**
  - 在文档开头添加一段简要说明：本文档是对三个已存在的开源/参考项目的对比分析
  - 明确标注 nova-agent 当前的 edit 工具（`src/runtime/tools/editTool.ts`）与文档描述的实现差距

---

### Phase 2：架构层重构（P0-P1，必须先做）

- [ ] **2.1 创建可插拔操作层 `EditOperations` 接口**
  - 定义接口：`readFile(path) → Buffer`、`writeFile(path, content)`、`access(path)`、`stat(path)`、`getMtime(path)`
  - 实现默认 `NodeEditOperations`（包装 `fs.promises`）
  - 修改 `editTool.ts` 使用注入的接口而非直接调用 `fs`
  - 位置：`src/runtime/tools/EditOperations.ts`

- [ ] **2.2 实现文件级并发队列 `withFileMutationQueue`**
  - 每个绝对路径一个 Promise 链锁
  - `Map<string, Promise<void>>` 保证同一路径串行化
  - 位置：`src/runtime/tools/fileMutationQueue.ts`

- [ ] **2.3 接入 AbortSignal 支持**
  - `ToolContext.abortSignal` 已在类型中定义，edit 工具全程未使用
  - 在每个 `await` 后检查 `signal.aborted`
  - 将 signal 传递给 `fs.promises` 操作

---

### Phase 3：参数层 + 读取层（P0-P1）

- [ ] **3.1 输入 Schema 改为 `edits[]` + `filePath`**
  - 从 `{ path, old, new }` 改为 `{ filePath, edits: [{ oldText, newText }] }`
  - 向后兼容：旧格式自动转换为新格式
  - `edits` 至少 1 项，`oldText` 不可为空
  - `file_path` 别名兼容

- [ ] **3.2 实现行尾检测与归一化**
  - `detectLineEnding(text)`：检测原始行尾是 CRLF 还是 LF
  - `normalizeToLF(text)`：统一转为 LF
  - `restoreLineEndings(text, ending)`：写回时恢复原始行尾
  - 位置：`src/runtime/tools/editTool.ts` 内或独立的 `lineEnding.ts`

- [ ] **3.3 实现 BOM 处理**
  - `stripBom(text)`：检测并剥离 UTF-8 BOM（`﻿`）
  - 写入前恢复：`bom + finalContent`
  - 位置：融入 3.2 同模块

- [ ] **3.4 实现多编码支持**
  - `decodeFileBuffer(buf)`：检测 UTF-8/UTF-8-BOM/GBK/UTF-16LE/UTF-16BE/Latin-1
  - `encodeFile(text, encoding)`：按原编码写回
  - 可参考 `jschardet` 或 `iconv-lite` 库，或参考 DeepSeek 的自实现
  - 位置：`src/runtime/tools/fileEncoding.ts`

---

### Phase 4：安全门禁（P1-P2）

- [ ] **4.1 实现 ReadState 管理与先读后改检查**
  - 全局 `ReadState`：`get(path) → { content, timestamp, encoding }`
  - `readTool` 读取时写入 `ReadState`
  - `editTool` 执行时检查 `readState.get(path)` 是否存在
  - 不存在则拒绝编辑："请先使用 read_file 工具读取此文件"
  - 参考：DeepSeek 的 `ReadTracker` + Claude Code 的 `readFileState`

- [ ] **4.2 实现 mtime 外部修改检测 + 内容回退**
  - 从 `ReadState` 获取上次读取时的内容和 mtime
  - `fs.stat(path).mtimeMs` 对比当前 mtime
  - mtime 变了但内容相同 → 放行（Windows 云同步假阳性）
  - mtime 变了且内容不同 → 拒绝编辑
  - 参考：Claude Code `FileEditTool.ts` validateInput 方法

- [ ] **4.3 文件大小限制**
  - `fs.stat(path).size > MAX_EDIT_FILE_SIZE` 时拒绝
  - `MAX_EDIT_FILE_SIZE = 1 GiB`
  - 参考：Claude Code `FileEditTool.ts` 第 186-200 行

---

### Phase 5：容错匹配层（P2）

- [ ] **5.1 弯引号规范化**
  - `normalizeQuotes(text)`：弯引号（`"` `"` `'` `'`）→ 直引号（`"` `'`）
  - `preserveQuoteStyle(modelOld, actualOld, modelNew)`：替换时保持文件原有引号风格
  - 含缩写词撇号处理（如 "don't"）
  - 参考：Claude Code `utils.ts` 第 31-199 行

- [ ] **5.2 API 脱敏标签还原**
  - `desanitizeMatchString(sanitized)`：将 `<fnr>` → `<function_results>` 等标签还原
  - 精确匹配失败后用 desanitized 版本再试
  - 参考：Claude Code `utils.ts` DESANITIZATIONS 映射表（15 对）

- [ ] **5.3 尾部空格 strip**
  - 对非 `.md`/`.mdx` 文件，strip `oldText` 和 `newText` 每行的 trailing whitespace
  - 参考：Claude Code `utils.ts` `stripTrailingWhitespace`

---

### Phase 6：编辑执行层（P0-P2）

- [ ] **6.1 改为全匹配原始文件的语义**
  - 所有 `edits[]` 中的 `oldText` 都匹配**原始文件内容**（非增量）
  - 这是设计方案的核心安全语义
  - 参考：Pi 的 `applyEditsToNormalizedContent`

- [ ] **6.2 实现重叠检测**
  - `checkNoOverlapping(resolvedEdits, original)`：确保任意两个编辑点在原文中不重叠
  - 参考：Pi 的 edit.ts

- [ ] **6.3 实现从后往前的替换顺序**
  - 按在原文中的位置降序排序后依次替换
  - 避免位置偏移问题

---

### Phase 7：写入层（P1-P2）

- [ ] **7.1 写入失败回滚**
  - 写入前保存原始 Buffer
  - `try { ops.writeFile() } catch { ops.writeFile(originalBuffer) }`
  - 回滚失败时抛出两层错误信息
  - 与 `withFileMutationQueue` 结合使用
  - 参考：DeepSeek 的 `applyMultiEdit` 逆序回滚

- [ ] **7.2 恢复 BOM + 行尾**
  - 写入前：`finalContent = readResult.bom + restoreLineEndings(newContent, readResult.lineEnding)`

---

### Phase 8：输出层（P3）

- [ ] **8.1 生成 LCS 行级 diff**
  - 实现 `computeLcsDiff(originalLines, newLines)`
  - 渲染格式：`- old line` / `+ new line`（与 git diff 一致）
  - 可复用项目中已有的 `src/shared/diff/compute.ts`（当前仅用于前端 DiffViewer）

- [ ] **8.2 生成 unified patch**
  - `generateUnifiedPatch(path, original, newContent)`：标准 unified diff 格式
  - 可直接用于 `git apply`

- [ ] **8.3 输出变更区域 snippet**
  - `extractSnippet(newContent, resolved, contextLines=4)`：提取编辑点周围上下文行
  - 帮助用户快速定位变更位置

---

### Phase 9：测试与验证（贯穿各 Phase）

- [ ] **9.1 单元测试**
  - 行尾检测/恢复
  - BOM 剥离/恢复
  - 编码检测/往返
  - 弯引号规范化/还原
  - 脱敏标签还原
  - 重叠检测
  - 唯一性校验

- [ ] **9.2 集成测试**
  - 多编辑点 + 全匹配原始文件
  - 先读后改门禁
  - mtime 检测 + 内容回退
  - 写失败回滚
  - 文件并发队列

- [ ] **9.3 向后兼容测试**
  - 旧格式 `{ path, old, new }` 参数自动转换
  - `path` 和 `file_path` 别名兼容

---

## 优先级总览

| 优先级 | Phase | 项数 | 说明 |
|--------|-------|------|------|
| P0 | Phase 3.1, 6.1 | 2 | 核心语义变更：多编辑点 + 全匹配原文 |
| P1 | Phase 2, 3.2-3.4, 4.1-4.2, 7.1 | 9 | 架构基础 + 安全门禁 + 写入安全 |
| P2 | Phase 4.3, 5.1-5.3, 6.2-6.3, 7.2 | 8 | 容错匹配 + 完善保护 |
| P3 | Phase 8.1-8.3 | 3 | 输出美化 |
| - | Phase 1, 9 | 7 | 文档修正 + 测试 |

**总计：约 29 项具体工作。** 建议先完成 Phase 1（补齐文档验证），然后按 P0 → P1 → P2 → P3 顺序实施。

---

## 关键参考文件

| 文件 | 作用 |
|------|------|
| `docs/edit-tool-comparison.md` | 设计方案文档（本文档的验证对象） |
| `src/runtime/tools/editTool.ts` | nova-agent 当前 edit 工具（108 行） |
| `src/runtime/tools/types.ts` | ToolContext / ToolExecutor 类型定义 |
| `src/runtime/tools/ToolRegistry.ts` | 工具注册与路径校验 |
| `src/runtime/checkpoints/CheckpointManager.ts` | 写前备份管理 |
| `src/shared/diff/compute.ts` | 已有 LCS diff 算法（仅前端使用） |
| `A_Projects\pi-main\packages\coding-agent\src\core\tools\edit.ts` | Pi edit 工具参考实现 |
| `A_Projects\DeepSeek-Reasonix-main\src\tools\fs\edit.ts` | DeepSeek edit 工具参考实现 |
| `Bi_She_Projects\Claude-code-open\src\tools\FileEditTool\` | Claude Code edit 工具参考实现 |
