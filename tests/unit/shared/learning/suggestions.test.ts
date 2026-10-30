import { describe, expect, it } from 'vitest'
import {
  LEARNING_SUGGESTIONS_MAX,
  parseLearningSuggestions,
  stripLearningSuggestions
} from '../../../../src/shared/learning/suggestions'

const reply = (block: string): string => `IPC 把请求从界面交给主进程。\n\n${block}`

describe('learning suggestions', () => {
  it('取最后一个完整推荐块，去掉编号、空行与重复项，并限制条数', () => {
    const text = reply([
      '```suggestions',
      '- 主进程收到后怎么分发？',
      '',
      '2. 画一下这条请求链路',
      '* 主进程收到后怎么分发？',
      '考考我这一段',
      '为什么不让界面直接读文件？',
      '```'
    ].join('\n'))
    expect(parseLearningSuggestions(text)).toEqual([
      '主进程收到后怎么分发？',
      '画一下这条请求链路',
      '考考我这一段'
    ])
    expect(parseLearningSuggestions(text)).toHaveLength(LEARNING_SUGGESTIONS_MAX)
  })

  it('流式中尚未闭合的推荐块不出建议，复制时连同未闭合部分一起去掉', () => {
    const streaming = reply('```suggestions\n- 主进程收到后怎么分发？')
    expect(parseLearningSuggestions(streaming)).toEqual([])
    expect(stripLearningSuggestions(streaming)).toBe('IPC 把请求从界面交给主进程。')
  })

  it('超长的一行不作为建议，其他代码块原样保留', () => {
    const text = `看这段：\n\n\`\`\`ts\nsend()\n\`\`\`\n\n\`\`\`suggestions\n${'很'.repeat(41)}\n接着讲主进程\n\`\`\``
    expect(parseLearningSuggestions(text)).toEqual(['接着讲主进程'])
    expect(stripLearningSuggestions(text)).toBe('看这段：\n\n```ts\nsend()\n```')
  })
})
