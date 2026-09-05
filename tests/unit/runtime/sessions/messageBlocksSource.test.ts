/**
 * 消息 block 单一事实源 + schema v8 迁移
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
  serializeMessageForDisk,
  MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE
} from '../../../../src/runtime/sessions/messageProjection'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'
import type { MessageBlock } from '../../../../src/shared/session'

describe('消息 block 单一事实源', () => {
  it('schema 升级到当前版本（含 v8 blocks 源）', () => {
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
    // v7→v8 引入 blocks 源；后续版本（如 v9 cacheRoutingKey）只升 schema，不改消息语义
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBeGreaterThanOrEqual(8)
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
    expect(normalized.messageSchemaVersion).toBe(1)
    expect(normalized.userDelivery).toBeUndefined()
    expect(normalized.blocks!.every(b => !('responseStep' in b))).toBe(true)
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

  it('blocks 源序列化保留回合起止时刻', () => {
    const persisted = serializeMessageForDisk({
      id: 'm_timing',
      parentId: null,
      role: 'assistant',
      content: 'answer',
      blocks: [{ type: 'text', content: 'answer' }],
      turnStartedAt: 10,
      turnEndedAt: 25,
      timestamp: 25
    })

    expect(persisted.turnStartedAt).toBe(10)
    expect(persisted.turnEndedAt).toBe(25)
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

  it('新事实版本往返只保存一份工具正文并保留 step、reasoning 与注入归属', () => {
    const original: SessionMessage = { id: 'a', parentId: 'u', role: 'assistant', content: '', timestamp: 1,
      messageSchemaVersion: MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE,
      userDelivery: { userMessageId: 'u', sessionPrefix: '当时目录', modeInstruction: '当时模式' },
      blocks: [{ type: 'thinking', content: '推理', providerId: 'deepseek', responseStep: 0 },
        { type: 'tool', toolCallId: 't', toolName: 'read', arguments: { path: 'a' }, status: 'success',
          result: '完整正文', artifactId: 'abc123', responseStep: 0 }] }
    const disk = serializeMessageForDisk(original)
    expect(disk.content).toBe('')
    expect(disk.toolCalls).toBeUndefined()
    const restored = normalizeMessageToBlocksSource(JSON.parse(JSON.stringify(disk)))
    expect(restored.blocks).toEqual(original.blocks)
    expect(restored.userDelivery).toEqual(original.userDelivery)
    expect(restored.toolCalls![0]).toMatchObject({ result: '完整正文', artifactId: 'abc123' })
  })

  it.each([99, -1])('未知消息版本 %s 拒绝读取而非降级成旧版', version => {
    expect(() => normalizeMessageToBlocksSource({ id: 'a', parentId: null, role: 'assistant',
      content: '', timestamp: 1, messageSchemaVersion: version })).toThrow('Unsupported message schema')
  })

  it.each([
    { userDelivery: { userMessageId: 'u', modeInstruction: 4, sessionPrefix: null } },
    { blocks: [{ type: 'text', content: 'x', responseStep: -1 }] },
    { blocks: [{ type: 'text', content: 'x', responseStep: 2 }, { type: 'text', content: 'y', responseStep: 1 }] },
    { blocks: [{ type: 'tool', toolCallId: 't', toolName: 'read', arguments: [], status: 'success' }] }
  ])('损坏的新事实元数据拒绝提交 %#', invalid => {
    const message = JSON.parse(JSON.stringify({ id: 'a', parentId: null, role: 'assistant',
      content: '', timestamp: 1, messageSchemaVersion: 2, ...invalid }))
    expect(() => serializeMessageForDisk(message)).toThrow(/Invalid/)
  })
})
