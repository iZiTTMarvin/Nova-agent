# Edit 工具三家对比分析

> **文档说明**：本文档是对三个已存在的开源项目的 Edit 工具实现的横向对比分析，并在此基础上提出融合设计方案。
> 文中所有代码路径均为各项目内部的相对路径，三段代码**不在当前 nova-agent 项目中**。
> 三个外部项目的实际位置如下：
> - **Pi**：`D:\visual_ProgrammingSoftware\A_Projects\pi-main\`
> - **DeepSeek Reasonix**：`D:\visual_ProgrammingSoftware\A_Projects\DeepSeek-Reasonix-main\`
> - **Claude Code Open**：`D:\visual_ProgrammingSoftware\Bi_She_Projects\Claude-code-open\`
>
> nova-agent 当前的编辑工具位于 `src/runtime/tools/editTool.ts`（约 108 行，简单单点替换），与本文档描述的实现存在较大差距。
> 本文档第四章提出的"更优异 Edit 工具设计方案"即为 nova-agent Edit 工具的升级目标。

## 代码路径

| 项目 | 路径（相对于各项目根目录） | 实际绝对路径 |
|------|------|------|
| **Pi** | `packages/coding-agent/src/core/tools/edit.ts` | `A_Projects\pi-main\packages\coding-agent\src\core\tools\edit.ts` |
| **DeepSeek Reasonix** | `src/tools/fs/edit.ts` | `A_Projects\DeepSeek-Reasonix-main\src\tools\fs\edit.ts` |
| **Claude Code Open** | `src/tools/FileEditTool/FileEditTool.ts` | `Bi_She_Projects\Claude-code-open\src\tools\FileEditTool\FileEditTool.ts` |

辅助文件（Claude Code 的 FileEditTool 拆分为多个模块）：

| 文件 | 职责 |
|------|------|
| `src/tools/FileEditTool/FileEditTool.ts` | 工具主体：校验、执行、权限、mtime 检查 |
| `src/tools/FileEditTool/utils.ts` | 引号规范化、脱敏还原、patch 生成、snippet 提取 |
| `src/tools/FileEditTool/types.ts` | 输入输出 schema |
| `src/tools/FileEditTool/prompt.ts` | 工具描述和提示词 |
| `src/tools/FileEditTool/UI.tsx` | React/Ink 终端渲染组件 |
| `src/tools/FileEditTool/constants.ts` | 常量 |

---

## 1. 三家 Edit 工具定位总览

| 维度 | **Pi** | **DeepSeek Reasonix** | **Claude Code Open** |
|------|--------|----------------------|---------------------|
| **工具名** | `edit` | `edit_file` / `multi_edit` | `Edit` |
| **编辑粒度** | 多编辑点 `edits[]`，一次调用改多处 | 单编辑 `search→replace` 或跨文件多编辑 | 单编辑 `old_string→new_string`，改多处需多次调用 |
| **匹配基准** | 全匹配**原始文件**（非增量，禁止重叠） | **增量匹配**（`state.buf` 被每次编辑更新，后续匹配的是修改后的内容） | 全匹配**原始文件** |
| **核心定位** | 精确、安全的多点编辑，重体验 | 多文件协同编辑，重恢复能力 | 安全的单点编辑，重防御性 |

---

## 2. 逐家详细分析

### 2.1 Pi (`packages/coding-agent/src/core/tools/edit.ts`)

#### 精华

**a) "全匹配原始文件"的多编辑语义（最大亮点）**

这是三家中最安全的编辑语义。`edits[]` 数组中每一个 `oldText` 都匹配**原始文件内容**，而不是前一个编辑已经修改后的结果。这从根本上避免了级联错位问题——模型不需要"按顺序思考"，只要每个 `oldText` 在原文中能找到就行。同时强制校验编辑点之间不重叠，防止意外交叉修改。

```typescript
// 核心逻辑：所有 oldText 匹配原始文件
const { baseContent, newContent } = applyEditsToNormalizedContent(
  normalizedContent,  // 原始文件内容
  edits,              // 所有编辑点
  path
);
```

**b) BOM + 行尾规范处理**

`stripBom` → `normalizeToLF` → `restoreLineEndings` 三步流水线，跨平台（Windows CRLF / Unix LF）编辑不踩坑。模型给的是 LF，但文件可能是 CRLF，内部统一用 LF 处理，写入时再恢复原始行尾。BOM 同理——模型不会在 `oldText` 里包含不可见的 BOM，所以先剥离再匹配。

```typescript
const { bom, text: content } = stripBom(rawContent);
const originalEnding = detectLineEnding(content);
const normalizedContent = normalizeToLF(content);
// ... 在 LF 基础上做所有处理 ...
const finalContent = bom + restoreLineEndings(newContent, originalEnding);
```

**c) 可插拔操作层 `EditOperations`**

通过接口抽象文件 I/O，天然支持远程文件系统（SSH）、虚拟文件系统、测试 mock：

```typescript
export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}
```

**d) 文件级突变队列 `withFileMutationQueue`**

保证同一文件的并发编辑串行化，防止两个 agent 同时写一个文件导致数据竞争。

**e) AbortSignal 细粒度检查**

每个 `await` 后检查 `signal.aborted`，可以在长时间编辑中优雅中断，不会因为一个 await 卡死整个流程。

**f) 参数输入容错**

兼容多种模型输入习惯：
- `edits` 如果是 JSON 字符串自动 parse（某些模型把数组当字符串发）
- 兼容 legacy 格式的单个 `oldText/newText`
- `path` 或 `file_path` 两种键名都接受

#### 糟粕

- **没有 read-before-edit 保护**：模型可能不读文件就凭幻觉调用 edit，造成不可逆损坏。
- **没有外部修改检测**：文件被用户或 linter 改了之后，工具会静默覆盖，丢失他人的修改。
- **没有写失败回滚**：写入过程如果崩溃，文件会处于半残状态。
- **仅支持 UTF-8**：没有检测其他编码（GBK、Latin-1、UTF-16 等）。

---

### 2.2 DeepSeek Reasonix (`src/tools/fs/edit.ts`)

#### 精华

**a) `hasRead` 强制先读后改**

工具接收一个 `hasRead(abs: string) => boolean` 回调，检查文件是否在本次会话中被读过。如果没读就拒绝编辑，并要求模型先调用 `read_file` 工具：

```typescript
if (hasRead && !hasRead(abs)) {
  throw new Error(
    `edit_file: ${rel} was not read this session — ${READ_BEFORE_EDIT_MARKER} so your SEARCH matches the bytes on disk.`
  );
}
```

**b) 多文件事务回滚（`applyMultiEdit`）**

这是三家唯一实现了原子回滚的。写入前把每个文件原始内容存入 `attempted` 数组，写入过程中如果任意文件失败，按逆序将所有已写入的文件恢复为原始内容。如果回滚本身也失败了，抛出包含两层错误信息的异常：

```typescript
const attempted = [];
try {
  for (const [abs, state] of filesByPath) {
    attempted.push({ abs, before: state.before, encoding: state.encoding });
    await fs.writeFile(abs, encodeFile(state.buf, state.encoding));
  }
} catch (writeErr) {
  // 逆序回滚
  for (const item of [...attempted].reverse()) {
    try { await fs.writeFile(item.abs, encodeFile(item.before, item.encoding)); }
    catch (restoreErr) { rollbackFailures.push(...); }
  }
  throw new Error(`write failed: ${writeErr}; rolled back all files`);
}
```

**c) 多编码支持 `decodeFileBuffer` / `encodeFile`**

不只是 UTF-8，能检测并处理 GBK、Latin-1、UTF-16 等多种编码，在非英文代码库中很重要。

**d) 行尾自适应**

把模型给的 `search`/`replace` 中的 `\n` 自动适配为文件实际行尾（`\r\n` 或 `\n`），减少因行尾差异导致的匹配失败。

**e) LCS 动态规划 diff**

`lineDiff` 用最长公共子序列算法逐行计算差异，diff 质量比简单的整块对比更高，且渲染格式与 git 的 `- old / + new` 约定一致。

**f) 严格的唯一性校验**

`search` 在原文件中出现次数 > 1 时直接拒绝，要求模型提供更多上下文来消除歧义，避免误改。

#### 糟粕

- **增量匹配语义是最大隐患**：`applyMultiEdit` 中 `state.buf` 在每次编辑后被更新，后续编辑的 `search` 匹配的是已被修改过的内容。这要求模型必须精确理解"编辑顺序"，一旦顺序错乱，后面的编辑会全部错位甚至找不到匹配。
- **没有 BOM 处理**：如果文件有 UTF-8 BOM，模型给的 `search` 不含 BOM，匹配会失败。
- **没有 AbortSignal**：长时间操作无法中断。
- **单文件 `applyEdit` 没有回滚**：回滚只在 `applyMultiEdit` 中实现。
- **没有并发控制**：多个并发 edit 调用可能互相覆盖。

---

### 2.3 Claude Code Open (`src/tools/FileEditTool/`)

#### 精华

**a) 最强的 read-before-write 安全体系**

Claude Code 的 `readFileState` 不仅记录"是否读过"，更记录了读取时间戳和完整归一化内容。写入前做双重校验：

1. **mtime 检查**：`getFileModificationTime(path) > readTimestamp` → 文件被外部修改过。
2. **内容回退逻辑**：即使 mtime 变了，如果内容实际未变（Windows 云同步、杀毒软件触发的 mtime 扰动），也放行——避免误报。

```typescript
if (lastWriteTime > readTimestamp.timestamp) {
  const isFullRead = lastRead.offset === undefined && lastRead.limit === undefined;
  if (isFullRead && fileContent === readTimestamp.content) {
    // 内容未变，安全放行（Windows 上的云同步扰动）
  } else {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
  }
}
```

**b) 引号规范化 `findActualString` + `preserveQuoteStyle`（独有亮点）**

模型无法输出弯引号（`"` `"` `'` `'`），只能输出直引号。但文件里可能含弯引号（如中文排版、Word 文档转出的代码、某些 prettier 配置）。Claude Code 的 `findActualString` 会：

1. 先尝试精确匹配
2. 失败时把文件内容和 `old_string` 都归一化为直引号再匹配
3. 找到后返回文件中的**实际字符串**（含弯引号）
4. `preserveQuoteStyle` 在替换时把 `new_string` 中的直引号还原为弯引号

```typescript
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  // 归一化弯引号再找
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }
  return null;
}
```

**c) API 脱敏标签还原 `desanitizeMatchString`**

API 返回时某些标签（如 `<function_results>`、`<system>` 等）会被 sanitize 为缩略形式（`<fnr>`、`<s>`），模型输出的 `old_string` 用的是 sanitize 后的版本。如果精确匹配失败，`desanitizeMatchString` 会自动还原，尝试二次匹配。

**d) 输入规范化 `normalizeFileEditInput`**

- 自动 strip 行尾的 trailing whitespace（但跳过 `.md`/`.mdx`，因为 Markdown 用两个尾部空格表示硬换行）
- 组合使用 desanitize
- 使用缓存文件内容避免重复 I/O

**e) 大文件保护**

`validateInput` 阶段用 `stat` 检查文件大小，超过 1 GiB 直接拒绝，防止 OOM。

**f) 文件不存在时的智能提示**

当 `old_string === ''` 且文件不存在时，允许创建新文件。当 `old_string !== ''` 但文件不存在时，不仅报错，还尝试 `findSimilarFile` 查找同路径不同扩展名的文件，建议正确的路径。

#### 糟粕

- **单编辑设计 Token 效率低**：大文件改 10 处要调 10 次，每次都要携带完整的 `old_string + new_string`。模型输出的 token 消耗是 Pi 方案的 N 倍。
- **IDE 深度耦合**：LSP `didChange`/`didSave`、VSCode MCP 文件更新通知、技能目录自动发现、Git diff 获取、设置文件特殊验证——这些让工具本身无法脱离 Claude Code 环境独立使用。
- **没有显式写失败回滚**：虽然有 `fileHistoryTrackEdit` 做备份，但写入阶段中途崩溃没有即时恢复机制。
- **没有文件级并发队列**：靠 mtime 检测是"事后校验"而非"事前互斥"，在高并发场景下仍可能导致竞态。

---

## 3. 横向对比（按维度）

### 3.1 编辑语义

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| 一次调用可改几处 | 多处（`edits[]`） | 单处（`edit_file`）/ 多处跨文件（`multi_edit`） | 单处（多次调用） |
| 匹配基准 | ✅ 全匹配原始文件 | ❌ 增量匹配（前一个编辑影响后一个） | ✅ 全匹配原始文件 |
| 重叠检测 | ✅ 禁止重叠 | ❌ 无检测 | N/A（单编辑） |
| `replace_all` | ❌ 无 | ❌ 无 | ✅ 有 |

**胜出：Pi**。全匹配原始文件 + 多编辑点 + 禁止重叠，是最安全的语义。

### 3.2 先读后改保护

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| 检查"是否读过" | ❌ | ✅ `hasRead` | ✅ `readFileState.hasRead` |
| mtime 检测 | ❌ | ❌ | ✅ |
| 内容回退（mtime 假阳性） | ❌ | ❌ | ✅ |

**胜出：Claude Code**。不仅要求读过，还检测读之后文件是否被外部修改。

### 3.3 编码与行尾

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| BOM 处理 | ✅ strip/restore | ❌ | ❌ |
| 行尾检测与保留 | ✅ detect+restore | ✅ 自适应 | ✅ detect+preserve |
| 多编码支持 | ❌ UTF-8 only | ✅ | ✅（含 UTF-16LE） |

**胜出：平局（Pi + DeepSeek 融合最好）**。Pi 的 BOM 处理 + DeepSeek 的多编码 = 全覆盖。

### 3.4 容错匹配

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| 弯引号容错 | ❌ | ❌ | ✅ `findActualString` |
| API 脱敏还原 | ❌ | ❌ | ✅ `desanitizeMatchString` |
| 尾部空格 strip | ❌ | ❌ | ✅（跳过 md/mdx） |
| 行尾自动适配 | ❌ | ✅ | ❌ |

**胜出：Claude Code**。引号规范化和脱敏还原是独有的实用能力。

### 3.5 原子性与恢复

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| 写失败回滚 | ❌ | ✅ `multi_edit` 逆序回滚 | ❌（靠 fileHistory 备份） |
| 文件并发队列 | ✅ `withFileMutationQueue` | ❌ | ❌ |

**胜出：融合方案**。DeepSeek 的回滚 + Pi 的队列才是完整方案。

### 3.6 Diff 渲染

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| diff 算法 | 基于替换的整块 diff | ✅ LCS 动态规划 | `diff` 库 structuredPatch |
| unified patch 输出 | ✅ | 手动拼接 | ✅ |
| snippet 提取 | ❌ | ❌ | ✅ |
| TUI 实时预览 | ✅ | ❌ | React/Ink 组件 |

**胜出：DeepSeek（LCS 质量最高）+ Claude Code（snippet 实用）**。

### 3.7 其他维度

| | Pi | DeepSeek | Claude Code |
|---|---|---|---|
| AbortSignal | ✅ | ❌ | ❌ |
| 可插拔操作层 | ✅ | ❌ | 部分（fs 可注入） |
| IDE 耦合 | 无 | 无 | 重（LSP, VSCode, Git） |
| 文件大小限制 | ❌ | ❌ | ✅ 1 GiB |
| 路径模糊建议 | ❌ | ❌ | ✅ `findSimilarFile` |

---

## 4. 更优异 Edit 工具的设计方案

以下方案融合三家精华，同时去除各自的糟粕。

### 4.1 参数设计

采用 Pi 的多编辑点思路（`edits[]`），但参数命名更直接：

```typescript
const editSchema = z.strictObject({
  // 文件路径，兼容绝对和相对路径
  filePath: z.string().describe('Absolute or relative path to the file to edit'),

  // 一个或多个编辑点。所有 oldText 都与原始文件匹配，非增量。
  edits: z.array(z.strictObject({
    oldText: z.string().describe(
      'Exact text to find in the ORIGINAL file (before any edits are applied). ' +
      'Must be unique in the file. Must not overlap with any other oldText in the same call.'
    ),
    newText: z.string().describe('Replacement text for this edit.'),
  })).min(1).describe(
    'One or more targeted replacements. Each edit is matched against the original file, ' +
    'not incrementally. If two changes touch the same block or nearby lines, merge them ' +
    'into one edit instead of emitting overlapping edits. Do not include large unchanged ' +
    'regions just to connect distant changes — use separate edits for separate locations.'
  ),
});
```

### 4.2 读取阶段：编码 + BOM + 行尾（三家融合）

```typescript
interface ReadForEditResult {
  originalBuffer: Buffer;     // 用于回滚
  encoding: string;            // 原始编码
  bom: string;                 // BOM（如有）
  lineEnding: 'CRLF' | 'LF';  // 原始行尾
  normalized: string;          // 已去 BOM、统一为 LF 的内容
}

async function readFileForEdit(ops: FileOperations, path: string): Promise<ReadForEditResult> {
  const buf = await ops.readFile(path);

  // 1. 编码检测（取自 DeepSeek + Claude Code）
  const { text, encoding } = decodeFileBuffer(buf);

  // 2. BOM 剥离（取自 Pi）
  const { bom, stripped } = stripBom(text);

  // 3. 行尾检测与归一化（取自 Pi）
  const lineEnding = detectLineEnding(stripped);   // 'CRLF' | 'LF'
  const normalized = normalizeToLF(stripped);

  return { originalBuffer: buf, encoding, bom, lineEnding, normalized };
}
```

### 4.3 安全门禁（取 Claude Code 精华）

```typescript
interface ReadStateEntry {
  content: string;    // 读取时的文件内容（已归一化）
  timestamp: number;  // 读取时的 mtime
}

interface ReadState {
  get(path: string): ReadStateEntry | undefined;
  set(path: string, entry: ReadStateEntry): void;
}

async function safetyGate(
  path: string,
  readState: ReadState,
  normalizedContent: string,  // 当前文件内容（已归一化）
): Promise<void> {
  // 1. 必须先读文件（取自 DeepSeek + Claude Code）
  const lastRead = readState.get(path);
  if (!lastRead) {
    throw new Error(
      `File has not been read yet. Use the read_file tool first to read "${path}" before editing.`
    );
  }

  // 2. 检测外部修改（取自 Claude Code）
  let mtime: number;
  try {
    mtime = await getFileMtime(path);
  } catch {
    // 文件被删了
    throw new Error(`File "${path}" no longer exists. Read it again to confirm.`);
  }

  if (mtime > lastRead.timestamp) {
    // mtime 变了，但内容可能未变（Windows 云同步、杀毒软件扰动）
    // 内容回退检查（取自 Claude Code）
    if (normalizedContent !== lastRead.content) {
      throw new Error(
        `File "${path}" was modified externally after your last read. ` +
        `Read it again before attempting to edit.`
      );
    }
  }

  // 3. 文件大小检查（取自 Claude Code）
  const size = await getFileSize(path);
  if (size > MAX_EDIT_FILE_SIZE) {
    throw new Error(
      `File is too large to edit (${formatFileSize(size)}). ` +
      `Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`
    );
  }
}
```

### 4.4 编辑匹配（取 Pi 的安全语义 + Claude Code 的容错）

```typescript
interface ResolvedEdit {
  index: number;            // 在 edits[] 中的位置
  originalOldText: string;  // 模型给的 oldText
  actualOldText: string;    // 文件中实际匹配的字符串（可能经引号规范化不同）
  actualNewText: string;    // 保持引号风格后的 newText
}

function resolveEdits(
  original: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): ResolvedEdit[] {
  const resolved: ResolvedEdit[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    let actualOldText = edit.oldText;
    let actualNewText = edit.newText;

    // 1. 精确匹配
    if (!original.includes(actualOldText)) {
      // 2. 弯引号容错（取自 Claude Code）
      const normalizedSearch = normalizeQuotes(edit.oldText);
      const normalizedFile = normalizeQuotes(original);
      const idx = normalizedFile.indexOf(normalizedSearch);

      if (idx >= 0) {
        // 文件中实际包含的 oldText（含原始引号）
        actualOldText = original.substring(idx, idx + edit.oldText.length);
        // newText 保持文件原有引号风格（取自 Claude Code）
        actualNewText = preserveQuoteStyle(edit.oldText, actualOldText, edit.newText);
      } else {
        // 3. API 脱敏还原（取自 Claude Code）
        const { result: desanitized } = desanitizeMatchString(edit.oldText);
        if (original.includes(desanitized)) {
          actualOldText = desanitized;
          actualNewText = applySameDesanitization(edit.newText, edit.oldText, desanitized);
        } else {
          throw new Error(
            `Edit #${i + 1}: oldText not found in "${path}". ` +
            `Searched for: "${edit.oldText.slice(0, 80)}${edit.oldText.length > 80 ? '...' : ''}"`
          );
        }
      }
    }

    // 4. 唯一性校验（取自 DeepSeek）
    // 用实际的 oldText 检查出现次数，出现 > 1 次则拒绝
    const occurrences = countOccurrences(original, actualOldText);
    if (occurrences > 1) {
      throw new Error(
        `Edit #${i + 1}: oldText appears ${occurrences} times in "${path}". ` +
        `Include more surrounding context to make it unique.`
      );
    }

    resolved.push({ index: i, originalOldText: edit.oldText, actualOldText, actualNewText });
  }

  // 5. 重叠检测（取自 Pi）
  checkNoOverlapping(resolved, original);

  return resolved;
}
```

### 4.5 应用编辑

```typescript
function applyResolvedEdits(original: string, resolved: ResolvedEdit[]): string {
  let result = original;
  // 从后往前替换（保持前面的索引不变），或按位置排序后替换
  // 因为所有 actualOldText 在原始文件中都是唯一的且不重叠的，
  // 只要替换顺序不影响最终结果，简单遍历即可
  // 建议：按位置排序从后往前替换
  const sorted = [...resolved].sort(
    (a, b) => original.indexOf(b.actualOldText) - original.indexOf(a.actualOldText)
  );
  for (const edit of sorted) {
    result = result.replace(edit.actualOldText, edit.actualNewText);
  }
  return result;
}
```

### 4.6 写入阶段（取 DeepSeek 回滚 + Pi 队列）

```typescript
async function safeWrite(
  ops: FileOperations,
  path: string,
  resolved: ResolvedEdit[],
  original: string,
  newContent: string,       // 仍在 LF 下
  readResult: ReadForEditResult,
): Promise<void> {
  await withFileMutationQueue(path, async () => {  // 取自 Pi
    // 恢复 BOM + 原始行尾（取自 Pi）
    const finalContent = readResult.bom + restoreLineEndings(newContent, readResult.lineEnding);

    try {
      await ops.writeFile(path, finalContent);
    } catch (writeErr) {
      // 回滚到原始内容（取自 DeepSeek）
      try {
        const originalContent = readResult.bom + restoreLineEndings(
          original,
          readResult.lineEnding
        );
        await ops.writeFile(path, originalContent);
      } catch (rollbackErr) {
        throw new Error(
          `Write failed: ${writeErr}. Rollback also failed: ${rollbackErr}. ` +
          `File "${path}" may be in an inconsistent state.`
        );
      }
      throw new Error(
        `Write failed, file "${path}" restored to original content. ` +
        `Original error: ${writeErr}`
      );
    }
  });
}
```

### 4.7 输出：Diff + Snippet（三合一）

```typescript
interface EditResult {
  path: string;
  replaced: number;                     // 成功替换的编辑点数量
  diff: string;                         // 人可读的 unified diff
  patch: string;                        // 标准 unified patch（可用于 git apply）
  firstChangedLine: number;            // 第一个变更行号
  snippet?: string;                     // 变更区域缩略（取 Claude Code）
}

function buildResult(
  path: string,
  original: string,
  newContent: string,
  resolved: ResolvedEdit[],
): EditResult {
  // LCS 行级 diff（取自 DeepSeek，质量最高）
  const lineDiffs = computeLcsDiff(
    original.split('\n'),
    newContent.split('\n')
  );

  // 标准 unified patch（取自 Pi）
  const patch = generateUnifiedPatch(path, original, newContent);

  // 变更区域 snippet（取自 Claude Code）
  const snippet = extractSnippet(newContent, resolved, 4 /* 上下文行数 */);

  return {
    path,
    replaced: resolved.length,
    diff: renderLineDiff(lineDiffs),
    patch,
    firstChangedLine: computeFirstChangedLine(original, newContent),
    snippet,
  };
}
```

---

## 5. 设计总结

| 维度 | 应该取自 | 理由 |
|------|---------|------|
| **多编辑点 + 全匹配原始文件** | Pi | 最安全的编辑语义，避免级联错位 |
| **BOM + 行尾规范处理** | Pi | 跨平台编辑不踩坑 |
| **先读后改 + mtime 检测 + 内容回退** | Claude Code | 防幻觉 + 防覆盖 + 防误报 |
| **弯引号规范化 + 脱敏还原** | Claude Code | 实用容错，减少无谓的匹配失败 |
| **写失败回滚** | DeepSeek | 唯一实现了原子恢复 |
| **多编码支持** | DeepSeek | 非 UTF-8 代码库必备 |
| **文件级并发队列** | Pi | 事前互斥，而非事后校验 |
| **AbortSignal** | Pi | 可优雅中断长时间操作 |
| **可插拔操作层** | Pi | 支持远程/虚拟文件系统 |
| **LCS 动态规划 diff** | DeepSeek | diff 质量最高，符合 git 约定 |
| **变更区域 snippet** | Claude Code | 帮助用户快速定位变更 |

### 该丢掉的糟粕

| 糟粕 | 来源 | 原因 |
|------|------|------|
| **增量匹配语义** | DeepSeek | 前一个编辑影响后一个匹配，极易错位 |
| **IDE 深度耦合** | Claude Code | LSP/VSCode/Git/技能发现让工具无法独立 |
| **复杂 TUI 状态机** | Pi | `renderCall`/`renderResult` 状态追踪过于复杂 |
| **单编辑点设计** | Claude Code | 大文件多处修改 Token 效率低 |
| **仅 UTF-8** | Pi | 不支持其他编码 |
| **无先读后改保护** | Pi | 模型可能凭幻觉乱改 |
