import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReadState } from '../../../../../src/runtime/tools/editTool'
import { writeTool } from '../../../../../src/runtime/tools/writeTool'
import { XForgeFileEffectRecorder } from '../../../../../src/runtime/workflow/xforge/effectRecorder'
import { inspectXForgeTaskEffects } from '../../../../../src/runtime/workflow/xforge/writeSafety'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('XForge write/edit EffectReceipt integration', () => {
  it('write 在目标文件变更前 prepared，成功后 committed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-effect-'))
    roots.push(root)
    const recorder = new XForgeFileEffectRecorder(root, 'run-effect', () => 'T1')
    const result = await writeTool.execute(
      { path: 'created.ts', content: 'export const value = 1\n' },
      { workingDir: root, readState: createReadState(), fileEffectRecorder: recorder }
    )

    expect(result.success).toBe(true)
    expect(readFileSync(join(root, 'created.ts'), 'utf8')).toContain('value = 1')
    const inspection = inspectXForgeTaskEffects({
      workspaceRoot: root,
      runId: 'run-effect',
      taskId: 'T1'
    })
    expect(inspection.pending).toEqual([])
    expect(inspection.corruptReceiptIds).toEqual([])
    expect(inspection.effects).toEqual([
      expect.objectContaining({ path: 'created.ts', status: 'committed' })
    ])
  })
})
