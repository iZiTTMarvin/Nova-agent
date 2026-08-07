import { describe, expect, it } from 'vitest'
import { listSidebarRootSessions, resolveSidebarActiveSessionId } from '../../../src/renderer/features/subagents/sidebarSessions'
import type { Session } from '../../../src/shared/session/types'

const parent: Session = {
  id: 'parent',
  kind: 'primary',
  workspaceRoot: 'D:/workspace',
  mode: 'default',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  title: 'Parent'
}

const child: Session = {
  id: 'child',
  kind: 'subagent',
  workspaceRoot: 'D:/workspace',
  mode: 'plan',
  createdAt: 2,
  updatedAt: 2,
  messageCount: 1,
  title: 'Child',
  subagent: {
    lineage: {
      parentSessionId: 'parent',
      depth: 1
    },
    profile: { profileId: 'explore', name: 'Explore', permissionCeiling: 'read_only' }
  }
}

describe('listSidebarRootSessions', () => {
  it('只返回 primary 会话，子代理不进入侧栏列表', () => {
    expect(listSidebarRootSessions([child, parent]).map((session) => session.id)).toEqual(['parent'])
  })

  it('损坏 lineage 的孤儿子代理也不进入侧栏', () => {
    const orphan: Session = {
      ...child,
      id: 'orphan',
      subagent: {
        ...child.subagent,
        lineage: { parentSessionId: 'missing-parent', depth: 1 }
      }
    }
    expect(listSidebarRootSessions([orphan, parent])).toEqual([parent])
  })
})

describe('resolveSidebarActiveSessionId', () => {
  it('焦点为子代理时映射到父会话 id', () => {
    expect(resolveSidebarActiveSessionId([parent, child], child.id)).toBe(parent.id)
  })

  it('焦点为 primary 时原样返回', () => {
    expect(resolveSidebarActiveSessionId([parent, child], parent.id)).toBe(parent.id)
  })
})
