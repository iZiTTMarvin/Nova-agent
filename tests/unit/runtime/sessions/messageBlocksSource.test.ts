/**
 * T5-4 消息 block 单一事实源 + schema v8 迁移
 */
import { describe, it, expect } from 'vitest'
import {
  migrateSessionData,
  CURRENT_SESSION_SCHEMA_VERSION
} from '../../../../src/runtime/sessions/migrations'
import {
  normalizeMessageToBlocksSource,
  projectContentFromBlocks,
  projectToolCallsFromBlocks,
  projectAssistantFieldsFromBlocks,
  buildBlocksFromLegacyFields,
  MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE
} from '../../../../src/runtime/sessions/messageProjection'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'
import type { MessageBlock } from '../../../../src/shared/session'

describe('T5-4 消息 block 单一事实源', () => {
  it('schema 升级到 v8', () => {
    const v7 = {
      schemaVersion: 7,
      id: 'sess',
      workspaceRoot: '/ws',
      mode: 'default',
      messages: [],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 2
    }
    const migrated = migrateSessionData(v7)
    expect(migrated.schemaVersion).toBe(8)
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(8)
  })

  it('有 blocks 时 content/toolCalls 由投影派生', () => {
    const blocks: MessageBlock[] = [
      { type: 'text', content: 'hello ' },
      { type: 'text', content: 'world' },
      {
        type: 'tool',
        toolCallId: 'tc1',
        toolName: 'bash',
        arguments: { command: 'ls' },
        status: 'success',
        result: 'ok'
      }
    ]
    expect(projectContentFromBlocks(blocks)).toBe('hello world')
    const tcs = projectToolCallsFromBlocks(blocks)
    expect(tcs).toHaveLength(1)
    expect(tcs![0].name).toBe('bash')
    expect(tcs![0].result).toBe('ok')
  })

  it('旧消息无 blocks 时按需构造，不强制写盘语义', () => {
    const legacy: SessionMessage = {
      id: 'm1',
      parentId: null,
      role: 'assistant',
      content: 'hi',
      toolCalls: [{ id: 'tc', name: 'read', arguments: '{"path":"a"}', result: 'x' }],
      timestamp: 1
    }
    const normalized = normalizeMessageToBlocksSource(legacy)
    expect(normalized.blocks).toBeDefined()
    expect(normalized.blocks!.length).toBeGreaterThanOrEqual(2)
    expect(normalized.messageSchemaVersion).toBe(MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE)
    expect(normalized.content).toBe('hi')
  })

  it('projectAssistantFieldsFromBlocks 只从 blocks 投影', () => {
    const blocks: MessageBlock[] = [
      { type: 'thinking', content: '...' },
      { type: 'text', content: 'answer' },
      {
        type: 'tool',
        toolCallId: 't1',
        toolName: 'edit',
        arguments: {},
        status: 'success',
        result: 'done'
      }
    ]
    const projected = projectAssistantFieldsFromBlocks(blocks)
    expect(projected.content).toBe('answer')
    expect(projected.toolCalls).toHaveLength(1)
    expect(projected.blocks).toBe(blocks)
  })

  it('buildBlocksFromLegacyFields 保留 tool 状态', () => {
    const blocks = buildBlocksFromLegacyFields({
      role: 'assistant',
      content: 'x',
      toolCalls: [
        { id: '1', name: 'bash', arguments: '{}', result: '工具执行失败: boom' }
      ]
    })
    const tool = blocks.find(b => b.type === 'tool')
    expect(tool?.status).toBe('error')
  })
})
