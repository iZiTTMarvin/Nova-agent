/**
 * bash / shell 命令的副作用分类。
 *
 * 写者租约只对「有副作用的 shell」生效（写文件 / 删文件 / 改 git 状态等）。
 * 纯读命令（ls / cat / grep / git status）不获取租约，保持并发友好。
 *
 * 分类基于命令文本的保守启发式：只要命令链中任一节看起来会改变文件系统或外部状态，
 * 即视为破坏性。本应用运行在 Windows，必须同时覆盖 Unix shell 与 PowerShell 写路径，
 * 宁可误判为破坏性（多等一次租约），也不漏判破坏性（破坏并发安全）。
 */

/**
 * 判断一条 shell 命令是否可能产生文件系统 / 外部副作用，需要获取写者租约。
 *
 * 启发式覆盖常见破坏性模式：
 * - 文件写入重定向：>、>>、tee
 * - PowerShell 重定向与写 cmdlet：Out-File、Set-Content、Add-Content、>
 * - 文件操作：rm / Remove-Item / del、mv / Move-Item、cp / Copy-Item、mkdir / New-Item、touch
 * - 文本流改写：sed -i、node/npx/make（可能跑构建改文件）
 * - 包管理 / 安装：npm install、yarn add、pip install、apt、brew install
 * - git 写操作：commit、push、merge、rebase、reset、checkout、clean、branch -D、tag
 * - 进程 / 服务：kill、systemctl、service、Stop-Process
 *
 * 纯读命令（ls / dir / cat / Get-Content / grep / find / git status/diff/log / echo / pwd / env）返回 false。
 */
export function isDestructiveBashCommand(command: string): boolean {
  // 去掉前导注释 / 空白后按管道 / 分号 / 逻辑与或拆成子命令节。
  // 简单拆分即可：本判定只做保守启发式，不需要完整 shell 解析。
  const segments = command.split(/\|\||&&|;|\|/).map(s => s.trim()).filter(Boolean)
  for (const seg of segments) {
    if (segmentLooksDestructive(seg)) return true
  }
  return false
}

function segmentLooksDestructive(seg: string): boolean {
  // 写入重定向：> file、>> file（命令本身可能是 echo，但产生文件写入）。
  // 必须出现真实的 > 字符，且其后跟文件名（非空白、非另一个 >）。
  if (/(?:^|[^>&])>\s*[^\s>]/.test(seg) || />>\s*[^\s>]/.test(seg)) {
    return true
  }
  // tee 写文件
  if (/\btee\b/.test(seg)) return true

  // PowerShell 重定向简写：n>file（如 1>out.txt、2>err.log）已由上面正则覆盖，
  // 这里覆盖 PowerShell 独有的写 cmdlet。
  if (/\b(Out-File|Set-Content|Add-Content|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Write-Output)\b/i.test(seg)) {
    return true
  }

  // 拆出第一个词（命令名）与参数，按命令名匹配破坏性子集。
  // 同时处理 PowerShell 别名（del / copy / move 等）。
  const tokens = seg.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const cmd = tokens[0]
  const bareCmd = cmd.split(/[/\\]/).pop() ?? cmd

  const destructiveBins = new Set([
    // Unix 文件操作
    'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'chmod', 'chown', 'touch',
    'truncate', 'dd', 'ln', 'install', 'rsync',
    // Unix 进程 / 服务
    'kill', 'killall', 'pkill', 'systemctl', 'service',
    // 包管理 / 运行时
    'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3', 'node', 'npx',
    'make', 'cmake', 'apt', 'apt-get', 'brew', 'choco', 'winget', 'cargo',
    'docker', 'kubectl',
    // sed 原地改写（-i）；非 -i 的 sed 在下面按参数判定
    'sed',
    // Windows CMD / PowerShell 别名与原生命令
    'del', 'erase', 'copy', 'move', 'md', 'rd', 'ren', 'rename', 'format',
    'taskkill', 'net', 'sc'
  ])
  if (destructiveBins.has(bareCmd.toLowerCase())) {
    // sed 只有 -i（原地改写）才破坏性；非 -i 输出到 stdout 不改文件。
    if (bareCmd.toLowerCase() === 'sed') {
      return tokens.some(t => t === '-i' || t.startsWith('--in-place'))
    }
    // npm/pip 等只有部分子命令破坏性，但保守起见一律视为破坏性
    // （npm run / npm install 都可能改文件），让写者租约介入。
    return true
  }

  // PowerShell 原生动词前缀（Invoke-WebRequest 下载、Start-Process 启动安装等）
  if (/^(Invoke-WebRequest|Invoke-RestMethod|iwr|curl|wget|Start-Process|stop-process)\b/i.test(bareCmd)) {
    return true
  }

  // git 写操作子命令
  if (bareCmd.toLowerCase() === 'git') {
    const sub = tokens[1] ?? ''
    const gitWriteSubs = new Set([
      'commit', 'push', 'merge', 'rebase', 'reset', 'checkout', 'switch',
      'clean', 'stash', 'cherry-pick', 'revert', 'apply', 'am', 'init',
      'add', 'mv', 'rm', 'bisect', 'worktree', 'pull', 'fetch'
    ])
    if (gitWriteSubs.has(sub)) return true
    // branch / tag：无参（列出）只读；带参（创建）或 -D/-d（删除）才破坏性
    if (sub === 'branch' || sub === 'tag') {
      // 跳过 sub 本身，看后续是否有参数或删除标志
      const rest = tokens.slice(2)
      if (rest.length === 0) return false
      // -D / -d / -d 删除标志，或任何分支名 / tag 名（创建）都改 .git
      return true
    }
  }

  return false
}
