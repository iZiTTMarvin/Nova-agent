import { describe, it, expect, vi } from 'vitest'
import { act, create as createRenderer } from 'react-test-renderer'
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

  it('合并卡片头部：已编辑文件数 + 总增删统计 + 每文件统计', () => {
    const diffs = [
      makeDiff({
        filePath: 'src/a.ts',
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, content: '+new1\n+new2\n ctx\n-old1' }]
      }),
      makeDiff({
        filePath: 'src/b.ts',
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, content: '+only' }]
      })
    ]

    const renderer = createRenderer(
      <DiffViewer diffs={diffs} reviews={{}} sessionId="sess_1" messageId="msg_1" />
    )

    expect(JSON.stringify(renderer.toJSON())).toContain('已编辑 2 个文件')
    // 总计 +3 -1（只按 +/- 前缀行计数，不含上下文行）
    const statText = (cls: string) => renderer.root.findByProps({ className: cls }).children.join('')
    expect(statText('diff-viewer__stat diff-viewer__stat--added')).toBe('+3')
    expect(statText('diff-viewer__stat diff-viewer__stat--removed')).toBe('-1')
    // 每文件行各自的增删统计
    const perFile = renderer.root
      .findAllByProps({ className: 'diff-file__changes-add' })
      .map(node => node.children.join(''))
    expect(perFile).toEqual(['+2', '+1'])
  })

  it('超过 3 个文件时默认折叠并显示「再显示 N 个文件」', () => {
    const diffs = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(filePath => makeDiff({ filePath }))

    const renderer = createRenderer(
      <DiffViewer diffs={diffs} reviews={{}} sessionId="sess_1" messageId="msg_1" />
    )

    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain('已编辑 5 个文件')
    expect(text).toContain('c.ts')
    expect(text).not.toContain('d.ts')

    const showMore = renderer.root.findByProps({ className: 'diff-viewer__show-more' })
    const label = showMore.children.filter(child => typeof child === 'string').join('')
    expect(label).toBe('再显示 2 个文件')
  })

  it('待审阅时头部提供撤销/接受批量操作', () => {
    const onAcceptAll = vi.fn().mockResolvedValue(undefined)
    const onRejectAll = vi.fn().mockResolvedValue({ restored: [], failed: [] })

    let renderer!: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(
        <DiffViewer
          diffs={[makeDiff()]}
          reviews={{}}
          sessionId="sess_1"
          messageId="msg_1"
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
        />
      )
    })

    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain('撤销')
    expect(text).toContain('接受')

    const acceptBtn = renderer.root.findByProps({ className: 'diff-header-btn diff-header-btn--primary' })
    act(() => {
      acceptBtn.props.onClick()
    })
    expect(onAcceptAll).toHaveBeenCalledWith(['src/a.ts'])
  })
})
