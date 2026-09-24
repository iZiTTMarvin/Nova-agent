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
      'Execute PowerShell commands in the current workspace and return stdout/stderr.'
    ]
  }
  if (family === 'cmd') {
    return [
      `# bash (cmd.exe on ${os})`,
      'Execute cmd.exe batch commands in the current workspace and return stdout/stderr.',
      'Note: cmd syntax differs greatly from POSIX shells — avoid bash-style pipelines / string interpolation.'
    ]
  }
  return [
    `# bash (POSIX shell on ${os})`,
    'Execute shell commands in the current workspace and return stdout/stderr.'
  ]
}

function workdirHint(family: ShellFamily): string[] {
  if (family === 'pwsh') {
    return [
      '## Working directory',
      'Prefer the `workdir` parameter (relative to workingDir) over writing `Push-Location` in the command.',
      'Do not write `cd xxx && <cmd>` — it pollutes the current shell state and affects later commands.'
    ]
  }
  if (family === 'cmd') {
    return [
      '## Working directory',
      'Prefer the `workdir` parameter (relative to workingDir) over writing `cd /d xxx` in the command.',
      'Do not write `cd xxx && <cmd>` — it makes the working directory of later commands unpredictable.'
    ]
  }
  return [
    '## Working directory',
    'Prefer the `workdir` parameter (relative to workingDir) over writing `cd xxx && <cmd>` in the command.',
    '`cd` state does not persist to the next bash call; each command runs as an independent subprocess.'
  ]
}

function executionHint(family: ShellFamily): string[] {
  if (family === 'pwsh') {
    return [
      '## Command execution notes',
      '- Wrap paths containing spaces in double quotes: `Get-Content "C:/Program Files/..."`.',
      '- Avoid Unix-style backticks and `$()` nesting traps — PowerShell string interpolation is `"$var"`.',
      '- Dry-run before important operations: e.g. `Remove-Item -WhatIf`, look with `Get-ChildItem` first.',
      '- Long-running tasks need no time-boxing — just run them: while still running, the tool returns a process reference (ref); use shell_session\'s read to watch more output, write to send input (content must carry its own trailing newline), stop to terminate.'
    ]
  }
  if (family === 'cmd') {
    return [
      '## Command execution notes',
      '- Wrap paths containing spaces in double quotes: `type "C:/Program Files/..."`.',
      '- cmd has no backticks; use `call` for nested commands.',
      '- Dry-run before important operations: e.g. look with `dir` first, then `del`.',
      '- Avoid Unix tools — `find` / `grep` are unavailable on Windows.',
      '- Long-running tasks need no time-boxing — just run them: while still running, the tool returns a process reference (ref); use shell_session\'s read to watch more output, write to send input (content must carry its own trailing newline), stop to terminate.'
    ]
  }
  return [
    '## Command execution notes',
    '- Wrap paths containing spaces or `$` in single quotes: `cat \'/path with $dollar/file\'`.',
    '- Dry-run before important operations: e.g. `rm -i`, `ls` before `rm`.',
    '- Long-running tasks need no time-boxing — just run them: while still running, the tool returns a process reference (ref); use shell_session\'s read to watch more output, write to send input (content must carry its own trailing newline), stop to terminate.',
    '- Commands that write files into the workspace are tracked automatically by the checkpoint system.'
  ]
}

function truncationHint(): string[] {
  return [
    '## Output truncation',
    `Output longer than ${DEFAULT_MAX_LINES} lines or ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB is truncated, keeping only the tail,`,
    `and when output exceeds ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB the full content is written to \`os.tmpdir()/nova-bash-*.log\`;`,
    'the result ends with the file path — when a path is present, open it with the read tool to see the full content.'
  ]
}

function toolPreferenceHint(family: ShellFamily): string[] {
  if (family === 'pwsh') {
    return [
      '## Tool preference',
      '- Prefer the Glob tool for file lookup (structured, cacheable) instead of `Get-ChildItem -Recurse`.',
      '- Prefer the Grep tool for content search (regex + ripgrep) instead of `Select-String -Pattern`.',
      '- Use the Read tool instead of `Get-Content`.',
      '- Use the Write / Edit tools instead of `Set-Content` / `Add-Content` for file changes.'
    ]
  }
  if (family === 'cmd') {
    return [
      '## Tool preference',
      '- Prefer the Glob tool for file lookup instead of `dir /s`.',
      '- Prefer the Grep tool for content search instead of `findstr`.',
      '- Use the Read tool instead of `type`.',
      '- Use the Write / Edit tools instead of `echo >` redirection.'
    ]
  }
  return [
    '## Tool preference',
    '- Prefer the Glob tool for file lookup (structured, cacheable) instead of `find ... -name`.',
    '- Prefer the Grep tool for content search (regex + ripgrep) instead of `grep -R`.',
    '- Use the Read tool instead of `cat`.',
    '- Use the Write / Edit tools instead of shell rewrites such as `sed -i` / `echo >`.'
  ]
}

function parallelHint(family: ShellFamily): string[] {
  const sep = family === 'pwsh' ? '; ' : family === 'cmd' ? '& ' : ' && '
  return [
    '## Parallel commands',
    'Use chained separators when order matters (POSIX: `&&` / PowerShell: `;` / cmd: `&&`);',
    `issue multiple bash calls in one message to run independent commands in parallel (chaining each command with \`${sep.trim()}\` is fine too, but\nthe tool decides true parallelism by its concurrency-safety policy — commands with side effects such as \`workdir\` / \`checkpoint\` still run serially).`
  ]
}
