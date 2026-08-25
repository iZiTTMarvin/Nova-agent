/**
 * 检测命令是否会启动一个等待 stdin 输入的任意执行入口（交互 shell / REPL /
 * 从 stdin 读脚本的解释器）。命中意味着：一旦持久会话成立，后续可向其写入任意
 * 字节，命令文本 denylist 整体失效，所以创建时点必须按高危处理——这是持久会话
 * 方案的安全承重墙。静态判定不可能穷尽混淆形态，可疑方向宁可多弹一次确认；
 * 残余绕过面在方案文档已知限制中登记。
 */

/** 等待 stdin 的任意执行入口名单（交互 shell / REPL / 控制台解释器）。 */
const REPL_ENTRY_BINARIES = new Set([
  'python', 'python3', 'ipython',
  'node',
  'irb', 'pry', 'lua',
  'pwsh', 'powershell',
  'bash', 'sh', 'zsh', 'dash', 'fish',
  'cmd',
  'py', 'r', 'ghci', 'octave', 'sqlite3'
])

/** 版本化解释器（python3.11 / pypy3 之类），归一到同一家族后按家族规则判定。 */
const VERSIONED_BINARIES: Array<{ re: RegExp; family: string }> = [
  { re: /^python\d*(\.\d+)?$/, family: 'python' },
  { re: /^ipython\d*$/, family: 'ipython' },
  { re: /^pypy\d*$/, family: 'python' }
]

/** 包一层再启动的 wrapper：跳过它（及其参数）后重新看命令位。 */
const SIMPLE_WRAPPERS = new Set(['exec', 'nohup', 'setsid'])
/** 带参数的 wrapper：flag / 时长 / 缓冲设置 / 环境赋值等参数一并跳过。 */
const ARG_WRAPPERS = new Set(['env', 'nice', 'timeout', 'stdbuf'])

// '-' 表示从 stdin 读脚本执行，同样构成任意执行入口
const PYTHON_FLAGS = new Set(['-i', '-q', '-u', '-B', '-'])
const NODE_FLAGS = new Set(['-i', '--interactive', '-'])
const SHELL_FLAGS = new Set(['-i', '-l', '--login', '-'])
// pwsh/cmd 的 flag 大小写不敏感；-NonInteractive 与 /c 不在名单内（不构成交互入口）
const PWSH_FLAGS = new Set(['-nologo', '-noprofile', '-'])
const CMD_FLAGS = new Set(['/k'])

function allowedFlagsFor(bin: string): ReadonlySet<string> {
  if (bin === 'python' || bin === 'python3' || bin === 'ipython') return PYTHON_FLAGS
  if (bin === 'node') return NODE_FLAGS
  if (bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash' || bin === 'fish') {
    return SHELL_FLAGS
  }
  if (bin === 'pwsh' || bin === 'powershell') return PWSH_FLAGS
  if (bin === 'cmd') return CMD_FLAGS
  return new Set()
}

/** Windows 系 flag 大小写不敏感；POSIX flag 区分大小写 */
function flagMatches(bin: string, token: string, allowed: ReadonlySet<string>): boolean {
  if (bin === 'pwsh' || bin === 'powershell' || bin === 'cmd') {
    return allowed.has(token.toLowerCase())
  }
  return allowed.has(token)
}

/** 按空白切 token，引号内的空白不切（覆盖带空格路径与内嵌脚本串）。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

/** 剥掉子 shell 括号与粘在命令名上的重定向尾巴：( python ) / python<&0 归一为 python。
 *  纯重定向 token（<< 、>>）保持原样——它不在任何 flag 名单内，天然判否。 */
function normalizeCommandToken(token: string): string {
  let t = token.replace(/^\(+/, '').replace(/\)+$/, '')
  const cut = t.search(/[<>]/)
  if (cut > 0) t = t.slice(0, cut)
  return t
}

export function isInteractiveEntryCommand(command: string): boolean {
  const segments = command.split(/\|\||&&|;|\|/).map(s => s.trim()).filter(Boolean)
  return segments.some(s => segmentIsInteractiveEntry(s, 0))
}

function segmentIsInteractiveEntry(segment: string, depth: number): boolean {
  const rawTokens = tokenize(segment)
  const tokens = rawTokens
    .filter(t => t !== '(' && t !== ')')
    .map(normalizeCommandToken)
    .filter(t => t.length > 0)
  if (tokens.length === 0) return false

  // 跳过 VAR=x 环境变量前缀
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++

  // 跳过 wrapper 及其参数，落到真正的命令位
  for (;;) {
    const token = tokens[i]
    if (token === undefined) return false
    const norm = normalizeBin(token)
    if (SIMPLE_WRAPPERS.has(norm)) {
      i += 1
      continue
    }
    if (ARG_WRAPPERS.has(norm)) {
      i += 1
      while (tokens[i] !== undefined && wrapperArgLooksLikeParam(tokens[i] ?? '')) i += 1
      continue
    }
    break
  }

  const rawBin = normalizeBin(tokens[i] ?? '')
  if (!rawBin || !isReplBin(rawBin)) return false
  // 版本化名字（python3.11 / pypy3）归一到家族名再查 flag 名单
  const bin = resolveBinFamily(rawBin)
  const rest = tokens.slice(i + 1)

  // shell 家族带 -c / -Command / /c 时对内嵌脚本串做一层深检：bash -c "python"
  if (depth < 1 && isShellFamily(bin)) {
    const scriptIndex = rest.findIndex(
      t => t === '-c' || t.toLowerCase() === '-command' || t.toLowerCase() === '/c'
    )
    const script = scriptIndex >= 0 ? rest[scriptIndex + 1] : undefined
    if (typeof script === 'string' && segmentIsInteractiveEntry(script, depth + 1)) {
      return true
    }
  }

  const allowed = allowedFlagsFor(bin)
  return rest.every(t => flagMatches(bin, t, allowed))
}

function wrapperArgLooksLikeParam(token: string): boolean {
  return (
    token.startsWith('-') ||
    /^[\d.]+[smhd]?$/i.test(token) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
  )
}

function isReplBin(bin: string): boolean {
  if (REPL_ENTRY_BINARIES.has(bin)) return true
  return VERSIONED_BINARIES.some(({ re, family }) => re.test(bin) && REPL_ENTRY_BINARIES.has(family))
}

function resolveBinFamily(bin: string): string {
  if (REPL_ENTRY_BINARIES.has(bin)) return bin
  const versioned = VERSIONED_BINARIES.find(({ re }) => re.test(bin))
  return versioned ? versioned.family : bin
}

function isShellFamily(bin: string): boolean {
  return (
    bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash' || bin === 'fish' ||
    bin === 'pwsh' || bin === 'powershell' || bin === 'cmd'
  )
}

/** 绝对路径形态（/bin/bash、pwsh.exe）取 basename 小写并去掉 .exe 后缀判等。 */
function normalizeBin(token: string | undefined): string {
  if (!token) return ''
  const base = token.split(/[/\\]/).pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}
