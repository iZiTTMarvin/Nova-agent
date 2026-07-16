import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runXForgeControlledTestCommand } from '../../runtime/workflow/xforge/deliveryRuntime'

export interface XForgeTestGateSmokeResult {
  exitCode: number | null
  timedOut: boolean
  blockedReason?: string
  evidence?: string
}

/** 在当前 Electron 可执行文件上下文中验证 npm 型 Test Gate 的命令定位。 */
export async function runXForgeTestGateSmoke(): Promise<XForgeTestGateSmokeResult> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nova-xforge-test-gate-'))
  try {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test smoke.test.mjs' }
    }), 'utf8')
    writeFileSync(join(workspaceRoot, 'smoke.test.mjs'), [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "test('installed test gate', () => assert.equal(1, 1))"
    ].join('\n'), 'utf8')

    const result = await runXForgeControlledTestCommand(
      { workspaceRoot, runId: 'installed-test-gate-smoke' },
      { command: 'npm test', required: true, reason: 'installed XForge Test Gate smoke' }
    )
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
      ...(result.evidenceRef.path
        ? { evidence: readFileSync(join(workspaceRoot, result.evidenceRef.path), 'utf8').slice(-4_000) }
        : {})
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
}
