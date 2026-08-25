/**
 * shell_session 工具 — 操作 bash 让出后的持久进程会话。
 *
 * bash 前台等待到边界后把进程登记进 processRegistry 并返回 ref；本工具按 ref
 * 续操作：read 游标式读取（有界等待新输出）、write 写 stdin、interrupt 尽力中断、
 * stop 终止并收终态。进程生命周期归 processRegistry，本工具只发起请求与组装结果。
 */
import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import { processRegistry, ProcessSessionError, type ReadPage } from '../../process'
import { recordSessionBoundary, claimSpillArtifact } from '../bash'
import { acquireWriterLeaseOrConflict } from '../../workspace'

/** read 有界等待：输出静默该时长即返回（输出到达后重新计静默） */
const READ_SILENCE_MS = 2_000
/** read 有界等待硬上限 */
const READ_MAX_MS = 30_000
let readSilenceMs = READ_SILENCE_MS
let readMaxMs = READ_MAX_MS

/** 仅供测试注入等待参数 */
export function setShellSessionWaitForTests(opts: { silenceMs?: number; maxMs?: number }): void {
  if (opts.silenceMs !== undefined) readSilenceMs = opts.silenceMs
  if (opts.maxMs !== undefined) readMaxMs = opts.maxMs
}

const ACTIONS = new Set(['read', 'write', 'interrupt', 'stop'])

export const shellSessionTool: ToolExecutor = {
  name: 'shell_session',
  description:
    '操作 bash 长命令让出后的持久进程会话：read 读取新输出（游标推进）；write 向进程 stdin 写入输入（内容需自带换行）；interrupt 尽力发送中断信号（Windows 不支持时返回明确提示）；stop 终止进程并收取最终输出。',
  executionMode: 'sequential',
  maxResultSizeChars: 50_000,
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'bash 返回的进程会话引用（processHandle.ref）' },
      action: {
        type: 'string',
        enum: ['read', 'write', 'interrupt', 'stop'],
        description: '要执行的动作'
      },
      input: {
        type: 'string',
        description: 'write 动作写入进程 stdin 的内容；需要自带换行符才会被行缓冲程序接收'
      }
    },
    required: ['ref', 'action']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!context.sessionId) {
      return { success: false, output: '', error: '缺少会话身份，无法操作进程会话' }
    }
    const ref = typeof args.ref === 'string' ? args.ref : ''
    const action = typeof args.action === 'string' ? args.action : ''
    if (!ref) {
      return { success: false, output: '', error: '缺少 ref 参数（bash 返回的 processHandle.ref）' }
    }
    if (!ACTIONS.has(action)) {
      return {
        success: false,
        output: '',
        error: `未知的 action: ${action || '(空)'}，可选 read / write / interrupt / stop`
      }
    }
    try {
      if (action === 'read') return await executeRead(ref, context)
      if (action === 'write') return await executeWrite(ref, args.input, context)
      if (action === 'interrupt') return await executeInterrupt(ref, context)
      return await executeStop(ref, context)
    } catch (e) {
      if (e instanceof ProcessSessionError) {
        return { success: false, output: '', error: e.message }
      }
      throw e
    }
  }
}

/** 会话边界记账失败只降级（基线不滚动、下次重记），不阻断动作结果交付 */
async function recordBoundaryQuietly(ref: string, context: ToolContext): Promise<void> {
  try {
    await recordSessionBoundary(ref, context)
  } catch (e) {
    console.error('shell_session 会话边界 checkpoint 记账失败:', e)
  }
}

interface PageView {
  page: ReadPage
  state: 'running' | 'exited'
  exitCode: number | null
  /** 追加在输出尾部的提示（quiet / cap / 幂等终态） */
  notice: string | null
}

async function executeRead(ref: string, context: ToolContext): Promise<ToolResult> {
  const sessionId = context.sessionId!
  let view: PageView
  const first = processRegistry.readPage(ref, sessionId)
  if (first.page.text.length > 0 || first.page.hasMore) {
    view = { ...first, notice: null }
  } else if (first.state === 'running') {
    const outcome = await processRegistry.waitForOutput(ref, sessionId, {
      silenceMs: readSilenceMs,
      maxMs: readMaxMs,
      abortSignal: context.abortSignal
    })
    const next = processRegistry.readPage(ref, sessionId)
    if (outcome === 'quiet') {
      view = { ...next, notice: null }
    } else if (outcome === 'cap') {
      view = { ...next, notice: '[等待已达上限，继续 read 可再次等待]' }
    } else {
      // data / settled：直接交付增量（settled 后 readPage 已含终态）
      view = { ...next, notice: null }
    }
  } else {
    // 已退出且无未读：幂等终态，返回同一 exitCode，绝不退化为未知 ref 错误
    view = { ...first, notice: '(无更多输出，会话已结束)' }
  }

  await recordBoundaryQuietly(ref, context)

  let output = view.page.text
  if (output.length === 0) {
    output = view.state === 'exited' ? '(无更多输出，会话已结束)' : '(暂无新输出)'
  }
  if (view.notice) output += `\n${view.notice}`
  if (view.page.hasMore) output += '\n[输出未读完，继续 read]'
  const spill = view.page.spill
    ? await claimSpillArtifact(view.page.spill, context)
    : { line: null }
  if (spill.line) output += `\n${spill.line}`
  output +=
    view.state === 'running'
      ? `\n[进程仍在运行 ref: ${ref}]`
      : `\n[会话已结束，退出码: ${
          view.exitCode !== null ? view.exitCode : '（未报告退出码）'
        }]`
  return {
    success: true,
    output,
    processHandle: { ref, state: view.state },
    ...(view.state === 'exited' && view.exitCode !== null ? { exitCode: view.exitCode } : {}),
    ...(spill.artifactId ? { artifactId: spill.artifactId } : {})
  }
}

async function executeWrite(
  ref: string,
  rawInput: unknown,
  context: ToolContext
): Promise<ToolResult> {
  const sessionId = context.sessionId!
  // 破坏性命令的会话写输入等同改工作区：write 前瞬时抢写者租约。
  // 租约按 run 幂等、由既有 run 收尾释放，持久会话不持长租约——每次 write 前抢约即此含义。
  if (processRegistry.describe(ref, sessionId).destructive) {
    const conflict = await acquireWriterLeaseOrConflict({
      runId: context.resourceOwnerRunId ?? context.runId,
      workspaceRoot: context.workspaceRoot ?? context.workingDir,
      abortSignal: context.abortSignal
    })
    if (conflict) return conflict
  }
  const input = typeof rawInput === 'string' ? rawInput : ''
  const { state } = await processRegistry.writeInput(ref, sessionId, input)
  await recordBoundaryQuietly(ref, context)
  return {
    success: true,
    output: `已写入 ${input.length} 字节；进程当前${
      state === 'running' ? '仍在运行' : '已退出'
    }。后续输出用 read 读取`,
    processHandle: { ref, state }
  }
}

async function executeInterrupt(ref: string, context: ToolContext): Promise<ToolResult> {
  const sessionId = context.sessionId!
  let state: 'running' | 'exited'
  try {
    ;({ state } = processRegistry.interrupt(ref, sessionId))
  } catch (e) {
    if (e instanceof ProcessSessionError && e.code === 'unsupported-on-windows') {
      return {
        success: false,
        output: '',
        error: '当前平台不支持 interrupt（pipe 后端无法产生 Ctrl-C），请改用 stop 终止会话'
      }
    }
    throw e
  }
  await recordBoundaryQuietly(ref, context)
  return {
    success: true,
    output: `已向进程发送中断信号，进程当前${state === 'running' ? '仍在运行' : '已退出'}`,
    processHandle: { ref, state }
  }
}

async function executeStop(ref: string, context: ToolContext): Promise<ToolResult> {
  const sessionId = context.sessionId!
  // 终止前的改动入账：先记账再杀进程，杀树期间的最后一批写入也能进 checkpoint
  await recordBoundaryQuietly(ref, context)
  const { page, exitCode } = await processRegistry.stopSession(ref, sessionId)

  let output = page.text
  if (output.length === 0) output = '(无更多输出)'
  if (page.hasMore) output += '\n[输出未读完，继续 read]'
  const spill = page.spill
    ? await claimSpillArtifact(page.spill, context)
    : { line: null }
  if (spill.line) output += `\n${spill.line}`
  output +=
    exitCode !== null
      ? `\n[会话已终止，退出码: ${exitCode}]`
      : '\n[会话已终止（未报告退出码）]'
  return {
    success: true,
    output,
    processHandle: { ref, state: 'exited' },
    ...(exitCode !== null ? { exitCode } : {}),
    ...(spill.artifactId ? { artifactId: spill.artifactId } : {})
  }
}
