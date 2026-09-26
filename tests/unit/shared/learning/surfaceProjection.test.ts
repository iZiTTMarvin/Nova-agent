import { describe, expect, it } from 'vitest'
import { parseLearningDevLinkReference } from '../../../../src/shared/learning/surface'

describe('开发关联引用解析', () => {
  it('限制文件数量与路径长度', () => {
    const reference = parseLearningDevLinkReference({
      devSessionId: 'dev-1',
      devMessageId: 'msg-1',
      filePaths: ['src/a.ts']
    })
    expect(reference.filePaths).toEqual(['src/a.ts'])
    expect(() =>
      parseLearningDevLinkReference({
        devSessionId: 'dev-1',
        devMessageId: 'msg-1',
        filePaths: Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`)
      })
    ).toThrow()
    expect(() =>
      parseLearningDevLinkReference({
        devSessionId: 'dev-1',
        devMessageId: 'msg-1',
        filePaths: ['x'.repeat(513)]
      })
    ).toThrow()
  })

  it('缺少会话或消息线索时拒绝', () => {
    expect(() =>
      parseLearningDevLinkReference({ devSessionId: 'dev-1', devMessageId: '', filePaths: [] })
    ).toThrow()
    expect(() =>
      parseLearningDevLinkReference({
        devSessionId: 'dev-1',
        devMessageId: 'msg-1',
        filePaths: 'not-an-array'
      })
    ).toThrow()
  })
})
