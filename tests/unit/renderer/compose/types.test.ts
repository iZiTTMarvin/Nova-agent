import { describe, it, expect } from 'vitest'
import { parseComposeStateView } from '../../../../src/renderer/features/compose/types'

describe('parseComposeStateView', () => {
  it('解析有效 state', () => {
    const view = parseComposeStateView({
      run: {
        id: '2026-07-04-test',
        command: 'br-full-dev',
        script: 'br-full-dev',
        started_at: '2026-07-04T10:00:00',
        updated_at: '2026-07-04T10:05:00',
        status: 'running'
      },
      tasks: [{ id: 'task-001', title: 't', status: 'pending' }]
    })
    expect(view?.run.id).toBe('2026-07-04-test')
    expect(view?.tasks).toHaveLength(1)
  })

  it('无效对象返回 null', () => {
    expect(parseComposeStateView(null)).toBeNull()
    expect(parseComposeStateView({})).toBeNull()
  })
})
