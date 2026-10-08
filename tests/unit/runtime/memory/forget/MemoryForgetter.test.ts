import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryEntryStore } from '../../../../../src/runtime/memory/markdown/MemoryEntryStore'
import { MemoryForgetter, type MemoryForgetCopy } from '../../../../../src/runtime/memory/forget/MemoryForgetter'
import type { MemoryScope } from '../../../../../src/runtime/memory/types'

const scope: MemoryScope = { scopeKind: 'global', scopeId: 'user' }

const draft = (id: string, content: string) => ({
  id, scope, kind: 'preference' as const, memoryKey: null, content,
  status: 'active' as const, confidence: 1, explicitness: 'user_explicit' as const, sourceType: 'user_message' as const
})

describe('MemoryForgetter', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('副本清理失败时不删事实源，修复后重试成功', () => {
    root = mkdtempSync(join(tmpdir(), 'nova-forgetter-'))
    const store = new MemoryEntryStore(root)
    const record = store.insert(draft('m_0000000001', 'FORGET-SECRET 副本验证'))
    const failing: MemoryForgetCopy = { label: '会话记忆快照', redact: () => { throw new Error('session store gone') } }
    const forgetter = new MemoryForgetter({ store, copies: [failing], index: null })
    expect(() => forgetter.forget(scope, record.id)).toThrow('遗忘未完成：会话记忆快照清理失败')
    expect(store.find(record.id, scope)?.record.content).toBe('FORGET-SECRET 副本验证')
    const redacted: string[] = []
    const ok: MemoryForgetCopy = { label: '会话记忆快照', redact: forgotten => { redacted.push(...forgotten.ids) } }
    const retry = new MemoryForgetter({ store, copies: [ok], index: null })
    expect(retry.forget(scope, record.id)).toBe(true)
    expect(redacted).toEqual([record.id])
    expect(store.find(record.id, scope)).toBeNull()
    expect(retry.forget(scope, record.id)).toBe(false)
  })

  it('遗忘目标连同被它取代的旧版本一起清除', () => {
    root = mkdtempSync(join(tmpdir(), 'nova-forgetter-'))
    const store = new MemoryEntryStore(root)
    const older = store.insert(draft('m_0000000009', 'FORGET-SECRET 旧版本'))
    const newer = store.supersede(scope, older.id, draft('m_0000000010', 'FORGET-SECRET 新版本'))
    const collected = store.collectForgetTargets(scope, newer.id)
    expect(collected?.ids.slice().sort()).toEqual([older.id, newer.id].sort())
    expect(collected?.contents.slice().sort()).toEqual(['FORGET-SECRET 旧版本', 'FORGET-SECRET 新版本'].sort())
    const forgetter = new MemoryForgetter({ store, copies: [], index: null })
    expect(forgetter.forget(scope, newer.id)).toBe(true)
    expect(store.find(older.id)).toBeNull()
    expect(store.find(newer.id)).toBeNull()
  })

  it('只读存储拒绝遗忘且不触碰任何条目', () => {
    root = mkdtempSync(join(tmpdir(), 'nova-forgetter-'))
    const store = new MemoryEntryStore(root)
    const record = store.insert(draft('m_0000000001', 'FORGET-SECRET 只读'))
    store.setReadOnly(true)
    const forgetter = new MemoryForgetter({ store, copies: [], index: null })
    expect(() => forgetter.forget(scope, record.id)).toThrow('read-only')
    expect(store.find(record.id, scope)).not.toBeNull()
  })
})
