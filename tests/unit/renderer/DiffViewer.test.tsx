import { describe, it, expect } from 'vitest'
import { create as createRenderer } from 'react-test-renderer'
import { DiffViewer } from '../../../src/renderer/features/diff/DiffViewer'
import type { DiffEntry, SkippedFileInfo } from '../../../src/shared/diff/types'

/** 构造一个最小 DiffEntry */
function makeDiff(overrides: Partial<DiffEntry> = {}): DiffEntry {
  return {
    filePath: 'src/a.ts',
    hunks: [],
    status: 'modified',
    ...overrides
  }
}

describe('DiffViewer', () => {
  it('渲染 skippedFiles 提示列表', () => {
    const skippedFiles: SkippedFileInfo[] = [
      { path: 'assets/big.bin', reason: 'oversized', bytes: 6 * 1024 * 1024 },
      { path: 'node_modules/foo/index.js', reason: 'excluded', bytes: 0 }
    ]

    const tree = createRenderer(
      <DiffViewer
        diffs={[makeDiff()]}
        reviews={{}}
        skippedFiles={skippedFiles}
        sessionId="sess_1"
        messageId="msg_1"
      />
    ).toJSON()

    // 通过序列化字符串判断提示内容与文件列表均出现
    const text = JSON.stringify(tree)
    expect(text).toContain('未生成快照')
    expect(text).toContain('assets/big.bin')
    expect(text).toContain('node_modules/foo/index.js')
    expect(text).toContain('过大')
    expect(text).toContain('排除规则')
  })

  it('无 diff 但有 skippedFiles 时仍渲染提示', () => {
    const skippedFiles: SkippedFileInfo[] = [
      { path: 'huge.zip', reason: 'oversized', bytes: 1024 * 1024 * 1024 }
    ]

    const tree = createRenderer(
      <DiffViewer
        diffs={[]}
        reviews={{}}
        skippedFiles={skippedFiles}
        sessionId="sess_1"
        messageId="msg_1"
      />
    ).toJSON()

    const text = JSON.stringify(tree)
    expect(text).toContain('huge.zip')
  })
})
