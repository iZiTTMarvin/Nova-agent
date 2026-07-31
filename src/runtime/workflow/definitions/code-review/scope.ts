/**
 * 审查范围收集：确定"这次要审查哪些改动"。
 *
 * 独立于审查动作本身，因为它是纯 git 事实收集、可单独验证，且失败语义不同——
 * 范围收集不出来属于前置条件不满足（不是 git 仓库、没有任何改动），
 * 应该让 workflow 立刻失败并说清原因，而不是让 agent 去审查一个空 diff。
 */
import type { HostFns } from '../../host'
import { truncate } from '../agentOutput'
import type { CodeReviewScope } from './types'

/**
 * diff 正文长度上限。
 * 超出后截断并置 truncated——审查 agent 是只读隔离，仍有 read/grep 可补读原文，
 * 但把兆级 diff 整段灌进上下文会挤掉真正需要的项目规则和相邻代码。
 */
const MAX_DIFF_CHARS = 60_000

/** 输出行数上限，防止极端仓库把 stat 本身撑爆 */
const MAX_STAT_LINES = 200

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `git status --porcelain` 的 `?? path` 行即未跟踪文件 */
function parseUntracked(stdout: string): string[] {
  return splitLines(stdout)
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(2).trim())
    .filter((path) => path.length > 0)
}

async function isGitRepository(host: HostFns): Promise<boolean> {
  const result = await host.bash('git rev-parse --is-inside-work-tree')
  return result.exitCode === 0 && result.stdout.trim().startsWith('true')
}

async function collectDiff(
  host: HostFns,
  baseRef: string
): Promise<{ changedFiles: string[]; diffStat: string; diff: string; truncated: boolean } | null> {
  const names = await host.bash(`git diff --name-only ${baseRef}`)
  if (names.exitCode !== 0) return null
  const stat = await host.bash(`git diff --stat ${baseRef}`)
  const body = await host.bash(`git diff --unified=3 ${baseRef}`)
  if (body.exitCode !== 0) return null

  const { text, truncated } = truncate(body.stdout, MAX_DIFF_CHARS)
  return {
    changedFiles: splitLines(names.stdout),
    diffStat: splitLines(stat.stdout).slice(0, MAX_STAT_LINES).join('\n'),
    diff: text,
    truncated
  }
}

/**
 * 收集审查范围。
 *
 * 优先工作区未提交改动（`git diff HEAD`），这对应"我刚改完，帮我审一遍"的主场景；
 * 工作区干净时回退到最近一次提交（`git diff HEAD~1 HEAD`），对应"审一下刚提交的东西"。
 * 两者都为空说明没有可审查对象，返回 null。
 */
export async function collectCodeReviewScope(host: HostFns): Promise<CodeReviewScope | null> {
  if (!(await isGitRepository(host))) return null

  const status = await host.bash('git status --porcelain')
  const untrackedFiles = status.exitCode === 0 ? parseUntracked(status.stdout) : []

  const workingTree = await collectDiff(host, 'HEAD')
  if (workingTree && (workingTree.changedFiles.length > 0 || untrackedFiles.length > 0)) {
    return { origin: 'working-tree', baseRef: 'HEAD', untrackedFiles, ...workingTree }
  }

  const lastCommit = await collectDiff(host, 'HEAD~1 HEAD')
  if (lastCommit && lastCommit.changedFiles.length > 0) {
    return { origin: 'last-commit', baseRef: 'HEAD~1', untrackedFiles: [], ...lastCommit }
  }

  return null
}
