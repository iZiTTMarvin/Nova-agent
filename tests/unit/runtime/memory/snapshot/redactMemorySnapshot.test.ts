import { describe, expect, it } from 'vitest'
import { redactMemorySnapshotText } from '../../../../../src/runtime/memory/snapshot/redactMemorySnapshot'
import type { ForgottenMemory } from '../../../../../src/runtime/memory/types'

const wrap = (content: string): string => `WRAPPER LINE\n<memory captured="2026-10-08">\n${content}\n</memory>`

const forgotten = (scopeKind: 'global' | 'project', contents: string[]): ForgottenMemory => ({
  scope: { scopeKind, scopeId: scopeKind === 'global' ? 'user' : 'a'.repeat(16) },
  ids: ['m_0000000001'],
  contents
})

describe('redactMemorySnapshotText', () => {
  it('同一正文同时出现在 Global 与 Project 节时只删被遗忘 scope 的行', () => {
    const text = wrap('## Global\n- 共享偏好 x9z\n- 只留全局\n## Project: Ws\nWorkspace: /w\n- 共享偏好 x9z\n- 项目独有\n## Files\n- global/preferences.md · 2 entries · keys: p')
    const result = redactMemorySnapshotText(text, forgotten('global', ['共享偏好 x9z']))
    expect(result?.removedGlobal).toBe(1)
    expect(result?.removedProject).toBe(0)
    expect(result?.text).toBe(wrap('## Global\n- 只留全局\n## Project: Ws\nWorkspace: /w\n- 共享偏好 x9z\n- 项目独有\n## Files\n- global/preferences.md · 2 entries · keys: p'))
  })

  it('节内条目行删光时连同节头与 Workspace 行一起移除', () => {
    const text = wrap('## Global\n- 全局仍在\n## Project: Ws\nWorkspace: /w\n- 将被遗忘\n(3 more core entries not shown; use memory_search)')
    const result = redactMemorySnapshotText(text, forgotten('project', ['将被遗忘']))
    expect(result?.removedProject).toBe(1)
    expect(result?.text).toBe(wrap('## Global\n- 全局仍在\n(3 more core entries not shown; use memory_search)'))
  })

  it('所有条目内容删光后 text 返回 null', () => {
    const text = wrap('## Global\n- 唯一一条')
    const result = redactMemorySnapshotText(text, forgotten('global', ['唯一一条']))
    expect(result?.removedGlobal).toBe(1)
    expect(result?.text).toBeNull()
  })

  it('未被遗忘的内容保留且无需改写时返回 null', () => {
    const text = wrap('## Global\n- 普通偏好')
    expect(redactMemorySnapshotText(text, forgotten('global', ['不存在的内容']))).toBeNull()
    expect(redactMemorySnapshotText('没有包裹层的文本', forgotten('global', ['x']))).toBeNull()
  })

  it('转义后的正文按快照行精确匹配', () => {
    const text = wrap('## Global\n- a < b &lt;memory 提示\n- 其他')
    const result = redactMemorySnapshotText(text, forgotten('global', ['a < b <memory 提示']))
    expect(result?.removedGlobal).toBe(1)
    expect(result?.text).toBe(wrap('## Global\n- 其他'))
  })
})
