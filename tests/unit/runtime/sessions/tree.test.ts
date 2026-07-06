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

  /** 参考实现：循环内 unshift（改前算法），用于顺序逐字节对照 */
  function computeActivePathUnshiftReference(
    messages: SessionMessage[],
    currentLeafId: string | null
  ): SessionMessage[] {
    if (!currentLeafId || messages.length === 0) return []
    const byId = new Map(messages.map(m => [m.id, m]))
    const path: SessionMessage[] = []
    const seen = new Set<string>()
    let id: string | null = currentLeafId
    while (id !== null) {
      if (seen.has(id)) break
      seen.add(id)
      const node = byId.get(id)
      if (!node) break
      path.unshift(node)
      id = node.parentId ?? null
    }
    return path
  }

  it('深度 1200 链：返回顺序与 unshift 参考实现逐 id 一致', () => {
    const depth = 1200
    const messages: SessionMessage[] = []
    for (let i = 0; i < depth; i++) {
      messages.push(msg(`n${i}`, i === 0 ? null : `n${i - 1}`, 'user', i))
    }
    const leaf = `n${depth - 1}`

    const optimized = computeActivePath(messages, leaf)
    const reference = computeActivePathUnshiftReference(messages, leaf)

    expect(optimized.map(m => m.id)).toEqual(reference.map(m => m.id))
    expect(optimized.map(m => m.id)).toEqual(messages.map(m => m.id))
  })

  it('深度 1200 链：push+reverse 耗时应明显低于 unshift 参考', () => {
    const depth = 1200
    const messages: SessionMessage[] = []
    for (let i = 0; i < depth; i++) {
      messages.push(msg(`n${i}`, i === 0 ? null : `n${i - 1}`, 'user', i))
    }
    const leaf = `n${depth - 1}`

    const t0 = performance.now()
    for (let i = 0; i < 50; i++) {
      computeActivePath(messages, leaf)
    }
    const optimizedMs = performance.now() - t0

    const t1 = performance.now()
    for (let i = 0; i < 50; i++) {
      computeActivePathUnshiftReference(messages, leaf)
    }
    const referenceMs = performance.now() - t1

    expect(optimizedMs).toBeLessThan(referenceMs)
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
