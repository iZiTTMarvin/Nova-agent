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
const processTreeKillers = new WeakMap<ChildProcess, () => Promise<void>>()

export function killProcessTree(child: ChildProcess | number | undefined): Promise<void> {
  if (typeof child !== 'object') return createProcessTreeKiller(child)()
  let kill = processTreeKillers.get(child)
  if (!kill) {
    kill = createProcessTreeKiller(child.pid)
    processTreeKillers.set(child, kill)
  }
  return kill()
}

function createProcessTreeKiller(pid: number | undefined): () => Promise<void> {
  const targets = new Map<number, string>()
  let pending: Promise<void> | undefined
  let capturedRoot = false
  let confirmed = false
  const terminate = async () => {
    if (!pid || confirmed) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }, error => {
          if (error && !isTaskkillProcessNotFound(error)) reject(error)
          else resolve()
        })
      })
      confirmed = true
      return
    }

    const processes = await listProcesses()
    const roots = new Set<number>()
    if (!capturedRoot) {
      capturedRoot = true
      if (processes.has(pid)) roots.add(pid)
    }
    for (const [target, identity] of targets) {
      if (processes.get(target)?.identity === identity) roots.add(target)
    }
    const capture = (root: number) => {
      const entry = processes.get(root)
      if (!entry || targets.has(root)) return
      targets.set(root, entry.identity)
    }
    for (const root of roots) capture(root)
    for (const root of roots) {
      for (const [childPid, entry] of processes) {
        if (entry.parentPid === root && !roots.has(childPid)) {
          roots.add(childPid)
          capture(childPid)
        }
      }
    }

    // 保留首次捕获的身份；重试时子进程可能已被重新托管，PID 也可能复用。
    const failures: unknown[] = []
    const signalTargets = async (signal: NodeJS.Signals) => {
      const current = await listProcesses()
      for (const [target, identity] of [...targets].reverse()) {
        const entry = current.get(target)
        if (!entry || entry.identity !== identity || entry.zombie) {
          targets.delete(target)
          continue
        }
        try { safeKill(target, signal) } catch (error) { failures.push(error) }
      }
    }
    await signalTargets('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 3000))
    await signalTargets('SIGKILL')
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await listProcesses()
      for (const [target, identity] of targets) {
        const entry = current.get(target)
        if (!entry || entry.identity !== identity || entry.zombie) targets.delete(target)
      }
      if (targets.size === 0) {
        confirmed = true
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new AggregateError(failures, `进程树退出未确认: ${[...targets.keys()].join(', ')}${failures.length ? `; ${failures.map(String).join('; ')}` : ''}`)
  }
  return () => {
    if (!pending) pending = terminate().finally(() => { pending = undefined })
    return pending
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

/** taskkill 以退出码 128 报告进程不存在：根已退出即树终止目标已达成（改父后代本就无法经根发现）。 */
function isTaskkillProcessNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const { code } = error as NodeJS.ErrnoException
  return typeof code === 'number' && code === 128
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (!isMissingProcess(error)) throw error
  }
}

interface ProcessIdentity {
  parentPid: number
  identity: string
  zombie: boolean
}

async function listProcesses(): Promise<Map<number, ProcessIdentity>> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart=,stat='], { windowsHide: true, timeout: 1000 }, (error, stdout) => {
      if (error) return reject(error)
      const processes = new Map<number, ProcessIdentity>()
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/)
        if (!match) continue
        processes.set(Number(match[1]), {
          parentPid: Number(match[2]), identity: match[3], zombie: match[4].startsWith('Z')
        })
      }
      resolve(processes)
    })
  })
}

/**
 * 等待子进程退出，处理 Windows 上的 stdio 句柄泄漏问题。
 *
 * Node 的 child_process 有两个相关事件：
 *   - 'exit'：进程本身结束（拿到 exitCode / signal）
 *   - 'close'：所有 stdio 流完全关闭后才触发
 *
 * Windows 上 'exit' 触发后 stdio 句柄可能还没 drain，进程对象也未必能立即被复用。
 * 之前的实现用 exit + 100ms 延迟兜底，但 100ms 是经验值——大型子进程有时
 * 确实需要更久。直接监听 'close' 就能拿到真实"完全结束"信号，不需要任何时间假设。
 *
 * 返回 exit code（null 表示被信号终止或 spawn 失败）。
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false
    let exitCode: number | null = null
    const finalize = (code: number | null) => {
      if (settled) return
      settled = true
      resolve(code)
    }

    // 先记下 exit code；'close' 触发后用它 finalize。
    // 如果只监听 'close' 也能拿到 exitCode（事件签名一致），但分开记录更直观。
    child.once('exit', (code) => {
      exitCode = code
    })

    // 'close' 在 stdio 完全关闭后触发，比 'exit' 更可靠。
    // 兜底：如果 30s 内还没 close（极端 IO 卡死），用 exitCode 直接 finalize。
    const safety = setTimeout(() => finalize(exitCode), 30_000)

    child.once('close', (code) => {
      clearTimeout(safety)
      finalize(code)
    })

    child.once('error', (err) => {
      clearTimeout(safety)
      finalize(null)
      void err
    })
  })
}

/**
 * 构造 spawn 选项的便捷封装。
 *
 * 统一处理：
 * - windowsHide: true（避免弹黑色窗口）
 * - stdio: ['pipe', 'pipe', 'pipe']（三个管道全接管；stdin 保持打开供持久会话后续写入）
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

/** spawn 包装：返回 child，stdin 保持打开（持久会话需要 stdin 可写）。 */
export function spawnShell(
  config: ShellConfig,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): ChildProcess {
  const child = spawn(config.shell, [...config.args, command], buildSpawnOptions(env, cwd, { signal }))
  // stdin 不立即关闭：让出为持久会话后仍可写入。不读 stdin 的命令在进程退出时
  // 管道随之关闭，行为不受影响（waitForChildProcess 等 close 已兜底）。
  // 子进程退出瞬间若有未完成写入会触发 EPIPE——预期现象，吞掉避免成为
  // 未处理流错误炸掉宿主进程。
  child.stdin?.on('error', () => {})
  return child
}
