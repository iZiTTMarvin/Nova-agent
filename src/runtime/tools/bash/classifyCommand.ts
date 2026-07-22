/**
 * bash 命令的副作用分类。
 *
 * 写者租约只对「有副作用的 bash」生效（写文件 / 删文件 / 改 git 状态等）。
 * 纯读命令（ls / cat / grep / git status）不获取租约，保持并发友好。
 *
 * 分类基于命令文本的保守启发式：只要命令链中任一节看起来会改变文件系统或外部状态，
 * 即视为破坏性。宁可误判为破坏性（多等一次租约），也不漏判破坏性（破坏并发安全）。
 */

/**
 * 判断一条 bash 命令是否可能产生文件系统 / 外部副作用，需要获取写者租约。
 *
 * 启发式覆盖常见破坏性模式：
 * - 文件写入重定向：>、>>、tee
 * - 文件操作：rm、mv、cp、mkdir、rmdir、chmod、chown、touch
 * - 包管理 / 安装：npm install、yarn add、pip install、apt、brew install
 * - git 写操作：commit、push、merge、rebase、reset、checkout（切分支改工作区）、clean
 * - 进程 / 服务：kill、systemctl、service
 *
 * 纯读命令（ls、cat、grep、find、git status/diff/log、echo、pwd、env）返回 false。
 */
export function isDestructiveBashCommand(command: string): boolean {
  // 去掉前导注释 / 空白后按管道 / 分号 / 逻辑与或拆成子命令节
  // 简单拆分即可：本判定只做保守启发式，不需要完整 shell 解析
  const segments = command.split(/\|\||&&|;|\|/).map(s => s.trim()).filter(Boolean)
  for (const seg of segments) {
    if (segmentLooksDestructive(seg)) return true
  }
  return false
}

function segmentLooksDestructive(seg: string): boolean {
  // 写入重定向：> file、>> file（命令本身可能是 echo，但产生文件写入）。
  // 排除 2>（stderr 重定向到 /dev/null 等只读常见用法）不在这里特判，保守视为可能写文件。
  // 必须出现真实的 > 字符，且其后跟文件名（非空白、非另一个 >）。
  if (/(?:^|[^>&])>\s*[^\s>]/.test(seg) || />>\s*[^\s>]/.test(seg)) {
    return true
  }
  // tee 写文件
  if (/\btee\b/.test(seg)) return true

  // 拆出第一个词（命令名）与参数，按命令名匹配破坏性子集
  const tokens = seg.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const cmd = tokens[0]
  const bareCmd = cmd.split('/').pop() ?? cmd

  const destructiveBins = new Set([
    'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'chmod', 'chown', 'touch',
    'truncate', 'dd', 'ln', 'install', 'rsync',
    'kill', 'killall', 'pkill', 'systemctl', 'service',
    'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3',
    'apt', 'apt-get', 'brew', 'choco', 'winget', 'cargo',
    'docker', 'kubectl'
  ])
  if (destructiveBins.has(bareCmd)) {
    // npm/pip 等只有 install / run / 部分子命令才破坏性；这里保守视为破坏性
    // （npm run 可能跑构建改文件），让写者租约介入。
    return true
  }

  // git 写操作子命令
  if (bareCmd === 'git') {
    const sub = tokens[1] ?? ''
    const gitWriteSubs = new Set([
      'commit', 'push', 'merge', 'rebase', 'reset', 'checkout', 'switch',
      'clean', 'stash', 'cherry-pick', 'revert', 'apply', 'am', 'init',
      'add', 'mv', 'rm', 'bisect', 'worktree', 'pull', 'fetch'
    ])
    // fetch/pull 虽不改工作区文件，但会改 .git 状态，保守纳入
    if (gitWriteSubs.has(sub)) return true
  }

  return false
}
