/**
 * prompt.ts — bash 工具的动态描述生成
 *
 * 不同 shell 的命令语法、引号规则、内置工具差异很大。把工具描述写成
 * 硬编码字符串会让模型在跨平台场景下踩坑。
 *
 * 这个模块按 `shellName + platform` 渲染出对应的描述，让模型能直接看到：
 * - 当前 shell 的类型与 OS
 * - 推荐用 `workdir` 参数（而不是写 `cd xxx &&`）
 * - 引号 / 路径 / 验证步骤的注意事项
 * - 输出截断的限制值 + 临时文件提示
 * - 工具偏好（优先用 Glob/Grep 替代 find/grep）
 * - 并发命令的用法
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate'

/**
 * 渲染 bash 工具的描述文本。
 *
 * @param shellName 来自 ShellConfig.name（pwsh / powershell / cmd / bash / zsh / sh）
 * @param platform  process.platform（win32 / darwin / linux）
 */
export function renderBashDescription(shellName: string, platform: NodeJS.Platform): string {
  const normalized = (shellName || 'bash').toLowerCase()
  const family = classifyFamily(normalized, platform)

  const lines: string[] = []
  lines.push(...headerFor(family, platform))
  lines.push('')
  lines.push(...workdirHint(family))
  lines.push('')
  lines.push(...executionHint(family))
  lines.push('')
  lines.push(...truncationHint())
  lines.push('')
  lines.push(...toolPreferenceHint(family))
  lines.push('')
  lines.push(...parallelHint(family))
  return lines.join('\n')
}

type ShellFamily = 'bash' | 'pwsh' | 'cmd'

function classifyFamily(shellName: string, platform: NodeJS.Platform): ShellFamily {
  if (shellName === 'pwsh' || shellName === 'powershell') return 'pwsh'
  if (shellName === 'cmd') return 'cmd'
  // bash / zsh / sh / custom：视为 bash 家族
  return 'bash'
}

function headerFor(family: ShellFamily, platform: NodeJS.Platform): string[] {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
  if (family === 'pwsh') {
    return [
      `# bash (PowerShell on ${os})`,
      '在当前工作区中执行 PowerShell 命令并返回 stdout/stderr。'
    ]
  }
  if (family === 'cmd') {
    return [
      `# bash (cmd.exe on ${os})`,
      '在当前工作区中执行 cmd.exe 批处理命令并返回 stdout/stderr。',
      '注意：cmd 语法与 POSIX shell 差异很大，请避免使用 bash 风格的管道 / 字符串插值。'
    ]
  }
  return [
    `# bash (POSIX shell on ${os})`,
    '在当前工作区中执行 shell 命令并返回 stdout/stderr。'
  ]
}

function workdirHint(family: ShellFamily): string[] {
  if (family === 'pwsh') {
    return [
      '## 工作目录',
      '优先用 `workdir` 参数（相对于 workingDir），避免在命令中写 `Push-Location`。',
      '不要写 `cd xxx && <cmd>`——这会污染当前 shell 状态，影响后续命令。'
    ]
  }
  if (family === 'cmd') {
    return [
      '## 工作目录',
      '优先用 `workdir` 参数（相对于 workingDir），避免在命令中写 `cd /d xxx`。',
      '不要写 `cd xxx && <cmd>`——这会让后续命令的工作目录不可预期。'
    ]
  }
  return [
    '## 工作目录',
    '优先用 `workdir` 参数（相对于 workingDir），避免在命令中写 `cd xxx && <cmd>`。',
    '`cd` 的状态不会保留到下一条 bash 调用，每个命令都是独立子进程。'
  ]
}

function executionHint(family: ShellFamily): string[] {
  if (family === 'pwsh') {
    return [
      '## 命令执行注意事项',
      '- 路径含空格时用双引号包裹：`Get-Content "C:/Program Files/..."`。',
      '- 避免使用 Unix 风格的反引号或 `$()` 嵌套陷阱——PowerShell 的字符串插值是 `"$var"`。',
      '- 重要操作前先 dry-run：例如 `Remove-Item -WhatIf`、`Get-ChildItem` 先看。',
      '- 长任务用 `-Verbose` 或写进度文件，避免你看不到进度。'
    ]
  }
  if (family === 'cmd') {
    return [
      '## 命令执行注意事项',
      '- 路径含空格时用双引号包裹：`type "C:/Program Files/..."`。',
      '- cmd 没有反引号；命令嵌套用 `call`。',
      '- 重要操作前先 dry-run：例如先 `dir` 看一眼再 `del`。',
      '- 避免依赖 Unix 工具——`find` / `grep` 在 Windows 上不可用。'
    ]
  }
  return [
    '## 命令执行注意事项',
    '- 路径含空格或包含 `$` 时用单引号包裹：`cat \'/path with $dollar/file\'`。',
    '- 重要操作前先 dry-run：例如 `rm -i`、先 `ls` 再 `rm`。',
    '- 长任务用 `nohup ... &` + 写日志文件，避免你看不到进度。',
    '- 如果命令会写入工作区文件，会被 checkpoint 系统自动追踪。'
  ]
}

function truncationHint(): string[] {
  return [
    '## 输出截断',
    `超过 ${DEFAULT_MAX_LINES} 行或 ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB 的输出会被截断，`,
    '完整内容会写入 `os.tmpdir()/nova-bash-*.log`，结果末尾会附带文件路径，',
    '需要看完整内容时用 read 工具打开那个文件。'
  ]
}

function toolPreferenceHint(family: ShellFamily): string[] {
  if (family === 'pwsh') {
    return [
      '## 工具偏好',
      '- 文件查找优先用 Glob 工具（结构化、可缓存），不要写 `Get-ChildItem -Recurse`。',
      '- 内容搜索优先用 Grep 工具（支持正则 + ripgrep），不要写 `Select-String -Pattern`。',
      '- 读文件用 Read 工具，不要写 `Get-Content`。',
      '- 写文件用 Write / Edit 工具，不要用 `Set-Content` / `Add-Content` 改文件。'
    ]
  }
  if (family === 'cmd') {
    return [
      '## 工具偏好',
      '- 文件查找优先用 Glob 工具，不要写 `dir /s`。',
      '- 内容搜索优先用 Grep 工具，不要写 `findstr`。',
      '- 读文件用 Read 工具，不要写 `type`。',
      '- 写文件用 Write / Edit 工具，不要用 `echo >` 这种重定向。'
    ]
  }
  return [
    '## 工具偏好',
    '- 文件查找优先用 Glob 工具（结构化、可缓存），不要写 `find ... -name`。',
    '- 内容搜索优先用 Grep 工具（支持正则 + ripgrep），不要写 `grep -R`。',
    '- 读文件用 Read 工具，不要写 `cat`。',
    '- 写文件用 Write / Edit 工具，不要用 `sed -i` / `echo >` 这种 shell 重写。'
  ]
}

function parallelHint(family: ShellFamily): string[] {
  const sep = family === 'pwsh' ? '; ' : family === 'cmd' ? '& ' : ' && '
  return [
    '## 并行命令',
    '需要顺序时用链式分隔符（POSIX: `&&` / PowerShell: `;` / cmd: `&&`），',
    `需要把多条独立命令并行执行时一次发多次 bash 调用（每条命令用 \`${sep.trim()}\` 链起来也可以，但\n` +
      '工具会按并发安全策略决定是否真正并行——`workdir` / `checkpoint` 等有副作用的命令仍会串行）。'
  ]
}
