import { describe, it, expect } from 'vitest'
import {
  computeActivePath,
  buildChildrenIndex,
  getBranchPosition,
  findCommonAncestor,
  resolveCurrentLeafId,
  getSessionActiveMessages,
  ensureMessageParentChain,
  attachBranchMeta,
  findSubtreeLeaf
} from '../../../../src/runtime/sessions/tree'
import type { SessionMessage, SessionData } from '../../../../src/runtime/sessions/types'

function msg(
  id: string,
  parentId: string | null,
  role: SessionMessage['role'] = 'user',
  timestamp = 0
): SessionMessage {
  return { id, parentId, role, content: id, timestamp }
}

describe('computeActivePath', () => {
  it('空树返回空数组', () => {
    expect(computeActivePath([], null)).toEqual([])
    expect(computeActivePath([msg('a', null)], null)).toEqual([])
  })

  it('单链从 leaf 回溯到根', () => {
    const messages = [
      msg('u1', null, 'user', 1),
      msg('a1', 'u1', 'assistant', 2)
    ]
    expect(computeActivePath(messages, 'a1').map(m => m.id)).toEqual(['u1', 'a1'])
  })

  it('森林模型：编辑首条用户消息后只走新分支', () => {
    const messages = [
      msg('u1', null, 'user', 1),
      msg('a1', 'u1', 'assistant', 2),
      msg('u2', null, 'user', 3),
      msg('a2', 'u2', 'assistant', 4)
    ]
    expect(computeActivePath(messages, 'a2').map(m => m.id)).toEqual(['u2', 'a2'])
    expect(computeActivePath(messages, 'a1').map(m => m.id)).toEqual(['u1', 'a1'])
  })

  it('孤儿节点：parentId 不存在时停止回溯', () => {
    const messages = [msg('orphan', 'missing', 'user', 1)]
    expect(computeActivePath(messages, 'orphan').map(m => m.id)).toEqual(['orphan'])
  })
})

describe('buildChildrenIndex / getBranchPosition', () => {
  it('兄弟按 timestamp 升序', () => {
    const messages = [
      msg('u1', null, 'user', 1),
      msg('a2', 'u1', 'assistant', 3),
      msg('a1', 'u1', 'assistant', 2)
    ]
    const siblings = buildChildrenIndex(messages).get('u1')!
    expect(siblings.map(m => m.id)).toEqual(['a1', 'a2'])
    expect(getBranchPosition(messages, 'a2')).toEqual({ index: 2, total: 2 })
  })
})

describe('findCommonAncestor', () => {
  it('两叶子共享用户祖先', () => {
    const messages = [
      msg('u1', null, 'user', 1),
      msg('a1', 'u1', 'assistant', 2),
      msg('a2', 'u1', 'assistant', 3)
    ]
    expect(findCommonAncestor(messages, 'a1', 'a2')).toBe('u1')
  })
})

describe('resolveCurrentLeafId / getSessionActiveMessages', () => {
  it('无效 leaf 回退到末条', () => {
    const messages = [msg('u1', null, 'user', 1), msg('a1', 'u1', 'assistant', 2)]
    expect(resolveCurrentLeafId(messages, 'gone')).toBe('a1')
  })

  it('显式 null 表示激活路径为空（编辑首条消息后倒回起点）', () => {
    const messages = [msg('u1', null, 'user', 1), msg('a1', 'u1', 'assistant', 2)]
    expect(resolveCurrentLeafId(messages, null)).toBe(null)
    expect(getSessionActiveMessages({
      schemaVersion: 4,
      id: 's',
      workspaceRoot: '/ws',
      mode: 'default',
      messages,
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2
    })).toHaveLength(0)
  })

  it('从 SessionData 派生 active path', () => {
    const session: SessionData = {
      schemaVersion: 4,
      id: 's1',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [
        msg('u1', null, 'user', 1),
        msg('a1', 'u1', 'assistant', 2)
      ],
      currentLeafId: 'a1',
      createdAt: 1,
      updatedAt: 2
    }
    expect(getSessionActiveMessages(session).map(m => m.id)).toEqual(['u1', 'a1'])
  })
})

describe('ensureMessageParentChain', () => {
  it('缺 parentId 时按数组顺序串链', () => {
    const raw = [
      { id: 'm1', role: 'user' as const, content: 'a', timestamp: 1 },
      { id: 'm2', role: 'assistant' as const, content: 'b', timestamp: 2 }
    ]
    const chained = ensureMessageParentChain(raw as SessionMessage[])
    expect(chained[0].parentId).toBe(null)
    expect(chained[1].parentId).toBe('m1')
  })
})

describe('findSubtreeLeaf', () => {
  it('沿最右子链找到子树叶子', () => {
    const messages = [
      msg('u1', null, 'user', 1),
      msg('a1', 'u1', 'assistant', 2),
      msg('u2', null, 'user', 3),
      msg('a2', 'u2', 'assistant', 4)
    ]
    expect(findSubtreeLeaf(messages, 'u1')).toBe('a1')
    expect(findSubtreeLeaf(messages, 'u2')).toBe('a2')
  })
})

describe('attachBranchMeta', () => {
  it('无兄弟时不附加 branch', () => {
    const messages = [msg('u1', null), msg('a1', 'u1', 'assistant')]
    const path = computeActivePath(messages, 'a1')
    const withMeta = attachBranchMeta(path, messages)
    expect(withMeta[1].branch).toBeUndefined()
  })

  it('有兄弟时附加 branch 元信息', () => {
    const messages = [
      msg('u1', null, 'user', 1),
      msg('a1', 'u1', 'assistant', 2),
      msg('a2', 'u1', 'assistant', 3)
    ]
    const path = computeActivePath(messages, 'a2')
    const withMeta = attachBranchMeta(path, messages)
    expect(withMeta[1].branch).toEqual({
      index: 2,
      total: 2,
      siblingIds: ['a1', 'a2']
    })
  })
})
