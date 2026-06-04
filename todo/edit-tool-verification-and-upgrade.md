# Edit 工具升级施工清单

> **参考文档**：`docs/edit-tool-comparison.md`（设计规格书，含完整接口定义和伪代码）
> **外部参考实现**：
> - Pi：`D:\visual_ProgrammingSoftware\A_Projects\pi-main\packages\coding-agent\src\core\tools\edit.ts`
> - DeepSeek：`D:\visual_ProgrammingSoftware\A_Projects\DeepSeek-Reasonix-main\src\tools\fs\edit.ts`
> - Claude Code：`D:\visual_ProgrammingSoftware\Bi_She_Projects\Claude-code-open\src\tools\FileEditTool\`
>
> **当前状态**：`src/runtime/tools/editTool.ts`（108 行，单点替换，仅 UTF-8，无安全机制）
> **目标**：融合三家精华，实现安全、容错、可扩展的编辑工具。

---

## Phase 1：架构基础（必须先做，后续所有 Phase 依赖）

### 1.1 创建可插拔操作层 `EditOperations` 接口

**目标**：将文件 I/O 抽象为接口，让 edit 工具不直接依赖 `fs` 模块，天然支持测试 mock、SSH 远程文件系统、虚拟文件系统。

**新建文件**：`src/runtime/tools/EditOperations.ts`

```typescript
export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
  stat: (absolutePath: string) => Promise<{ mtimeMs: number; size: number }>;
}

// 默认实现：本地文件系统（用 fs.promises）
export const nodeEditOperations: EditOperations = { ... };
```

**参考**：Pi `edit.ts` 第 74-87 行。

---

### 1.2 实现文件级并发队列 `withFileMutationQueue`

**目标**：同一文件的并发编辑串行化，防止两个 agent 同时写一个文件导致数据竞争。

**新建文件**：`src/runtime/tools/fileMutationQueue.ts`

```typescript
const queues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(
  absolutePath: string,
  callback: () => Promise<T>
): Promise<T> {
  // 每个绝对路径一把锁（Promise 链），不同路径可并行
  const prev = queues.get(absolutePath) ?? Promise.resolve();
  const next = prev.then(callback, callback);
  queues.set(absolutePath, next.then(() => {}, () => {})); // 无论成败都释放锁
  return next;
}
```

**参考**：Pi `file-mutation-queue.ts`。

---

### 1.3 接入 AbortSignal 支持

**目标**：在编辑流程中每个 `await` 之后检查 `signal.aborted`，支持优雅中断长时间操作。

**修改文件**：`src/runtime/tools/editTool.ts`

在 execute 函数中：
```typescript
// ToolContext.abortSignal 已在 types.ts 中定义为 abortSignal?: AbortSignal
// 在每个 await 后调用 throwIfAborted()
const throwIfAborted = () => {
  if (signal?.aborted) throw new Error("Edit operation aborted");
};
```

注意：不要在 abort 事件监听器里直接 reject——那会释放 mutation queue 锁但文件操作可能还在进行。应该在每个 await 后检查，保持队列锁定直到当前操作完成。

**参考**：Pi `edit.ts` 第 308-348 行。

---

## Phase 2：读取管线（编码检测 + BOM + 行尾归一化）

### 2.1 实现多编码检测与往返

**目标**：支持 UTF-8、UTF-8-BOM、GBK、UTF-16LE/BE、Latin-1 等编码的检测和往返写入。

**新建文件**：`src/runtime/tools/fileEncoding.ts`

核心函数签名：
```typescript
export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'gbk' | 'utf-16le' | 'utf-16be' | 'latin-1';

export function decodeFileBuffer(buf: Buffer): { text: string; encoding: FileEncoding }
export function encodeFile(text: string, encoding: FileEncoding): Buffer
```

检测顺序：
1. UTF-16LE/BE：检查 BOM（`0xFF 0xFE` 或 `0xFE 0xFF`）
2. UTF-8 BOM：检查前 3 字节 `0xEF 0xBB 0xBF` → `utf-8-bom`
3. UTF-8 验证：尝试 `buf.toString('utf-8')` 后用 `TextDecoder` 验证无替换字符
4. GBK 检测：检查字节是否在 GBK 范围内（双字节 0x81-0xFE + 0x40-0xFE）
5. 兜底 Latin-1（ISO-8859-1，永不失败）

`encodeFile` 按原编码写回：UTF-16LE/BE 加 BOM，GBK 用 `iconv-lite` 或手动编码，其余用 `Buffer.from(text, encoding)`。

**参考**：DeepSeek `file-encoding.ts`。

---

### 2.2 实现 BOM 处理 + 行尾检测与归一化

**目标**：剥离文件开头的不可见 BOM（模型不会在 oldText 里包含它），统一用 LF 做内部处理，写入时恢复原始行尾和 BOM。

**新建文件**：`src/runtime/tools/lineEnding.ts`（BOM + 行尾放一起，都是文本规范化）

```typescript
export function stripBom(text: string): { bom: string; text: string }
// UTF-8 BOM = ﻿，检测到就剥离并返回 bom，否则 bom = ''

export function detectLineEnding(text: string): 'CRLF' | 'LF'
// 检查 \r\n 出现次数，有则 CRLF，无则 LF

export function normalizeToLF(text: string): string
// 将所有 \r\n 替换为 \n

export function restoreLineEndings(text: string, ending: 'CRLF' | 'LF'): string
// 如果 ending === 'CRLF'，将所有 \n 替换为 \r\n
```

**参考**：Pi `edit-diff.ts` 中的 `stripBom`、`detectLineEnding`、`normalizeToLF`、`restoreLineEndings`。

---

### 2.3 实现统一的 `readFileForEdit` 函数

**目标**：串联编码检测 → BOM 剥离 → 行尾归一化的完整读取管线。

**位置**：`src/runtime/tools/editTool.ts` 内或在独立模块 `readFileForEdit.ts`

```typescript
interface ReadForEditResult {
  originalBuffer: Buffer;    // 用于回滚
  encoding: string;          // 原始编码（如 gbk）
  bom: string;               // BOM（如有）
  lineEnding: 'CRLF' | 'LF'; // 原始行尾
  normalized: string;        // 已去 BOM、统一为 LF 的内容
}

async function readFileForEdit(ops: EditOperations, path: string): Promise<ReadForEditResult> {
  const buf = await ops.readFile(path);
  const { text, encoding } = decodeFileBuffer(buf);
  const { bom, text: stripped } = stripBom(text);
  const lineEnding = detectLineEnding(stripped);
  const normalized = normalizeToLF(stripped);
  return { originalBuffer: buf, encoding, bom, lineEnding, normalized };
}
```

**参考**：文档 4.2 节。

---

## Phase 3：安全门禁（先读后改 + 外部修改检测）

### 3.1 实现 ReadState 管理

**目标**：模型必须先读取文件才能编辑（防止凭幻觉乱改）。`readTool` 读取时写入 ReadState，`editTool` 执行时检查。

**新建文件**：`src/runtime/tools/ReadState.ts`

```typescript
interface ReadStateEntry {
  content: string;    // 读取时的文件内容（已归一化）
  timestamp: number;  // 读取时的 fs.stat.mtimeMs
}

interface ReadState {
  get(path: string): ReadStateEntry | undefined;
  set(path: string, entry: ReadStateEntry): void;
  has(path: string): boolean;
}

// 全局单例，或挂在 ToolContext 上
export const readState: ReadState = new Map(...);
```

**修改文件**：`src/runtime/tools/readTool.ts`——在 `readFileSync` / `readFile` 调用后，将规范化后的内容和 `stat.mtimeMs` 写入 `readState.set(path, { content, timestamp })`。

**参考**：Claude Code `readFileState` + DeepSeek `ReadTracker`。

---

### 3.2 实现 `safetyGate` 安全门禁函数

**目标**：编辑前执行三层检查——① 是否读过 ② 外部是否修改（mtime + 内容回退）③ 文件是否过大。

**位置**：`src/runtime/tools/editTool.ts` 内

```typescript
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

async function safetyGate(
  path: string,
  readState: ReadState,
  ops: EditOperations,
  currentNormalizedContent: string,
): Promise<void> {
  // 1. 必须先读文件
  const lastRead = readState.get(path);
  if (!lastRead) {
    throw new Error(`File has not been read yet. Use the read_file tool first to read "${path}" before editing.`);
  }

  // 2. 检测外部修改（mtime）
  let stat: { mtimeMs: number; size: number };
  try {
    stat = await ops.stat(path);
  } catch {
    throw new Error(`File "${path}" no longer exists. Read it again to confirm.`);
  }

  if (stat.mtimeMs > lastRead.timestamp) {
    // 内容回退：mtime 变了但内容未变 → Windows 云同步假阳性 → 放行
    if (currentNormalizedContent !== lastRead.content) {
      throw new Error(`File "${path}" was modified externally after your last read. Read it again before editing.`);
    }
  }

  // 3. 文件大小限制
  if (stat.size > MAX_EDIT_FILE_SIZE) {
    throw new Error(`File is too large to edit (${stat.size} bytes). Maximum is ${MAX_EDIT_FILE_SIZE} bytes.`);
  }
}
```

**参考**：Claude Code `FileEditTool.ts` 第 290-311 行（validateInput）+ 文档 4.3 节。

---

## Phase 4：参数 Schema 升级

### 4.1 输入 Schema 改为 `edits[]` + `filePath`

**目标**：从单编辑点 `{ path, old, new }` 升级为多编辑点 `{ filePath, edits: [{ oldText, newText }] }`，同时向后兼容旧格式。

**修改文件**：`src/runtime/tools/editTool.ts`

新 Schema（参考 Zod，项目当前用 JSON Schema，保持一致）：
```typescript
// edits[] 数组，每项是 { oldText: string, newText: string }
// 所有 oldText 与原始文件匹配（非增量）
parameters: {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: '文件路径（绝对或相对）' },
    edits: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string', description: '原始文件中要查找的精确文本，必须唯一' },
          newText: { type: 'string', description: '替换后的新文本' },
        },
        required: ['oldText', 'newText'],
      },
    },
  },
  required: ['filePath', 'edits'],
}
```

向后兼容适配器（在 execute 入口处）：
```typescript
function normalizeInput(args: Record<string, unknown>): { filePath: string; edits: Array<{ oldText: string; newText: string }> } {
  const path = (args.filePath || args.path) as string;
  
  // 兼容旧格式 { path, old, new }
  if (!args.edits && typeof args.old === 'string' && typeof args.new === 'string') {
    return { filePath: path, edits: [{ oldText: args.old, newText: args.new }] };
  }

  // 兼容 edits 是 JSON 字符串的情况（某些模型把数组当字符串发）
  let edits = args.edits;
  if (typeof edits === 'string') {
    try { edits = JSON.parse(edits); } catch {}
  }

  return { filePath: path, edits: edits as Array<{ oldText: string; newText: string }> };
}
```

**参考**：Pi `edit.ts` 第 94-117 行（`prepareEditArguments`）。

---

## Phase 5：容错匹配引擎

### 5.1 实现弯引号规范化

**目标**：模型只能输出直引号（`"` `'`），但文件中可能含弯引号（`"` `"` `'` `'`）。归一化后匹配，替换时保持文件原有引号风格。

**新建文件**：`src/runtime/tools/quoteNormalizer.ts`

```typescript
// 归一化：弯引号 → 直引号
function normalizeQuotes(text: string): string
// " → "  " → "  ' → '  ' → '

// 在文件中找到实际的 oldText（含原始引号）
function findActualString(fileContent: string, searchString: string): string | null {
  // 1. 精确匹配
  if (fileContent.includes(searchString)) return searchString;
  // 2. 弯引号归一化后匹配
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx === -1) return null;
  // 返回文件中实际包含的字符串（含弯引号）
  return fileContent.substring(idx, idx + searchString.length);
}

// 保持引号风格：把 newString 中的直引号替换为 actualOldString 中对应位置的弯引号
function preserveQuoteStyle(modelOld: string, actualOld: string, modelNew: string): string
// 含缩写词撇号特殊处理（如 "don't" 中的 ' 不能变弯引号）
```

处理逻辑：
- 如果 `oldString === actualOldString`（没有归一化），直接返回 `newString`
- 检测 `actualOldString` 中哪种弯引号对应 `modelOld` 中的直引号
- 对双引号调用 `applyCurlyDoubleQuotes`：用前后文（前是空格/行首 → 开引号，前是字母 → 闭引号）
- 对单引号调用 `applyCurlySingleQuotes`：额外检查是否在字母中间（缩写词撇号则保留直引号）

**参考**：Claude Code `utils.ts` 第 31-199 行（`normalizeQuotes`、`findActualString`、`preserveQuoteStyle`、`applyCurlyDoubleQuotes`、`applyCurlySingleQuotes`）。

---

### 5.2 实现 API 脱敏标签还原

**目标**：API 返回时将某些标签（如 `<function_results>`）sanitize 为缩略形式（如 `<fnr>`），模型输出的 `old_string` 用的是 sanitize 后的版本。匹配失败时自动还原重试。

**新建文件**：`src/runtime/tools/desanitizeMatch.ts`

```typescript
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '</fnr>': '</function_results>',
  '<n>': '<name>', '</n>': '</name>',
  '<o>': '<output>', '</o>': '</output>',
  '<e>': '<error>', '</e>': '</error>',
  '<s>': '<system>', '</s>': '</system>',
  '<r>': '<result>', '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
};

export function desanitizeMatchString(sanitized: string): {
  result: string;
  applied: Array<{ from: string; to: string }>;
}
// 遍历 DESANITIZATIONS，对字符串执行 replaceAll，记录应用的替换

export function applyCorrespondingDesanitization(
  newText: string,
  oldText: string,
  desanitizedOld: string,
): string
// 从 oldText → desanitizedOld 的映射中，反向应用到 newText
```

**参考**：Claude Code `utils.ts` 第 531-574 行。

---

### 5.3 实现 `resolveEdits` 编辑解析引擎

**目标**：核心匹配引擎。精确匹配 → 弯引号容错 → 脱敏还原 → 唯一性校验 → 重叠检测，一条龙。

**位置**：`src/runtime/tools/editTool.ts` 内或独立模块 `resolveEdits.ts`

```typescript
interface ResolvedEdit {
  index: number;             // 在 edits[] 中的位置
  originalOldText: string;   // 模型给的 oldText
  actualOldText: string;     // 文件中实际匹配的字符串（可能经引号规范化不同）
  actualNewText: string;     // 保持引号风格后的 newText
  startOffset: number;       // 在原始文件中的起始位置（用于排序和重叠检测）
}

function resolveEdits(
  original: string,  // 归一化后的原始文件内容（已去 BOM、统一 LF）
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): ResolvedEdit[] {
  const resolved: ResolvedEdit[] = [];
  
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    let actualOldText: string;
    let actualNewText = edit.newText;
    
    // 1. 精确匹配 → 2. 弯引号容错 → 3. 脱敏还原（按顺序尝试）
    actualOldText = tryMatchInOrder(original, edit.oldText, edit.newText);
    // tryMatchInOrder 内部：
    //   (a) original.includes(edit.oldText) → actualOldText = edit.oldText
    //   (b) findActualString(original, edit.oldText) → actualOldText = 文件中实际字符串，actualNewText = preserveQuoteStyle(...)
    //   (c) desanitizeMatchString(edit.oldText) → 再试 original.includes(desanitized)
    //   都失败 → throw Error("oldText not found")
    
    // 4. 唯一性校验
    const occurrences = countOccurrences(original, actualOldText);
    if (occurrences > 1) {
      throw new Error(`Edit #${i + 1}: oldText appears ${occurrences} times. Include more context to make it unique.`);
    }
    
    resolved.push({
      index: i,
      originalOldText: edit.oldText,
      actualOldText,
      actualNewText,
      startOffset: original.indexOf(actualOldText),
    });
  }
  
  // 5. 重叠检测
  checkNoOverlapping(resolved, original);
  
  return resolved;
}

// 重叠检测：任意两个编辑点的 actualOldText 在原文中范围不能重叠
function checkNoOverlapping(resolved: ResolvedEdit[], original: string): void {
  const sorted = [...resolved].sort((a, b) => a.startOffset - b.startOffset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevEnd = prev.startOffset + prev.actualOldText.length;
    if (curr.startOffset < prevEnd) {
      throw new Error(`Edits #${prev.index + 1} and #${curr.index + 1} overlap. Merge them into one edit.`);
    }
  }
}
```

**参考**：文档 4.4 节 + Pi `edit-diff.ts` + Claude Code `utils.ts`。

---

## Phase 6：编辑应用

### 6.1 实现 `applyResolvedEdits`

**目标**：将解析后的编辑点应用到原始文件，使用从后往前的替换顺序避免位置偏移。

**位置**：`src/runtime/tools/editTool.ts` 内

```typescript
function applyResolvedEdits(original: string, resolved: ResolvedEdit[]): string {
  // 按位置降序排序（从后往前替换，前面的位置不受影响）
  const sorted = [...resolved].sort(
    (a, b) => b.startOffset - a.startOffset
  );
  let result = original;
  for (const edit of sorted) {
    result = result.replace(edit.actualOldText, edit.actualNewText);
  }
  return result;
}
```

**要点**：
- 所有 `actualOldText` 匹配的都是**原始文件内容**（非增量），这是核心安全语义
- 虽然 `String.replace` 不带 `/g` 只替换第一次，但唯一性校验已确保每个 `actualOldText` 只出现一次
- 从后往前替换保证前面的偏移量不受后面替换影响

**参考**：文档 4.5 节。

---

## Phase 7：写入管线（回滚 + 行尾/BOM 恢复）

### 7.1 实现 `safeWrite`

**目标**：写入文件时——① 在并发队列中执行 ② 恢复 BOM 和原始行尾 ③ 写入失败自动回滚。

**位置**：`src/runtime/tools/editTool.ts` 内

```typescript
async function safeWrite(
  ops: EditOperations,
  path: string,
  newContent: string,        // 仍在 LF 下，无 BOM
  readResult: ReadForEditResult,
): Promise<void> {
  await withFileMutationQueue(path, async () => {
    // 恢复 BOM + 原始行尾
    const finalContent = readResult.bom + restoreLineEndings(newContent, readResult.lineEnding);

    try {
      await ops.writeFile(path, finalContent);
    } catch (writeErr) {
      // 回滚：恢复原始内容
      try {
        const originalContent = readResult.bom + restoreLineEndings(
          readResult.normalized, // 注意：这里是 normalized 内容恢复行尾
          readResult.lineEnding
        );
        await ops.writeFile(path, originalContent);
      } catch (rollbackErr) {
        throw new Error(
          `Write failed: ${(writeErr as Error).message}. Rollback also failed: ${(rollbackErr as Error).message}. File may be inconsistent.`
        );
      }
      throw new Error(
        `Write failed, file restored to original. Original error: ${(writeErr as Error).message}`
      );
    }
  });
}
```

**要点**：
- 写入前：`bom + restoreLineEndings(newContent, lineEnding)` 恢复原始格式
- 回滚策略：用原始 normalized 内容恢复行尾后写回，不依赖 `originalBuffer`（因为行尾和 BOM 信息已保存在 `ReadForEditResult` 中）
- 两层错误：回滚成功 → 报写入失败但已恢复；回滚也失败 → 报两层错误
- 注意：回滚时 original 是 `normalized`（LF 无 BOM），需要同样恢复 BOM + 行尾

**参考**：DeepSeek 第 142-165 行（逆序回滚） + Pi 第 312/346 行（队列 + BOM/行尾恢复）

---

## Phase 8：输出层（Diff + Patch + Snippet）

### 8.1 生成 LCS 行级 diff

**目标**：使用最长公共子序列算法生成行级差异，渲染格式与 `git diff` 一致。

**位置**：`src/runtime/tools/editDiff.ts`（新建，或扩展已有的 `src/shared/diff/compute.ts`）

```typescript
// LCS 动态规划行级 diff
function lineDiff(
  a: readonly string[],
  b: readonly string[],
): Array<{ op: '-' | '+' | ' '; line: string }>

// 渲染 diff 为可读字符串
function renderLineDiff(diff: Array<{ op: '-' | '+' | ' '; line: string }>): string
// 输出格式：- removed line / + added line /   unchanged line（与 git diff 一致）

// 计算第一个变更行号
function computeFirstChangedLine(original: string, newContent: string): number
```

**LCS 算法要点**：
- `dp[i][j]` = a[0..i) 和 b[0..j) 的 LCS 长度
- 回溯时 tie-break 选择先输出 `-` 再 `+`（git 约定：删除在前，添加在后）
- 只对变更区域做 LCS（限制在 `resolved` 编辑点附近的 ±contextLines），避免全文件 O(n*m) 过慢

**参考**：DeepSeek `edit.ts` 第 191-235 行（`lineDiff` 函数）。

---

### 8.2 生成 unified patch

**目标**：生成标准 unified diff 格式，可直接用于 `git apply`。

```typescript
function generateUnifiedPatch(
  path: string,
  original: string,
  newContent: string,
): string
// 标准 unified diff header + hunks
// @@ -start,count +start,count @@
```

**参考**：Pi `edit-diff.ts` 中的 `generateUnifiedPatch`。

---

### 8.3 生成变更区域 snippet

**目标**：提取每个编辑点周围 4 行上下文，帮助用户快速定位变更位置。

```typescript
function extractSnippet(
  newContent: string,
  resolved: ResolvedEdit[],
  contextLines: number = 4,
): string
// 从 newContent 中提取 resolved 中每个编辑点所在行 ± contextLines 的内容
```

**参考**：Claude Code `utils.ts` 中的 `getSnippet` 系列函数。

---

## Phase 9：组装 — 改造 `editTool.ts` execute 函数

### 9.1 重写 execute 管线

**目标**：将以上所有模块串联为完整的 execute 流程。

**流程**：

```
1. normalizeInput(args) → 参数兼容 + 校验
2. ops.access(path) → 文件存在性检查
3. readFileForEdit(ops, path) → 读取 + 解码 + BOM/行尾剥离
4. safetyGate(path, readState, ops, readResult.normalized) → 安全门禁
5. resolveEdits(readResult.normalized, edits, path) → 容错匹配 + 唯一性 + 重叠
6. newContent = applyResolvedEdits(readResult.normalized, resolved) → 应用编辑
7. safeWrite(ops, path, newContent, readResult) → 写入 + 回滚 + BOM/行尾恢复
8. buildResult(path, readResult.normalized, newContent, resolved) → 生成输出
```

**每一步都有 AbortSignal 检查点**：`throwIfAborted()` 在每个 `await` 之后调用。

**返回值类型**：
```typescript
interface EditToolResult {
  success: boolean;
  output: string;          // 人可读的 diff + 摘要
  error?: string;
  details?: {
    replaced: number;       // 成功替换的编辑点数量
    diff: string;           // 人可读的 unified diff
    patch: string;          // 标准 unified patch（可用于 git apply）
    firstChangedLine: number;
    snippet?: string;       // 变更区域缩略
  };
}
```

---

## Phase 10：测试

### 10.1 单元测试（每个新建模块）

| 模块 | 测试要点 |
|------|---------|
| `fileEncoding.ts` | UTF-8/GBK/UTF-16LE/BOM 检测，往返编码一致 |
| `lineEnding.ts` | BOM 剥离/恢复，CRLF/LF 检测/归一化/恢复 |
| `quoteNormalizer.ts` | 弯引号归一化，`findActualString` 匹配，`preserveQuoteStyle` 保持风格，缩写词撇号 |
| `desanitizeMatch.ts` | 15 对标签脱敏/还原，`applyCorrespondingDesanitization` |
| `resolveEdits.ts` | 精确匹配，弯引号容错，脱敏还原，唯一性拒绝，重叠拒绝 |
| `fileMutationQueue.ts` | 同文件串行，异文件并行 |
| `editDiff.ts` | LCS 正确性，unified patch 格式，snippet 提取 |

### 10.2 集成测试（端到端管线）

- 多编辑点 `edits[]` 全匹配原始文件（非增量）
- 先读后改门禁：未读文件应被拒绝
- mtime 检测：外部修改后应拒绝；mtime 变但内容未变应放行
- 写失败回滚：模拟写入失败，验证文件恢复
- 文件并发队列：两个并发 edit 对同一文件串行执行

### 10.3 向后兼容测试

- 旧格式 `{ path, old, new }` 自动转换为 `{ filePath, edits: [{ oldText, newText }] }`
- `path` 和 `file_path` 别名兼容

---

## 实施顺序

```
Phase 1（架构）→ Phase 2（读取）→ Phase 3（安全）→ Phase 4（参数）
→ Phase 5（匹配）→ Phase 6（应用）→ Phase 7（写入）→ Phase 8（输出）
→ Phase 9（组装）→ Phase 10（测试）
```

每个 Phase 完成后独立可验证。建议按顺序执行，后续 Phase 依赖前面 Phase 的模块。
