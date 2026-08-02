import { describe, expect, it } from 'vitest'
import {
  buildSessionForest,
  flattenSessionForest
} from '../../../src/renderer/features/subagents/sessionTree'
import type { Session } from '../../../src/shared/session/types'

const parent: Session = {
  id: 'parent',
  kind: 'primary',
  workspaceRoot: 'D:/workspace',
  mode: 'default',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0
}

function child(id: string, createdAt: number): Session {
  return {
    id,
    kind: 'subagent',
    workspaceRoot: 'D:/workspace',
    mode: 'plan',
    createdAt,
    updatedAt: createdAt,
    messageCount: 1,
    subagent: {
      lineage: {
        parentSessionId: 'parent',
        depth: 1
      },
      profile: { profileId: 'explore', name: 'Explore', permissionCeiling: 'read_only' }
    }
  }
}

describe('subagent session tree', () => {
  it('按 createdAt 稳定排列 child 并保持递归深度', () => {
    const flat = flattenSessionForest(buildSessionForest([child('later', 3), parent, child('first', 2)]))
    expect(flat.map((entry) => [entry.session.id, entry.depth])).toEqual([
      ['parent', 0],
      ['first', 1],
      ['later', 1]
    ])
  })

  it('将损坏的循环 lineage 退化为可见根节点', () => {
    const first = child('first', 2)
    const second = child('second', 3)
    first.subagent.lineage.parentSessionId = second.id
    second.subagent.lineage.parentSessionId = first.id

    const flat = flattenSessionForest(buildSessionForest([first, second]))
    expect(flat.map((entry) => entry.session.id).sort()).toEqual(['first', 'second'])
  })
})
