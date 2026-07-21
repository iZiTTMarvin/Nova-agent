/**
 * T1-4：会话 cacheRoutingKey 懒生成 / 持久化 / ChatOptions 透传
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { migrateSessionData, CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import type { ChatOptions } from '../../../../src/runtime/model/ModelClient'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import type { ModelConfig } from '../../../../src/shared/config'
import { computeWireSnapshot } from '../../../../src/runtime/model/requestFingerprint'

let tmpDir: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cache-routing-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('cacheRoutingKey 会话路由 key', () => {
  it('懒生成后持久化；新 SessionStore 重启后同 session key 不变', () => {
    const store1 = new SessionStore(tmpDir)
    const session = store1.create('/ws/a')
    expect(session.cacheRoutingKey).toBeUndefined()

    const key1 = store1.ensureCacheRoutingKey(session.id)
    expect(key1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )

    // 模拟应用重启：新 SessionStore 实例读同一目录
    const store2 = new SessionStore(tmpDir)
    const key2 = store2.ensureCacheRoutingKey(session.id)
    expect(key2).toBe(key1)

    const reloaded = store2.load(session.id)
    expect(reloaded?.cacheRoutingKey).toBe(key1)
  })

  it('不同 session 的 key 绝不共享', () => {
    const store = new SessionStore(tmpDir)
    const a = store.create('/ws/a')
    const b = store.create('/ws/b')
    const keyA = store.ensureCacheRoutingKey(a.id)
    const keyB = store.ensureCacheRoutingKey(b.id)
    expect(keyA).toBeTruthy()
    expect(keyB).toBeTruthy()
    expect(keyA).not.toBe(keyB)
  })

  it('旧会话迁移后无 key，首次 ensure 懒生成且不改消息历史', () => {
    const legacy = {
      schemaVersion: 8,
      id: 'sess_legacy',
      workspaceRoot: '/ws',
      mode: 'default' as const,
      messages: [
        {
          id: 'm1',
          parentId: null,
          role: 'user' as const,
          content: 'hello',
          timestamp: 1
        }
      ],
      currentLeafId: 'm1',
      createdAt: 1,
      updatedAt: 2
    }

    const migrated = migrateSessionData(legacy)
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(migrated.cacheRoutingKey).toBeUndefined()
    expect(migrated.messages).toHaveLength(1)
    expect(migrated.messages[0].content).toBe('hello')
    expect(migrated.id).toBe('sess_legacy')

    // 写入磁盘后懒生成
    const store = new SessionStore(tmpDir)
    store.save(migrated)
    const key = store.ensureCacheRoutingKey('sess_legacy')
    expect(key).toBeTruthy()
    const loaded = store.load('sess_legacy')
    expect(loaded?.cacheRoutingKey).toBe(key)
    expect(loaded?.messages).toHaveLength(1)
    expect(loaded?.messages[0].id).toBe('m1')
  })

  it('同一会话重复 ensure 返回同一 key', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const k1 = store.ensureCacheRoutingKey(session.id)
    const k2 = store.ensureCacheRoutingKey(session.id)
    expect(k1).toBe(k2)
  })
})

describe('ChatOptions.promptCacheKey 透传', () => {
  it('AgentLoop 将 config.promptCacheKey 注入 modelPool.chat options', async () => {
    const captured: ChatOptions[] = []

    const capturingClient: ModelClient = {
      async *chat(
        _messages: ChatMessage[],
        _tools?: ToolDefinition[],
        options?: ChatOptions
      ): AsyncIterable<ChatEvent> {
        captured.push(options ?? {})
        yield { type: 'message_start' }
        yield { type: 'text_delta', delta: 'ok' }
        yield {
          type: 'usage',
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            cachedTokens: 0,
            cacheWriteTokens: 0
          }
        }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig(_config: ModelConfig): void {
        /* no-op */
      }
    }

    const pool = new ModelClientPool({
      primary: capturingClient,
      primaryConfig: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test',
        modelId: 'test-model'
      }
    })
    const eventBus = new EventBus()
    const loop = new AgentLoop(pool, eventBus, {
      promptCacheKey: 'route-key-abc'
    })

    await loop.sendMessage('hi')
    loop.dispose()

    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured.every(o => o.promptCacheKey === 'route-key-abc')).toBe(true)
  })
})

describe('computeWireSnapshot', () => {
  it('相同结构快照稳定；不含明文', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'system', content: 'SECRET_PROMPT_正文' },
        { role: 'user', content: 'hello' }
      ],
      tools: [{ type: 'function', function: { name: 'ls', parameters: {} } }]
    }
    const a = computeWireSnapshot(body, 'generic')
    const b = computeWireSnapshot(body, 'generic')
    expect(a.exactBodyHash).toBe(b.exactBodyHash)
    expect(a.exactBodyHash).toMatch(/^[a-f0-9]{16}$/)
    expect(a.exactBodyHash).not.toContain('SECRET')
    expect(a.exactBodyHash).not.toContain('hello')
    expect(a.messages).toHaveLength(2)
    expect(a.toolsHash).toMatch(/^[a-f0-9]{16}$/)
  })
})
