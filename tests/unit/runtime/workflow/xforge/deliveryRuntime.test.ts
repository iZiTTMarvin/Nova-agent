import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  captureXForgeWorkspaceBaseline,
  captureXForgeWorkspaceFingerprint,
  createXForgeReviewSnapshot,
  parseCommandArgv,
  recordXForgeTestEvidence,
  resolveXForgeVerificationTimeout,
  runXForgeControlledTestCommand,
  writeXForgeRuntimeReport,
  type XForgeReportFactsState,
  type XForgeTestEvidenceState
} from '../../../../../src/runtime/workflow/xforge'
import {
  buildFileEffectReceipt,
  hashContent,
  recordFileEffect
} from '../../../../../src/runtime/workflow/v2/EffectReceipt'

describe('XForge delivery Runtime adapters', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-runtime-'))
    fs.writeFileSync(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8'
    )
  })

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('真实 verification runner 执行命令并把证据落到 run 目录', async () => {
    const result = await runXForgeControlledTestCommand(
      { workspaceRoot, runId: 'run-1' },
      { command: 'npm test', required: true, reason: 'smoke' }
    )

    expect(result.evidenceRef.path).toMatch(/\.nova\/compose\/runs\/run-1\/evidence\//)
    expect(fs.existsSync(path.join(workspaceRoot, result.evidenceRef.path!))).toBe(true)
    const evidence = fs.readFileSync(path.join(workspaceRoot, result.evidenceRef.path!), 'utf8')
    expect(result.exitCode, evidence).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('高风险命令在启动子进程前被拒绝', async () => {
    const result = await runXForgeControlledTestCommand(
      { workspaceRoot, runId: 'run-1' },
      { command: 'npm test && git push', required: true, reason: 'invalid' }
    )

    expect(result.exitCode).toBeNull()
    expect(result.blockedReason).toMatch(/拒绝非验证或高风险命令/)
    expect(result.evidenceRef.unverified).toBe(true)
  })

  it('受控命令尊重调用方传入的超时，命令类型使用较长默认预算', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'slow.test.mjs'), [
      "import test from 'node:test'",
      "test('slow', async () => { await new Promise(resolve => setTimeout(resolve, 500)) })"
    ].join('\n'))
    const result = await runXForgeControlledTestCommand(
      { workspaceRoot, runId: 'run-timeout' },
      { command: 'node --test slow.test.mjs', required: true, reason: 'timeout regression', timeoutMs: 25 }
    )

    expect(result.timedOut).toBe(true)
    expect(resolveXForgeVerificationTimeout('npm run lint')).toBe(120_000)
    expect(resolveXForgeVerificationTimeout('npm test')).toBe(180_000)
    expect(resolveXForgeVerificationTimeout('npm run build')).toBe(180_000)
  })

  it('受控验证以 argv 执行，shell 命令替换不会产生副作用', async () => {
    const command = `node --test $(node -e "require('fs').writeFileSync('owned','1')")`
    const result = await runXForgeControlledTestCommand(
      { workspaceRoot, runId: 'run-shell-injection' },
      { command, required: true, reason: 'injection regression' }
    )

    expect(result.exitCode).not.toBe(0)
    expect(fs.existsSync(path.join(workspaceRoot, 'owned'))).toBe(false)
    expect(parseCommandArgv(`npm test -- --testNamePattern="safe value"`)).toEqual([
      'npm', 'test', '--', '--testNamePattern=safe value'
    ])
    expect(parseCommandArgv(`npm test "unterminated`)).toBeNull()
  })

  it('Fingerprint 使用内容摘要，测试证据与事实报告均由 Runtime 写入', () => {
    const fingerprint = captureXForgeWorkspaceFingerprint(workspaceRoot, 3)
    const evidence: XForgeTestEvidenceState = {
      workspaceRevision: 3,
      fingerprint,
      commands: [{
        command: 'npm test',
        required: true,
        exitCode: 0,
        timedOut: false,
        evidenceRef: { kind: 'runtime-command', note: 'passed' }
      }],
      passed: true,
      capturedAt: Date.now()
    }
    const recorded = recordXForgeTestEvidence({ workspaceRoot, runId: 'run-1' }, evidence)
    const report = writeXForgeRuntimeReport(
      { workspaceRoot, runId: 'run-1' },
      reportFacts(evidence)
    )

    expect(recorded.artifact.path).toMatch(/evidence/)
    expect(recorded.evidenceRef.path).toMatch(/evidence/)
    expect(report.artifact.path).toMatch(/report/)
    expect(fs.readFileSync(path.join(workspaceRoot, report.artifact.path!), 'utf8'))
      .toContain('Not executed: commit, push, deploy, publish')
  })

  it('Review Snapshot 在 run_effects 下只包含 receipt 文件，且需要 baseline', async () => {
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    fs.writeFileSync(path.join(workspaceRoot, 'tracked.ts'), 'export const value = 1\n', 'utf8')
    git('add', 'tracked.ts', 'package.json')
    git('commit', '-qm', 'baseline')
    fs.writeFileSync(path.join(workspaceRoot, 'user-only.ts'), 'user\n', 'utf8')

    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    const abs = path.join(workspaceRoot, 'owned.ts')
    fs.writeFileSync(abs, 'owned\n', 'utf8')
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId: 'run-review',
      absPath: abs,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent('owned\n'),
      effectId: 'effect-owned',
      status: 'committed'
    }))

    const result = await createXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-review',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['owned.ts']
    })

    expect(result.blockedReason).toBeUndefined()
    expect(result.snapshot?.changedFiles).toEqual(['owned.ts'])
    expect(result.snapshot?.changedFiles).not.toContain('user-only.ts')
    expect(result.snapshot?.targetKind).toBe('run_effects')
  }, 15_000)

  it('Review Snapshot 遇到敏感文件时安全阻塞且不读取正文', async () => {
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('add', 'package.json')
    git('commit', '-qm', 'baseline')

    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    const abs = path.join(workspaceRoot, '.env')
    fs.writeFileSync(abs, 'SECRET=do-not-read', 'utf8')
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId: 'run-review',
      absPath: abs,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent('SECRET=do-not-read'),
      effectId: 'effect-env',
      status: 'committed'
    }))

    const result = await createXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-review',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['*']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/敏感文件/)
  })

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: workspaceRoot, windowsHide: true })
  }
})

function reportFacts(evidence: XForgeTestEvidenceState): XForgeReportFactsState {
  return {
    runId: 'run-1',
    finalWorkspaceRevision: 3,
    testPassed: true,
    testCommands: evidence.commands,
    completedTasks: ['task-1'],
    unverifiedTasks: ['task-2'],
    skippedTasks: [],
    blockingFindings: [],
    technicalDebt: [],
    budgets: {
      scopeCorrectionUsed: 0,
      deliveryTestFixUsed: 0,
      reviewRemediationUsed: 0
    },
    shipRequested: false,
    notExecuted: ['commit', 'push', 'deploy', 'publish']
  }
}
