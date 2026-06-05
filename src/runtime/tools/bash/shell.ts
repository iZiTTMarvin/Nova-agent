/**
 * shell.ts — Shell 发现、环境注入与进程终止
 *
 * 本模块集中处理 bash 工具"如何与操作系统 shell 对话"的所有工程细节：
 * - 跨平台的 Shell 发现（pwsh / powershell / Git Bash / cmd；zsh；bash/sh）
 * - 自定义 shell 路径覆盖（用于支持配置 / 测试）
 * - 环境变量注入（把项目 binDir 加到 PATH 前面）
 * - 跨平台的进程树终止（Unix: SIGTERM→3s→SIGKILL，Windows: taskkill /F /T）
 * - Windows stdio 句柄泄漏处理（exit 后等 100ms 让 stdio drain）
 *
 * 这一层不关心 OutputAccumulator / TruncationResult / 工具上下文，只负责
 * spawn / wait / kill 的可移植封装。
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import type { ShellConfig } from './types'

/**
 * 获取当前平台推荐的 Shell 配置。
 *
 * 优先级：
 * - Windows: pwsh > powershell > Git Bash > cmd.exe
 * - macOS:   /bin/zsh
 * - Linux:   /bin/bash > /bin/sh
 *
 * @param customShellPath 自定义 shell 路径，传入则覆盖平台默认值
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!existsSync(customShellPath)) {
      throw new Error(`自定义 shell 路径不存在: ${customShellPath}`)
    }
    return buildConfigForCustom(customShellPath)
  }

  if (process.platform === 'win32') {
    return resolveWindowsShell()
  }
  if (process.platform === 'darwin') {
    return { shell: '/bin/zsh', args: ['-c'], name: 'zsh' }
  }
  return resolveUnixShell()
}

function resolveWindowsShell(): ShellConfig {
  const candidates: Array<{ shell: string; args: string[]; name: string }> = [
    {
      shell: join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'pwsh'
    },
    {
      shell: join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'powershell'
    },
    {
      shell: 'C:/Program Files/Git/bin/bash.exe',
      args: ['-c'],
      name: 'bash'
    },
    {
      shell: join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c'],
      name: 'cmd'
    }
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate.shell)) {
      return candidate
    }
  }

  // 兜底：直接交给 spawn 拼 cmd.exe
  return {
    shell: candidates[candidates.length - 1].shell,
    args: candidates[candidates.length - 1].args,
    name: 'cmd'
  }
}

function resolveUnixShell(): ShellConfig {
  if (existsSync('/bin/bash')) {
    return { shell: '/bin/bash', args: ['-c'], name: 'bash' }
  }
  return { shell: '/bin/sh', args: ['-c'], name: 'sh' }
}

function buildConfigForCustom(shellPath: string): ShellConfig {
  const lower = shellPath.toLowerCase()
  if (lower.endsWith('pwsh') || lower.endsWith('pwsh.exe') || lower.includes('powershell')) {
    return {
      shell: shellPath,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: lower.includes('pwsh') ? 'pwsh' : 'powershell'
    }
  }
  if (lower.endsWith('cmd.exe') || lower.endsWith('cmd')) {
    return { shell: shellPath, args: ['/d', '/s', '/c'], name: 'cmd' }
  }
  if (lower.endsWith('bash') || lower.endsWith('bash.exe') || lower.endsWith('sh')) {
    return { shell: shellPath, args: ['-c'], name: 'bash' }
  }
  if (lower.endsWith('zsh') || lower.endsWith('zsh.exe')) {
    return { shell: shellPath, args: ['-c'], name: 'zsh' }
  }
  // 未知 shell：退化为 -c，假定接受 -c 形式的命令串
  return { shell: shellPath, args: ['-c'], name: 'custom' }
}

/**
 * 构造 shell 子进程环境变量。
 *
 * 继承 `process.env`，把传入的 `binDir`（多个）拼到 PATH 前面，让项目内
 * 的本地工具（node_modules/.bin、vendor 目录等）优先可用。
 *
 * 不会删除任何已存在的环境变量，避免破坏用户的 alias / 代理 / 终端配置。
 */
export function getShellEnv(binDirs: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }

  if (binDirs.length === 0) return env

  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existing = env[pathKey] ?? env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const validBinDirs = binDirs.filter(p => typeof p === 'string' && p.length > 0)
  if (validBinDirs.length === 0) return env

  // 绝对路径才加进 PATH，避免污染
  const absoluteDirs = validBinDirs.filter(isAbsolute)
  if (absoluteDirs.length === 0) return env

  env[pathKey] = [...absoluteDirs, existing].join(sep)
  env.PATH = env[pathKey]
  return env
}

/**
 * 终止进程树。
 *
 * - Windows: 用 `taskkill /F /T /PID` 一次性杀死进程树（/F 强制、/T 包含子进程）。
 *   Windows 上 SIGTERM 信号不被子进程普遍支持，所以直接强制。
 * - Unix: 先发 SIGTERM 给子进程树，3 秒后仍未退出则升级为 SIGKILL。
 *   这是 Kilocode 的渐进式终止策略——给进程清理资源的机会，
 *   比直接 SIGKILL 更稳健。
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve())
    })
    return
  }

  // Unix：先 SIGTERM，3 秒后升级 SIGKILL
  await tryKillTree(pid, 'SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 3000))
  await tryKillTree(pid, 'SIGKILL')
}

async function tryKillTree(rootPid: number, signal: NodeJS.Signals): Promise<void> {
  const descendants = await listDescendantPids(rootPid)
  for (const childPid of [...descendants].reverse()) {
    safeKill(childPid, signal)
  }
  safeKill(rootPid, signal)
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // 进程已退出，忽略 ESRCH 等错误
  }
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  const queue: number[] = [rootPid]
  const descendants: number[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const directChildren = await listDirectChildPids(current)
    descendants.push(...directChildren)
    queue.push(...directChildren)
  }

  return descendants
}

async function listDirectChildPids(pid: number): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    execFile('ps', ['-o', 'pid=', '--ppid', String(pid)], { windowsHide: true }, (_error, stdout) => {
      const pids = stdout
        .split('\n')
        .map(line => Number.parseInt(line.trim(), 10))
        .filter(Number.isFinite)
      resolve(pids)
    })
  })
}

/**
 * 等待子进程退出，处理 Windows 上的 stdio 句柄泄漏问题。
 *
 * Windows 的 child_process 在进程退出后，stdio 句柄可能还没被 Node 完全
 * 释放，导致后续 close 事件不触发或阻塞。解决方式：先等 'exit' 事件，
 * 然后再等 100ms 让 stdio drain，最后强制 resolve 兜底。
 *
 * 返回 exit code（null 表示被信号终止或 spawn 失败）。
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false
    const finalize = (code: number | null) => {
      if (settled) return
      settled = true
      resolve(code)
    }

    child.once('exit', (code) => {
      // Windows 上句柄可能还没 drain，等 100ms
      setTimeout(() => finalize(code), 100)
    })

    child.once('error', (err) => {
      // spawn 阶段就失败（ENOENT 等）
      if (process.platform === 'win32') {
        setTimeout(() => finalize(null), 100)
      } else {
        finalize(null)
      }
      // 错误对象保留在闭包外不必关心
      void err
    })
  })
}

/**
 * 构造 spawn 选项的便捷封装。
 *
 * 统一处理：
 * - windowsHide: true（避免弹黑色窗口）
 * - stdio: ['pipe', 'pipe', 'pipe']（我们接管 stdout/stderr，关闭 stdin）
 * - env: 通过 getShellEnv 注入
 */
export function buildSpawnOptions(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: Pick<SpawnOptions, 'signal'>
): SpawnOptions {
  return {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal
  }
}

/** spawn 包装：返回一个 child 并立即关闭 stdin。 */
export function spawnShell(
  config: ShellConfig,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): ChildProcess {
  const child = spawn(config.shell, [...config.args, command], buildSpawnOptions(env, cwd, { signal }))
  // 关闭 stdin，避免命令因等待输入而卡死
  child.stdin?.end()
  return child
}
