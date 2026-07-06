/**
 * MemoryConsolidator 纯逻辑单测
 */
import { describe, it, expect } from 'vitest'
import { consolidateObservations, consolidateExtracted, shouldAutoMergeExtracted } from '../../../../src/runtime/memory/MemoryConsolidator'
import type { MemoryObservation } from '../../../../src/runtime/memory/ObservationCapture'

function makeObs(partial: Partial<MemoryObservation> & Pick<MemoryObservation, 'fingerprint'>): MemoryObservation {
  return {
    id: 'obs_1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    toolCallId: 'tc-1',
    toolName: 'edit',
    title: 'edit src/a.ts',
    facts: ['ok'],
    filesTouched: ['src/a.ts'],
    fingerprint: partial.fingerprint,
    capturedAt: 1_700_000_000_000,
    hadSensitive: false,
    ...partial
  }
}

describe('consolidateObservations', () => {
  it('空输入返回空字符串', () => {
    expect(consolidateObservations([])).toBe('')
  })

  it('生成带日期与 sessionId 的块头', () => {
    const md = consolidateObservations(
      [makeObs({ fingerprint: 'fp1' })],
      { now: () => new Date('2026-07-06T12:00:00Z').getTime() }
    )
    expect(md).toContain('## 2026-07-06 — session sess-1')
    expect(md).toContain('- **edit src/a.ts**')
    expect(md).toContain('  - ok')
    expect(md).toContain('  - Files: src/a.ts')
    expect(md).toContain('---')
  })

  it('同 fingerprint 去重合并 facts 与 files', () => {
    const a = makeObs({ fingerprint: 'same', facts: ['line1'], filesTouched: ['a.ts'] })
    const b = makeObs({
      fingerprint: 'same',
      facts: ['line2'],
      filesTouched: ['b.ts'],
      capturedAt: 1_700_000_000_100
    })
    const md = consolidateObservations([a, b])
    expect(md.match(/- \*\*edit src\/a\.ts\*\*/g)?.length).toBe(1)
    expect(md).toContain('line1')
    expect(md).toContain('line2')
    expect(md).toContain('a.ts, b.ts')
  })
})

describe('consolidateExtracted', () => {
  it('生成 episodic Markdown 格式', () => {
    const { episodicMarkdown } = consolidateExtracted(
      [
        {
          userNeed: '部署慢',
          approach: 'wasm',
          outcome: '成功完成',
          whatFailed: 'sqlite wasm 失败',
          whatWorked: '原生模块',
          tags: ['build']
        }
      ],
      'sess-x',
      { now: () => new Date('2026-07-06T12:00:00Z').getTime() }
    )
    expect(episodicMarkdown).toContain('## 2026-07-06 — session sess-x')
    expect(episodicMarkdown).toContain('**需求**：部署慢')
    expect(episodicMarkdown).toContain('⚠️ 踩坑')
    expect(episodicMarkdown).toContain('✅ 有效')
  })

  it('autoMerge 开启时高分结论追加 MEMORY 块', () => {
    const { memoryAppendMarkdown } = consolidateExtracted(
      [
        {
          userNeed: '修复登录',
          approach: '改 cookie',
          outcome: '成功完成',
          whatFailed: '',
          whatWorked: 'httponly',
          tags: []
        }
      ],
      'sess-y',
      { autoMergeEnabled: true, now: () => Date.now() }
    )
    expect(memoryAppendMarkdown).toContain('提炼摘要')
    expect(memoryAppendMarkdown).toContain('修复登录')
  })

  it('shouldAutoMergeExtracted 识别踩坑与成功', () => {
    expect(
      shouldAutoMergeExtracted({
        userNeed: 'a',
        approach: 'b',
        outcome: '失败',
        whatFailed: 'OOM',
        whatWorked: '',
        tags: []
      })
    ).toBe(true)
    expect(
      shouldAutoMergeExtracted({
        userNeed: 'a',
        approach: 'b',
        outcome: '成功完成',
        whatFailed: '',
        whatWorked: '',
        tags: []
      })
    ).toBe(true)
  })
})
