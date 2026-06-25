import { describe, it, expect } from 'vitest'
import { migrateSessionData, CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'
import type { SessionData } from '../../../../src/runtime/sessions/types'

describe('migrateSessionData', () => {
  it('v1 会话自动升级到当前版本，原有字段不丢失', () => {
    const v1: SessionData = {
      schemaVersion: 1,
      id: 'sess_test',
      workspaceRoot: '/tmp/project',
      mode: 'default',
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1,
          toolCalls: [
            {
              id: 'tc_1',
              name: 'bash',
              arguments: '{"command":"echo hi"}',
              result: 'hi'
            }
          ]
        }
      ],
      createdAt: 100,
      updatedAt: 200,
      frozenSystemPrompt: 'frozen',
      todos: []
    }

    const migrated = migrateSessionData(v1)
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(migrated.id).toBe('sess_test')
    expect(migrated.messages[0].toolCalls?.[0].result).toBe('hi')
    expect(migrated.frozenSystemPrompt).toBe('frozen')
  })

  it('无 schemaVersion 的旧数据经迁移链升级到当前版本', () => {
    const legacy = {
      id: 'legacy',
      workspaceRoot: '/ws',
      mode: 'plan',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    }

    const migrated = migrateSessionData(legacy)
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(migrated.mode).toBe('plan')
  })

  it('无 artifactId 字段时不报错', () => {
    const v1 = {
      schemaVersion: 1,
      id: 'x',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [{ id: 'm', role: 'tool', content: 'out', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 2
    }

    expect(() => migrateSessionData(v1)).not.toThrow()
    expect(migrateSessionData(v1).schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
  })
})
