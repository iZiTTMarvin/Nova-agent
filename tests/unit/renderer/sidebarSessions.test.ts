import { describe, expect, it } from 'vitest'
import {
  listBreadcrumbSessions,
  listPinnedSessions,
  listSidebarRootSessions,
  listSidebarSessionsForSurface,
  resolveSidebarActiveSessionId
} from '../../../src/renderer/features/subagents/sidebarSessions'
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
  mode: 'default',
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
  it('草稿不进历史、置顶或面包屑，旧空会话仍可见', () => {
    const draft: Session = { ...parent, id: 'draft', isDraft: true, pinned: true }
    expect(listSidebarRootSessions([draft, parent])).toEqual([parent])
    expect(listPinnedSessions([draft, parent])).toEqual([])
    expect(listBreadcrumbSessions([draft, parent], parent.workspaceRoot, 'dev')).toEqual([parent])
  })
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

const learnSession: Session = {
  ...parent,
  id: 'learn',
  mode: 'learn',
  title: 'Learn session'
}

describe('listSidebarSessionsForSurface', () => {
  it('开发面不显示 learn 会话，学习面只显示 learn 会话', () => {
    expect(listSidebarSessionsForSurface([parent, learnSession, child], 'dev').map(s => s.id)).toEqual(['parent'])
    expect(listSidebarSessionsForSurface([parent, learnSession, child], 'learn').map(s => s.id)).toEqual(['learn'])
  })
})

describe('listBreadcrumbSessions', () => {
  it('只列当前工作区、当前表面的会话', () => {
    const otherProject: Session = { ...learnSession, id: 'learn-other', workspaceRoot: 'D:/other' }
    const all = [parent, learnSession, otherProject, child]
    expect(listBreadcrumbSessions(all, 'D:/workspace', 'learn').map(s => s.id)).toEqual(['learn'])
    expect(listBreadcrumbSessions(all, 'D:/workspace', 'dev').map(s => s.id)).toEqual(['parent'])
  })
})

describe('listPinnedSessions', () => {
  it('只返回 pinned 的 primary 会话，保持传入顺序', () => {
    const pinnedA: Session = { ...parent, id: 'pinned-a', pinned: true }
    const pinnedB: Session = { ...parent, id: 'pinned-b', pinned: true }
    const pinnedChild: Session = { ...child, pinned: true }

    expect(
      listPinnedSessions([pinnedA, parent, pinnedChild, pinnedB]).map((session) => session.id)
    ).toEqual(['pinned-a', 'pinned-b'])
  })

  it('无置顶会话时返回空数组', () => {
    expect(listPinnedSessions([parent, child])).toEqual([])
  })
})
