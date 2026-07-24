import { existsSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLAN_RELATIVE_DIR, isPlanRelativePath } from '../../plans'
import { acquireWriterLeaseOrConflict } from '../../workspace'
import { withFileMutationQueue } from '../file-mutation-queue'
import { resolveAndValidatePath } from '../ToolRegistry'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import { assertSideEffectAllowed } from '../types'

const MAX_PLAN_CONTENT_CHARS = 1_000_000
const MAX_PLAN_TITLE_CODE_POINTS = 120
const MAX_FILENAME_TITLE_CODE_POINTS = 64

function truncateCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('')
}

export function normalizePlanTitle(value: string): string {
  return truncateCodePoints(value.trim().replace(/\s+/gu, ' '), MAX_PLAN_TITLE_CODE_POINTS)
}

export function toReadablePlanFilenamePart(title: string): string {
  const normalized = normalizePlanTitle(title)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-_.]+|[-_.]+$/gu, '')

  return truncateCodePoints(normalized, MAX_FILENAME_TITLE_CODE_POINTS)
    .replace(/^[-_.]+|[-_.]+$/gu, '') || 'implementation-plan'
}

export function formatLocalPlanDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function rejectLinkIfPresent(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1)) {
      throw new Error(`${label}不能是符号链接、junction 或硬链接`)
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && !rel.startsWith('..'))
}

async function prepareSafePlanDirectory(
  workspaceRoot: string,
  planDirectory: string
): Promise<{ realWorkspace: string; realPlans: string }> {
  const novaDirectory = join(workspaceRoot, '.nova')
  await rejectLinkIfPresent(novaDirectory, '.nova 目录')
  await rejectLinkIfPresent(planDirectory, '.nova/plans 目录')
  await mkdir(planDirectory, { recursive: true })
  await rejectLinkIfPresent(novaDirectory, '.nova 目录')
  await rejectLinkIfPresent(planDirectory, '.nova/plans 目录')

  const [realWorkspace, realPlans] = await Promise.all([
    realpath(workspaceRoot),
    realpath(planDirectory)
  ])
  if (!isWithinRoot(realWorkspace, realPlans)) {
    throw new Error('计划目录解析后位于当前工作区之外')
  }
  return { realWorkspace, realPlans }
}

function isSameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function writePlanAtomically(
  workspaceRoot: string,
  planDirectory: string,
  absolutePath: string,
  content: string
): Promise<void> {
  const tempPath = join(planDirectory, `.nova-plan-${randomUUID()}.tmp`)
  let tempCreated = false

  try {
    const handle = await open(tempPath, 'wx', 0o600)
    tempCreated = true
    let writtenIdentity: Awaited<ReturnType<typeof handle.stat>>
    try {
      await handle.writeFile(content, { encoding: 'utf8' })
      await handle.sync()
      writtenIdentity = await handle.stat()
      if (!writtenIdentity.isFile() || writtenIdentity.nlink !== 1) {
        throw new Error('临时计划文件不是唯一普通文件')
      }

      const pathIdentity = await lstat(tempPath)
      if (
        pathIdentity.isSymbolicLink() ||
        !pathIdentity.isFile() ||
        pathIdentity.nlink !== 1 ||
        !isSameFileIdentity(writtenIdentity, pathIdentity)
      ) {
        throw new Error('临时计划文件在写入期间被替换')
      }
    } finally {
      await handle.close()
    }

    await prepareSafePlanDirectory(workspaceRoot, planDirectory)
    await rejectLinkIfPresent(absolutePath, '计划文件')
    await rename(tempPath, absolutePath)
    tempCreated = false

    const { realWorkspace } = await prepareSafePlanDirectory(workspaceRoot, planDirectory)
    const targetIdentity = await lstat(absolutePath)
    const realTarget = await realpath(absolutePath)
    if (
      targetIdentity.isSymbolicLink() ||
      !targetIdentity.isFile() ||
      targetIdentity.nlink !== 1 ||
      !isSameFileIdentity(writtenIdentity, targetIdentity) ||
      !isWithinRoot(realWorkspace, realTarget)
    ) {
      throw new Error('计划文件写入后无法证明仍位于当前工作区')
    }
  } finally {
    if (tempCreated) {
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
  }
}

function resolveActivePlanPath(
  context: ToolContext,
  planDirectory: string,
  activePath: unknown
): string | null {
  if (!isPlanRelativePath(activePath)) return null
  const validated = resolveAndValidatePath(context.workingDir, activePath)
  if (!validated.ok) return null
  const rel = relative(planDirectory, validated.path)
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) {
    return null
  }
  return validated.path
}

function chooseNewPlanPath(planDirectory: string, title: string, now: Date): string {
  const base = `${formatLocalPlanDate(now)}-${toReadablePlanFilenamePart(title)}`
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const filename = suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`
    const candidate = join(planDirectory, filename)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('同名计划文件过多，无法生成唯一文件名')
}

export const savePlanTool: ToolExecutor = {
  name: 'save_plan',
  description:
    '把完整实施计划保存为当前项目内的 Markdown 文档。' +
    '路径由 Runtime 固定生成在 .nova/plans/，调用方不能指定任意路径；' +
    '同一会话使用相同标题时会修订当前计划，新标题会生成新的可读文件名。',
  executionMode: 'sequential',
  isConcurrencySafe: () => false,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '简短、可读的计划标题；会用于 Markdown 文件名。'
      },
      content: {
        type: 'string',
        description:
          '完整 Markdown 计划正文，必须包含目标、范围、架构依据、实施步骤、保护行为、风险、验证和回退。'
      }
    },
    required: ['title', 'content']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? normalizePlanTitle(args.title) : ''
    const content = typeof args.content === 'string' ? args.content.trimEnd() : ''
    if (!title) {
      return { success: false, output: '', error: 'title 不能为空' }
    }
    if (!content) {
      return { success: false, output: '', error: 'content 不能为空' }
    }
    if (content.length > MAX_PLAN_CONTENT_CHARS) {
      return {
        success: false,
        output: '',
        error: `计划正文超过 ${MAX_PLAN_CONTENT_CHARS} 字符限制`
      }
    }
    if (!context.sessionStore || !context.sessionId) {
      return {
        success: false,
        output: '',
        error: '缺少会话上下文，无法登记 active plan'
      }
    }

    const session = context.sessionStore.load(context.sessionId)
    if (!session) {
      return { success: false, output: '', error: '当前会话不存在' }
    }
    if (resolve(session.workspaceRoot).toLowerCase() !== resolve(context.workingDir).toLowerCase()) {
      return { success: false, output: '', error: '会话工作区与当前工具工作区不一致' }
    }

    const validatedDirectory = resolveAndValidatePath(context.workingDir, PLAN_RELATIVE_DIR)
    if (!validatedDirectory.ok) {
      return { success: false, output: '', error: validatedDirectory.error }
    }
    const planDirectory = validatedDirectory.path

    try {
      return await withFileMutationQueue(planDirectory, async () => {
        assertSideEffectAllowed(context, '保存计划')
        const conflict = await acquireWriterLeaseOrConflict({
          runId: context.runId,
          workspaceRoot: context.workspaceRoot ?? context.workingDir,
          abortSignal: context.abortSignal
        })
        if (conflict) return conflict

        await prepareSafePlanDirectory(context.workingDir, planDirectory)
        assertSideEffectAllowed(context, '保存计划')

        const activePath =
          session.activePlan?.title === title
            ? resolveActivePlanPath(context, planDirectory, session.activePlan.path)
            : null
        const absolutePath = activePath ?? chooseNewPlanPath(planDirectory, title, new Date())
        await rejectLinkIfPresent(absolutePath, '计划文件')

        const isNewFile = !existsSync(absolutePath)
        if (context.checkpointManager) {
          assertSideEffectAllowed(context, 'checkpoint backup')
          context.checkpointManager.backupBeforeWrite(absolutePath, isNewFile)
        }
        const effectToken = context.fileEffectRecorder?.prepareFileWrite(
          absolutePath,
          isNewFile ? 'create' : 'modify'
        )

        const normalizedContent = `${content}\n`
        await writePlanAtomically(
          context.workingDir,
          planDirectory,
          absolutePath,
          normalizedContent
        )
        assertSideEffectAllowed(context, '保存计划')
        if (effectToken) {
          context.fileEffectRecorder!.commitFileWrite(effectToken, absolutePath)
        }

        const written = await stat(absolutePath)
        context.readState.set(absolutePath, {
          content: normalizedContent.replace(/\r\n/g, '\n'),
          timestamp: written.mtimeMs
        })

        const relativePath = relative(context.workingDir, absolutePath).replace(/\\/g, '/')
        const updatedAt = Date.now()
        const updated = context.sessionStore!.updateActivePlan(context.sessionId!, {
          path: relativePath,
          title,
          updatedAt
        })
        if (!updated) {
          throw new Error('计划已写入，但 active plan 元数据更新失败')
        }

        return {
          success: true,
          output:
            `计划已保存到 "${relativePath}"，并登记为当前会话的 active plan。` +
            '用户确认后可使用 switch_mode 切换到 default，实施前先读取该文件。'
        }
      })
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `保存计划失败: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}
