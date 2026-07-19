import { randomUUID } from 'crypto'
import { authorizeXForgeVerificationCommand } from './policy'
import type {
  XForgeControlledTestCommand,
  XForgeRuntimeCommandResult
} from './deliveryExecutor'
import type {
  XForgeReportFactsState,
  XForgeTestEvidenceState,
  XForgeWorkspaceFingerprint
} from './runState'
import {
  buildXForgeReviewSnapshot,
  type XForgeReviewWorkspaceSnapshot
} from './reviewSnapshot'
import type { XForgeReviewTarget, XForgeWorkspaceBaselineV1 } from './workspaceBaseline'
import {
  createWorkspaceFingerprint,
  writeXForgeArtifact,
  writeXForgeEvidence
} from './stageArtifacts'
import type { VerificationCommandType } from '../../verification/types'
import { runVerificationExecutable } from '../../verification/runner'

export interface XForgeDeliveryRuntimeOptions {
  workspaceRoot: string
  runId: string
  abortSignal?: AbortSignal
}

const FAST_VERIFICATION_TIMEOUT_MS = 120_000
const SLOW_VERIFICATION_TIMEOUT_MS = 180_000

export function captureXForgeWorkspaceFingerprint(
  workspaceRoot: string,
  workspaceRevision: number
): XForgeWorkspaceFingerprint {
  return createWorkspaceFingerprint(workspaceRoot, { revision: workspaceRevision })
}

/** 通过既有 verification runner 执行命令，证据由 Runtime 落盘。 */
export async function runXForgeControlledTestCommand(
  options: XForgeDeliveryRuntimeOptions,
  command: XForgeControlledTestCommand
): Promise<XForgeRuntimeCommandResult> {
  const verificationDecision = authorizeXForgeVerificationCommand(command.command)
  if (!verificationDecision.allowed) {
    return {
      exitCode: null,
      timedOut: false,
      blockedReason: verificationDecision.reason,
      evidenceRef: { kind: 'runtime-command', note: 'blocked-before-execution', unverified: true }
    }
  }

  const argv = parseCommandArgv(command.command)
  if (!argv || argv.length === 0) {
    return {
      exitCode: null,
      timedOut: false,
      blockedReason: `验证命令参数无法安全解析: ${command.command}`,
      evidenceRef: { kind: 'runtime-command', note: 'blocked-invalid-argv', unverified: true }
    }
  }
  const result = await runVerificationExecutable(
    argv[0],
    argv.slice(1),
    command.command,
    classifyCommand(command.command),
    options.workspaceRoot,
    { abortSignal: options.abortSignal, timeoutMs: command.timeoutMs }
  )
  const evidenceRef = writeXForgeEvidence({
    workspaceRoot: options.workspaceRoot,
    runId: options.runId,
    kind: 'runtime-command',
    name: `command-${randomUUID()}`,
    content: renderCommandEvidence(command, result)
  })
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    ...(result.cancelled ? { blockedReason: '验证被取消' } : {}),
    evidenceRef
  }
}

/** 交付验证按命令性质配置预算，避免完整测试或构建被默认 60 秒误杀。 */
export function resolveXForgeVerificationTimeout(command: string): number {
  return /\b(?:lint|typecheck|tsc)\b/i.test(command)
    ? FAST_VERIFICATION_TIMEOUT_MS
    : SLOW_VERIFICATION_TIMEOUT_MS
}

/** 解析验证命令的引号与空白；返回值直接交给 execFile，不再经 shell。 */
export function parseCommandArgv(command: string): string[] | null {
  const args: string[] = []
  let token = ''
  let quote: 'single' | 'double' | null = null
  let tokenStarted = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === null && /\s/.test(char)) {
      if (tokenStarted) {
        args.push(token)
        token = ''
        tokenStarted = false
      }
      continue
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single'
      tokenStarted = true
      continue
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double'
      tokenStarted = true
      continue
    }
    if (char === '\\' && quote === 'double' && /["\\]/.test(command[index + 1] ?? '')) {
      token += command[index + 1]
      tokenStarted = true
      index += 1
      continue
    }
    token += char
    tokenStarted = true
  }

  if (quote !== null) return null
  if (tokenStarted) args.push(token)
  return args
}

export function recordXForgeTestEvidence(
  options: Pick<XForgeDeliveryRuntimeOptions, 'workspaceRoot' | 'runId'>,
  evidence: XForgeTestEvidenceState
) {
  const content = renderTestEvidence(evidence)
  return {
    artifact: writeXForgeArtifact({
      workspaceRoot: options.workspaceRoot,
      runId: options.runId,
      stage: 'test',
      kind: 'evidence',
      name: `test-gate-r${evidence.workspaceRevision}`,
      content
    }),
    evidenceRef: writeXForgeEvidence({
      workspaceRoot: options.workspaceRoot,
      runId: options.runId,
      kind: 'test-gate',
      name: `test-gate-r${evidence.workspaceRevision}`,
      content
    })
  }
}

/**
 * 构造无工具 Review 子代理消费的不可变变更快照。
 * 文件集合权威来源：baseline + committed EffectReceipts + changeScope（或 existing_worktree 冻结脏集）。
 */
export async function createXForgeReviewSnapshot(options: {
  workspaceRoot: string
  runId: string
  baseline: XForgeWorkspaceBaselineV1 | null | undefined
  reviewTarget: XForgeReviewTarget | null | undefined
  changeScope: readonly string[] | null | undefined
}): Promise<{ snapshot?: XForgeReviewWorkspaceSnapshot; blockedReason?: string }> {
  return buildXForgeReviewSnapshot(options)
}

export function writeXForgeRuntimeReport(
  options: Pick<XForgeDeliveryRuntimeOptions, 'workspaceRoot' | 'runId'>,
  facts: XForgeReportFactsState
) {
  return {
    artifact: writeXForgeArtifact({
      workspaceRoot: options.workspaceRoot,
      runId: options.runId,
      stage: 'report',
      kind: 'report',
      name: 'final-report',
      content: renderReport(facts)
    })
  }
}

function classifyCommand(command: string): VerificationCommandType {
  if (/\blint\b/i.test(command)) return 'lint'
  if (/\b(build|typecheck|tsc)\b/i.test(command)) return 'build'
  return 'test'
}

function renderCommandEvidence(
  command: XForgeControlledTestCommand,
  result: Awaited<ReturnType<typeof runVerificationExecutable>>
): string {
  return [
    `# Runtime Command Evidence`,
    `- Command: \`${command.command}\``,
    `- Required: ${command.required}`,
    `- Exit code: ${result.exitCode ?? 'null'}`,
    `- Timed out: ${result.timedOut === true}`,
    `- Cancelled: ${result.cancelled === true}`,
    `- Duration: ${result.durationMs}ms`,
    '',
    '```text',
    result.output.replace(/```/g, '``\u200b`'),
    '```'
  ].join('\n')
}

function renderTestEvidence(evidence: XForgeTestEvidenceState): string {
  const commands = evidence.commands.map(command =>
    `- ${command.required ? '[required]' : '[optional]'} \`${command.command}\`: ` +
    `exit=${command.exitCode ?? 'null'}, timeout=${command.timedOut}`
  )
  return [
    '# Test Gate Evidence',
    `- Workspace revision: ${evidence.workspaceRevision}`,
    `- Fingerprint: ${evidence.fingerprint.digest}`,
    `- Passed: ${evidence.passed}`,
    '',
    ...commands
  ].join('\n')
}

function renderReport(facts: XForgeReportFactsState): string {
  const testLines = facts.testCommands.map(command =>
    `- \`${command.command}\`: exit=${command.exitCode ?? 'null'}, timeout=${command.timedOut}`
  )
  const debtLines = facts.technicalDebt.map(finding =>
    `- [${finding.severity}] ${finding.location}: ${finding.summary}`
  )
  return [
    '# XForge Delivery Report',
    `- Run: ${facts.runId}`,
    `- Workspace revision: ${facts.finalWorkspaceRevision}`,
    `- Test passed: ${facts.testPassed}`,
    `- Ship requested: ${facts.shipRequested}`,
    `- Not executed: ${facts.notExecuted.join(', ')}`,
    '',
    '## Runtime tests',
    ...(testLines.length > 0 ? testLines : ['- No runtime test evidence']),
    '',
    '## Unverified tasks',
    ...(facts.unverifiedTasks.length > 0 ? facts.unverifiedTasks.map(taskId => `- ${taskId}`) : ['- None']),
    '',
    '## Technical debt',
    ...(debtLines.length > 0 ? debtLines : ['- None'])
  ].join('\n')
}
