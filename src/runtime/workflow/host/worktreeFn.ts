/**
 * worktree 能力：按键创建/复用隔离目录，以及把改动合并回主工作区。
 *
 * 生命周期不变量（与 orchestrator 终态清理配合）：
 * - 创建成功立即登记到 ownedWorktrees，即使后续 spawn 失败也不泄漏；
 * - integrate 成功或判定 pristine → 删除；
 * - 冲突或基础设施失败 → 保留现场，交给用户或 integrate agent。
 *
 * integrate 的合并顺序固定为 fast-forward → 3-way → integrate agent。
 * 前两步是确定性的 git 操作，只有真正冲突才付出一次 LLM 调用。
 */
import { existsSync } from 'fs'
import * as Worktree from '../../worktree'
import {
  commitWorktreeReceipt,
  markWorktreeCleaned,
  tryReuseWorktreeReceipt
} from '../effects/worktreeEffect'
import { commitIntegrateReceipt, tryReuseIntegrateReceipt } from '../effects/integrateEffect'
import {
  assertScopeLive,
  hostEffectCtx,
  type AgentOptions,
  type AgentResult,
  type HostContext,
  type IntegrateOptions,
  type IntegrateResult,
  type WorktreeHandle
} from './types'

export type WorktreeFn = (key: string) => Promise<WorktreeHandle>
export type IntegrateFn = (
  directory: string,
  opts?: IntegrateOptions
) => Promise<IntegrateResult>
export type CleanupWorktreeFn = (directory: string) => Promise<boolean>

/** agent() 委托方：integrate 冲突兜底需要一个子 agent，但 host 不自己组装 AgentLoop */
type AgentDelegate = (prompt: string, opts?: AgentOptions) => Promise<AgentResult>

/** 冲突解决 agent 的工具集：需要读文件、改文件、跑 git */
const INTEGRATE_TOOLS = ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash'] as const

/**
 * 按键创建或复用 worktree。
 * 三级复用：本 run 内存索引 → 磁盘 receipt（resume）→ 新建。
 */
export async function ensureWorktree(
  ctx: HostContext,
  key: string
): Promise<WorktreeHandle> {
  if (!assertScopeLive(ctx)) {
    throw new Error('TaskScope closed: cannot create worktree')
  }
  const safeKey = String(key ?? '').trim()
  if (!safeKey) throw new Error('worktree key 不能为空')

  const known = ctx.worktreeKeys.get(safeKey)
  if (known) {
    const owned = ctx.ownedWorktrees.get(known)
    if (owned && existsSync(known)) {
      return {
        key: safeKey,
        name: owned.info.name,
        branch: owned.info.branch,
        directory: known,
        baseSha: owned.baseSha,
        reused: true
      }
    }
    // 目录已消失（被清理或外部删除）：清索引后重建
    ctx.worktreeKeys.delete(safeKey)
    ctx.ownedWorktrees.delete(known)
  }

  const stepCtx = hostEffectCtx(ctx.runId, `worktree:${safeKey}`)
  const reused = tryReuseWorktreeReceipt({ workspaceRoot: ctx.workspaceRoot, stepCtx })
  if (reused) {
    const name = reused.directory.split(/[/\\]/).pop() ?? 'wt'
    ctx.ownedWorktrees.set(reused.directory, {
      info: { name, branch: reused.branch, directory: reused.directory },
      baseSha: reused.baseSha
    })
    ctx.worktreeKeys.set(safeKey, reused.directory)
    return {
      key: safeKey,
      name,
      branch: reused.branch,
      directory: reused.directory,
      baseSha: reused.baseSha,
      reused: true
    }
  }

  const info = await Worktree.create(ctx.workspaceRoot, safeKey)
  let baseSha: string
  try {
    baseSha = Worktree.headSha(info.directory)
  } catch (err) {
    // headSha 失败也必须回收，否则目录泄漏
    await Worktree.remove({ workspaceRoot: ctx.workspaceRoot, directory: info.directory }).catch(
      () => undefined
    )
    throw new Error(
      `worktree 创建后无法读取 HEAD: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  ctx.ownedWorktrees.set(info.directory, { info, baseSha })
  ctx.worktreeKeys.set(safeKey, info.directory)
  commitWorktreeReceipt({
    workspaceRoot: ctx.workspaceRoot,
    stepCtx,
    directory: info.directory,
    branch: info.branch,
    baseSha
  })

  return {
    key: safeKey,
    name: info.name,
    branch: info.branch,
    directory: info.directory,
    baseSha,
    reused: false
  }
}

/** 删除 worktree 并从本 run 的登记表摘除；失败只告警，终态清理会再兜一次 */
export async function releaseWorktree(
  ctx: HostContext,
  directory: string
): Promise<boolean> {
  if (!directory) return false
  try {
    await Worktree.remove({ workspaceRoot: ctx.workspaceRoot, directory })
  } catch (err) {
    console.warn(
      `[workflow] worktree 清理失败: ${directory}`,
      err instanceof Error ? err.message : err
    )
    return false
  }

  // 删除成功后才能摘 ownership；失败时终态收尾必须仍能看见并重试该目录。
  ctx.ownedWorktrees.delete(directory)
  for (const [key, dir] of ctx.worktreeKeys) {
    if (dir === directory) ctx.worktreeKeys.delete(key)
  }
  try {
    markWorktreeCleaned(ctx.workspaceRoot, ctx.runId, { directory })
  } catch (err) {
    // 目录已经删除，凭证失败只影响 resume 诊断，不能把成功清理伪装成失败。
    console.warn(
      `[workflow] worktree 清理凭证写入失败: ${directory}`,
      err instanceof Error ? err.message : err
    )
  }
  return true
}

/** 查询当前工作区是否支持 git worktree 隔离。 */
export function createSupportsWorktreeFn(ctx: HostContext): () => boolean {
  return () => Worktree.isGitRepo(ctx.workspaceRoot)
}

export function createWorktreeFn(ctx: HostContext): WorktreeFn {
  return (key) => ensureWorktree(ctx, key)
}

export function createCleanupWorktreeFn(ctx: HostContext): CleanupWorktreeFn {
  return (directory) => releaseWorktree(ctx, directory)
}

/**
 * integrate：把某个 worktree 的改动合并回主工作区。
 *
 * @param agent 冲突兜底用的子 agent 委托（由 index.ts 注入，避免 host 内部循环依赖）
 */
export function createIntegrateFn(ctx: HostContext, agent: AgentDelegate): IntegrateFn {
  return async (directory, opts) => {
    if (!assertScopeLive(ctx)) {
      return { status: 'failed', reason: 'scope closed' }
    }
    const dir = String(directory ?? '')
    const owned = ctx.ownedWorktrees.get(dir)
    if (!owned || !existsSync(dir)) {
      return { status: 'failed', reason: `未知或已消失的 worktree: ${dir}` }
    }

    // resume：同一 worktree 已合并过 → 直接返回，不重复合并
    const stepCtx = hostEffectCtx(ctx.runId, `integrate:${owned.info.branch}`)
    const priorReceipt = tryReuseIntegrateReceipt({ workspaceRoot: ctx.workspaceRoot, stepCtx })
    if (priorReceipt) {
      return {
        status: 'merged',
        strategy: 'fast-forward',
        sha: priorReceipt.mergeCommitSha ?? null
      }
    }

    // pristine：无改动且 HEAD 未前进 → 无需合并，直接回收目录
    const pristine = await Worktree.isPristine(dir, owned.baseSha).catch(() => false)
    if (pristine) {
      await releaseWorktree(ctx, dir)
      return { status: 'pristine' }
    }

    const commit = Worktree.commitAll({
      directory: dir,
      message: opts?.message ?? `workflow(${ctx.runId}): ${owned.info.name}`
    })
    if (commit.error) {
      return { status: 'failed', reason: `worktree 提交失败: ${commit.error}` }
    }
    // 无新提交且 HEAD 与 base 相同：改动只是被忽略的文件，视同 pristine
    if (!commit.committed && Worktree.tryHeadSha(dir) === owned.baseSha) {
      await releaseWorktree(ctx, dir)
      return { status: 'pristine' }
    }

    const merged = await Worktree.mergeBranch({
      workspaceRoot: ctx.workspaceRoot,
      branch: owned.info.branch,
      message: opts?.message ?? `merge ${owned.info.branch}`
    })

    if (merged.status === 'merged' || merged.status === 'up_to_date') {
      const strategy = merged.status === 'merged' ? merged.strategy : 'fast-forward'
      const sha = merged.status === 'merged' ? merged.sha : Worktree.tryHeadSha(ctx.workspaceRoot)
      return finish(ctx, dir, stepCtx, strategy, sha)
    }
    if (merged.status === 'failed') {
      return { status: 'failed', reason: merged.error }
    }

    // 冲突：交给 integrate agent 在主工作区解决，冲突现场保持原样
    const resolved = await agent(buildConflictPrompt(merged.files, owned.info.branch, opts), {
      isolation: 'shared',
      tools: [...INTEGRATE_TOOLS],
      label: `integrate-${owned.info.name}`
    })
    const remaining = Worktree.conflictFiles(ctx.workspaceRoot)
    if (resolved === null || remaining.length > 0 || Worktree.isMergeInProgress(ctx.workspaceRoot)) {
      return { status: 'conflict', files: remaining.length > 0 ? remaining : merged.files }
    }
    return finish(ctx, dir, stepCtx, 'agent', Worktree.tryHeadSha(ctx.workspaceRoot))
  }
}

/** 合并成功的收尾：写 receipt → 回收 worktree */
async function finish(
  ctx: HostContext,
  directory: string,
  stepCtx: ReturnType<typeof hostEffectCtx>,
  strategy: 'fast-forward' | 'three-way' | 'agent',
  sha: string | null
): Promise<IntegrateResult> {
  commitIntegrateReceipt({
    workspaceRoot: ctx.workspaceRoot,
    stepCtx,
    worktreeDirectory: directory,
    mergeCommitSha: sha,
    result: { strategy }
  })
  await releaseWorktree(ctx, directory)
  return { status: 'merged', strategy, sha }
}

function buildConflictPrompt(
  files: string[],
  branch: string,
  opts?: IntegrateOptions
): string {
  const lines = [
    `主工作区正在合并分支 ${branch}，出现冲突需要你解决。`,
    '',
    '冲突文件：',
    ...files.map((f) => `- ${f}`),
    '',
    '要求：',
    '1. 逐个打开冲突文件，保留双方的有效改动，删除所有冲突标记；',
    '2. 解决完成后执行 `git add <文件>`，再执行 `git commit --no-edit` 完成合并；',
    '3. 不要执行 `git merge --abort`、`git reset` 或任何回退操作；',
    '4. 完成后用一句话说明你如何取舍。'
  ]
  if (opts?.context) {
    lines.push('', '补充上下文：', opts.context)
  }
  return lines.join('\n')
}
