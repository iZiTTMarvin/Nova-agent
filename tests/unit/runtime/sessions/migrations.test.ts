import { describe, it, expect } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateSessionData,
  migrateSessionFile,
  migrateV3ToV4,
  CURRENT_SESSION_SCHEMA_VERSION
} from '../../../../src/runtime/sessions/migrations'
import { SESSION_DATA_FILE } from '../../../../src/runtime/sessions/types'
import { SESSION_MIGRATED_EMPTY_TITLE } from '../../../../src/shared/session/title'

describe('migrateSessionData', () => {
  it('v1 会话自动升级到当前版本，原有字段不丢失', () => {
    const v1 = {
      schemaVersion: 1,
      id: 'sess_test',
      workspaceRoot: '/tmp/project',
      mode: 'default',
      messages: [
        {
          id: 'msg_1',
          parentId: null,
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
      currentLeafId: 'msg_1',
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
    expect(migrated.messages[0].parentId).toBe(null)
    expect(migrated.currentLeafId).toBe('msg_1')
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

  it('v3 线性会话经 migrateV3ToV4 串成 parentId 链', () => {
    const v3 = {
      schemaVersion: 3,
      id: 'sess_v3',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [
        { id: 'm1', parentId: null, role: 'user', content: 'hi', timestamp: 1 },
        { id: 'm2', parentId: null, role: 'assistant', content: 'yo', timestamp: 2 }
      ],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2
    }

    const v4 = migrateV3ToV4(v3)
    expect(v4.schemaVersion).toBe(4)
    expect(v4.messages[0].parentId).toBe(null)
    expect(v4.messages[1].parentId).toBe('m1')
    expect(v4.currentLeafId).toBe('m2')
  })

  it('v4 会话经完整迁移链补全标题字段', () => {
    const v4 = {
      schemaVersion: 4,
      id: 'sess_v4',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [
        { id: 'm1', parentId: null, role: 'user', content: '帮我写一个登录页面', timestamp: 1 }
      ],
      currentLeafId: 'm1',
      createdAt: 1,
      updatedAt: 2
    }

    const migrated = migrateSessionData(v4)
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(migrated.title).toBe('帮我写一个登录页面')
    expect(migrated.titleSource).toBe('generated')
  })

  it('v4 无用户消息的会话迁移后写入占位标题', () => {
    const v4 = {
      schemaVersion: 4,
      id: 'sess_empty',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2
    }

    const migrated = migrateSessionData(v4)
    expect(migrated.title).toBe(SESSION_MIGRATED_EMPTY_TITLE)
    expect(migrated.titleSource).toBe('placeholder')
  })

  it('v8 会话升级到当前版本，不强制生成 cacheRoutingKey', () => {
    const v8 = {
      schemaVersion: 8,
      id: 'sess_v8',
      workspaceRoot: '/ws',
      mode: 'default' as const,
      messages: [],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2
    }
    const migrated = migrateSessionData(v8)
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(migrated.cacheRoutingKey).toBeUndefined()
  })

  it('v9 fixture 迁移为 v10 primary，且不伪造 child metadata', () => {
    const fixturePath = join(__dirname, '../../../fixtures/sessions/v9-primary-session.json')
    const v9 = JSON.parse(readFileSync(fixturePath, 'utf-8')) as unknown

    const migrated = migrateSessionData(v9)

    expect(migrated).toMatchObject({
      schemaVersion: 10,
      kind: 'primary',
      id: 'sess_v9_primary',
      messages: []
    })
    expect('subagent' in migrated).toBe(false)
  })

  it('v9 物理 session 文件迁移后写回 v10，并保留迁移前备份', () => {
    const fixturePath = join(__dirname, '../../../fixtures/sessions/v9-primary-session.json')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-session-v10-'))
    const sessionId = 'sess_v9_primary'
    const sessionDir = join(sessionsDir, sessionId)
    mkdirSync(sessionDir)
    writeFileSync(join(sessionDir, SESSION_DATA_FILE), readFileSync(fixturePath, 'utf-8'), 'utf-8')

    try {
      const migrated = migrateSessionFile(sessionsDir, sessionId)
      expect(migrated).toMatchObject({ schemaVersion: 10, kind: 'primary', messages: [] })

      const persisted = JSON.parse(
        readFileSync(join(sessionDir, SESSION_DATA_FILE), 'utf-8')
      ) as Record<string, unknown>
      expect(persisted.schemaVersion).toBe(10)
      expect(persisted.kind).toBe('primary')
      expect('messages' in persisted).toBe(false)
      expect(
        readdirSync(sessionDir).filter((name) => name.startsWith(`${SESSION_DATA_FILE}.backup.`))
      ).toHaveLength(1)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('合法 v10 subagent 只接受完整、可判别的 metadata', () => {
    const metadata = {
      lineage: {
        parentSessionId: 'sess_parent',
        parentRunId: 'run_parent',
        rootRunId: 'run_root',
        depth: 1,
        spawnKey: 'spawn_key',
        spawnRunId: 'run_child',
        origin: {
          kind: 'task_tool' as const,
          parentMessageId: 'msg_parent',
          parentToolCallId: 'tc_parent'
        }
      },
      profile: {
        profileId: 'explore',
        name: 'Explore',
        description: 'Read-only review',
        systemPrompt: 'Read only.',
        toolNames: ['read', 'grep'],
        permissionCeiling: 'read_only' as const,
        maxToolRounds: 20,
        configHash: 'cfg_hash'
      }
    }
    const input = {
      schemaVersion: 10,
      kind: 'subagent' as const,
      id: 'sess_child',
      workspaceRoot: '/ws',
      mode: 'default' as const,
      messages: [],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2,
      subagent: metadata
    }

    expect(migrateSessionData(input)).toEqual(input)
  })

  it('损坏的 v10 discriminant 输入 fail closed，不静默伪造 lineage', () => {
    const base = {
      schemaVersion: 10,
      id: 'sess_bad',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2
    }

    expect(() => migrateSessionData({ ...base, kind: 'primary', subagent: {} }))
      .toThrow('primary 会话不得携带 subagent metadata')
    expect(() => migrateSessionData({ ...base, kind: 'subagent' }))
      .toThrow('subagent 会话必须携带合法的 subagent metadata')
    expect(() => migrateSessionData({
      ...base,
      kind: 'subagent',
      subagent: {
        lineage: { depth: 'not-a-number' },
        profile: {}
      }
    })).toThrow('subagent 会话必须携带合法的 subagent metadata')
  })

  it('未来 schemaVersion fail closed，绝不被降级为当前 v10', () => {
    expect(() => migrateSessionData({ schemaVersion: 11 })).toThrow(
      '会话 schemaVersion 11 高于当前支持的 10，拒绝降级读取'
    )
  })
})
