import { describe, expect, it } from 'vitest'
import { assertSessionModeMutable, parseStrictMode } from '../../../../src/shared/session/mode'
import { migrateSessionData, CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'

describe('session mode strict parsing', () => {
  it('当前 schema 合法 learn 保持 learn', () => {
    const migrated = migrateSessionData({
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      kind: 'primary',
      id: 'sess',
      workspaceRoot: '/ws',
      mode: 'learn',
      permissionMode: 'auto',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    expect(migrated.mode).toBe('learn')
  })

  it('当前 schema 未知 mode 拒绝', () => {
    expect(() =>
      migrateSessionData({
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        kind: 'primary',
        id: 'sess',
        workspaceRoot: '/ws',
        mode: 'bogus',
        permissionMode: 'auto',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      })
    ).toThrow()
  })

  it('未来 schema 拒绝降级', () => {
    expect(() =>
      migrateSessionData({
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1,
        kind: 'primary',
        mode: 'learn'
      })
    ).toThrow(/拒绝降级读取/)
  })

  it('parseStrictMode 拒绝 learn 回落路径', () => {
    expect(parseStrictMode('learn')).toBe('learn')
    expect(() => parseStrictMode('auto')).toThrow()
  })

  it('learn 与开发 mode 不可互转', () => {
    expect(() => assertSessionModeMutable('learn', 'default')).toThrow()
    expect(() => assertSessionModeMutable('default', 'learn')).toThrow()
    assertSessionModeMutable('default', 'plan')
  })
})
