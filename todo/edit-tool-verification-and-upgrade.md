# Edit 工具升级 — 审查参考

> **目标**：将 nova-agent 的 Edit 工具从简单的单点替换升级为融合 Pi / DeepSeek / Claude Code 三家精华的生产级实现。
>
> **设计规格书**：`docs/edit-tool-comparison.md`
> **外部参考实现**：
> - Pi：`D:\visual_ProgrammingSoftware\A_Projects\pi-main\packages\coding-agent\src\core\tools\edit.ts`
> - DeepSeek：`D:\visual_ProgrammingSoftware\A_Projects\DeepSeek-Reasonix-main\src\tools\fs\edit.ts`
> - Claude Code：`D:\visual_ProgrammingSoftware\Bi_She_Projects\Claude-code-open\src\tools\FileEditTool\`

---

## 一、最终文件结构（2 个新文件）

```
src/runtime/tools/
├── editTool.ts      # 575 行 — 工具运行时：管线、安全门禁、匹配、写入、状态管理
├── editDiff.ts      # 298 行 — 纯文本处理：编码、行尾、BOM、diff、patch、snippet
└── readTool.ts      # 修改 — 新增 ReadState 写入，实现"先读后改"门禁
```

---

## 二、editTool.ts 结构审查（575 行）

### 2.1 导入与类型定义

| 模块 | 来源 | 职责 |
|------|------|------|
| `ToolRegistry` | `./ToolRegistry` | 路径解析与工作区边界校验 |
| `ToolExecutor, ToolContext, ToolResult` | `./types` | 工具执行器类型 |
| `EditOperations, nodeEditOperations` | 内联在 editTool.ts | 可插拔文件 I/O 接口（readFile/writeFile/access/stat） |
| `readState, ReadState` | 内联在 editTool.ts | 先读后改安全状态管理 |

### 2.2 从 editDiff.ts 导入的纯文本工具

| 函数 | 职责 |
|------|------|
| `decodeFileBuffer` / `encodeFile` | 多编码检测与往返（UTF-8/GBK/UTF-16LE/Latin-1） |
| `stripBom` / `detectLineEnding` / `normalizeToLF` / `restoreLineEndings` | BOM 剥离/恢复 + 行尾检测/归一化/恢复 |
| `lineDiff` / `renderLineDiff` | LCS 动态规划行级 diff |
| `generateUnifiedPatch` | 标准 unified diff 格式（可用于 git apply） |
| `extractSnippet` | 变更区域缩略（±4 行上下文） |
| `computeFirstChangedLine` | 第一个变更行号 |
| `normalizeQuotes` / `findActualString` / `preserveQuoteStyle` | 弯引号容错匹配 |
| `desanitizeMatchString` | API 脱敏标签还原（15 对映射） |

### 2.3 内部函数与管线

| 函数 | 职责 |
|------|------|
| `readFileForEdit` | 读取 → 解码 → 去 BOM → 转 LF，返回 `ReadForEditResult` |
| `safetyGate` | 三层检查：① 是否读过 ② mtime 外部修改 + 内容回退 ③ 文件大小 ≤ 1 GiB |
| `normalizeInput` | 向后兼容旧格式 `{path,old,new}` → 新格式 `{filePath, edits[]}`，JSON 字符串自动 parse |
| `resolveEdits` | 编辑解析：精确匹配 → 弯引号容错 → 脱敏还原 → 唯一性校验 → 重叠检测 |
| `applyResolvedEdits` | 从后往前替换，保持原始文件匹配语义（非增量） |
| `safeWrite` | 并发队列 + BOM/行尾恢复 + 写入失败自动回滚 |
| `withFileMutationQueue` | 文件级并发队列（同文件串行，异文件并行） |
| `execute` | 主管线：access → readFileForEdit → safetyGate → resolveEdits → applyResolvedEdits → safeWrite → buildResult |

### 2.4 参数 Schema

- `filePath`：文件路径（兼容 `path` / `file_path` 别名）
- `edits[]`：`[{ oldText, newText }]` 多编辑点数组
- 向后兼容：旧格式 `{ path, old, new }` 自动转换
- 兼容 edits 为 JSON 字符串的情况

### 2.5 安全检查点

- AbortSignal：每个 `await` 后调用 `throwIfAborted()`
- 先读后改：readTool 写入 ReadState → editTool 检查
- mtime 检测：文件被外部修改后拒绝编辑（内容未变则放行，处理 Windows 假阳性）
- 文件大小：超过 1 GiB 拒绝
- 写前备份：`checkpointManager.backupBeforeWrite`
- 写失败回滚：写入失败自动恢复原始内容
- 并发互斥：`withFileMutationQueue` 同文件串行化

---

## 三、editDiff.ts 结构审查（298 行）

所有函数都是**纯文本变换**，无副作用，无外部依赖（除 Node.js 内置模块）。

| 模块 | 函数 | 行数（估） |
|------|------|-----------|
| 多编码 | `decodeFileBuffer`, `encodeFile`, `FileEncoding` 类型 | ~130 |
| 行尾/BOM | `stripBom`, `detectLineEnding`, `normalizeToLF`, `restoreLineEndings` | ~30 |
| 引号容错 | `normalizeQuotes`, `findActualString`, `preserveQuoteStyle`, `applyCurlyDoubleQuotes`, `applyCurlySingleQuotes` | ~80 |
| 脱敏还原 | `DESANITIZATIONS` 映射表, `desanitizeMatchString`, `applyCorrespondingDesanitization` | ~30 |
| LCS diff | `lineDiff`（DP 最长公共子序列）, `renderLineDiff` | ~60 |
| 输出 | `generateUnifiedPatch`, `extractSnippet`, `computeFirstChangedLine` | ~30 |

---

## 四、readTool.ts 修改（重点审查）

`readTool` 新增了读取后写入 ReadState 的逻辑，这是"先读后改"门禁的基础：

```typescript
// 读取文件后
const buf = readFileSync(validated.path)
const { text } = decodeFileBuffer(buf)
const { text: stripped } = stripBom(text)
const normalized = normalizeToLF(stripped)

// 写入 ReadState：内容 + mtime
const stat = statSync(validated.path)
readState.set(validated.path, {
  content: normalized,     // 已归一化（去 BOM、统一 LF）
  timestamp: stat.mtimeMs, // 读取时的 mtime
})
```

---

## 五、设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 匹配语义 | 全匹配原始文件（非增量） | Pi 方案，避免 DeepSeek 增量匹配的级联错位 |
| 编辑粒度 | 多编辑点 `edits[]` | Pi 方案，一次调用改多处，Token 效率高 |
| 先读后改 | ReadState + mtime + 内容回退 | Claude Code 方案，防幻觉 + 防覆盖 + 防假阳性 |
| 写失败恢复 | try-catch 回滚 | DeepSeek 方案，唯一的原子恢复实现 |
| 并发控制 | Promise 链队列 | Pi 方案，事前互斥而非事后检测 |
| 文件结构 | editTool.ts + editDiff.ts（2 文件） | 与 Pi 一致：运行时逻辑 vs 纯文本处理 |
| 丢掉的糟粕 | 增量匹配、IDE 耦合、TUI 状态机 | 见设计文档第 5 节"该丢掉的糟粕" |

---

## 六、测试覆盖

### 6.1 已有测试文件

- `editTool.test.ts` — execute 管线端到端测试
- `editDiff.test.ts` — 纯文本处理函数测试
- `desanitizeMatch.test.ts` — 脱敏还原测试
- `fileEncoding.test.ts` — 编码往返测试
- `fileMutationQueue.test.ts` — 并发队列测试
- `lineEnding.test.ts` — BOM/行尾测试
- `quoteNormalizer.test.ts` — 弯引号容错测试
- `resolveEdits.test.ts` — 匹配引擎测试

### 6.2 审查时需验证的测试场景

| 场景 | 预期行为 |
|------|---------|
| 多编辑点 | 所有 oldText 匹配原始文件，结果正确 |
| 旧格式兼容 | `{ path, old, new }` 自动转换 |
| edits 是 JSON 字符串 | 自动 parse |
| 未读文件编辑 | 拒绝："请先用 read 工具读取此文件" |
| 外部修改后编辑 | 拒绝："文件已被外部修改，请重新读取" |
| mtime 变但内容未变 | 放行（Windows 云同步假阳性） |
| 文件超过 1 GiB | 拒绝 |
| oldText 出现多次 | 拒绝并提示提供更多上下文 |
| 编辑点重叠 | 拒绝并提示合并为一个 edit |
| 写入失败 | 文件恢复原始内容 |
| 回滚也失败 | 抛两层错误信息 |
| 同文件并发编辑 | 串行执行，无竞态 |
| 异文件并发编辑 | 并行执行 |
| AbortSignal 触发 | 优雅中断 |
| 弯引号文件 | 自动容错匹配，保持原始引号风格 |
| 脱敏标签 | 自动还原后匹配 |
| GBK 编码文件 | 正确检测并往返编码 |
| UTF-16LE/BOM 文件 | 正确剥离/恢复 |
| CRLF 文件 | 内部 LF 处理，写入时恢复 CRLF |

---

## 七、遗留事项

- [ ] 测试文件的 import 路径需要与合并后的文件结构一致
- [ ] `tests/unit/runtime/tools/writeTools.test.ts` 有未暂存修改（可能与本次 Edit 升级相关，需检查）
- [ ] 运行完整测试套件验证无回归
- [ ] TypeScript 类型检查通过
