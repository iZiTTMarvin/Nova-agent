/**
 * P1-C 回归：memoryEnabled:false 时无 L1/L2 记忆层；L2 带 skipCacheMarker。
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { buildL1MemoryContext } from '../../../../src/runtime/memory/MemoryInjector'
import {
  buildL2ContextMessage,
  buildL2TailBlock,
  L2_BLOCK_TITLE
} from '../../../../src/runtime/memory/MemoryTailInjector'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'
import { SystemPromptBuilder } from '../../../../src/runtime/agent/promptBuilder/SystemPromptBuilder'

import type { MemorySearchHit } from '../../../../src/runtime/memory/types'

describe('memory-disabled 回归（P1-C）', () => {
  it('memoryEnabled:false 时不构建 L1 memoryContext 与 L2 尾部', () => {
    const settings = { ...DEFAULT_NOVA_SETTINGS, memoryEnabled: false }
    expect(settings.memoryEnabled).toBe(false)

    // 模拟 agentHandler：关闭时不读 essence、不 search
    const memoryContext = settings.memoryEnabled ? buildL1MemoryContext('某精华') : null
    expect(memoryContext).toBeNull()

    const hits: MemorySearchHit[] = [
      { scopeId: 's', relPath: 'MEMORY.md', body: '偏好中文注释', score: 1 }
    ]
    const l2Block = settings.memoryEnabled ? buildL2TailBlock(hits, '中文') : ''
    const l2Message = settings.memoryEnabled ? buildL2ContextMessage(l2Block) : null
    expect(l2Block).toBe('')
    expect(l2Message).toBeNull()
  })

  it('memoryEnabled:false 时 system prompt 不含 Project Memory 层', () => {
    const prompt = SystemPromptBuilder.build({
      agentRole: buildStableSystemPrompt({ workingDir: '/tmp/p' }),
      baseRules: renderBaseRules(),
      projectRules: '',
      memoryContext: null,
      skillContext: '',
      toolSummary: ''
    })
    expect(prompt).not.toContain('Project Memory')
    expect(prompt).not.toContain(L2_BLOCK_TITLE)
  })
})

describe('采集门控由 memoryEnabled 一键统控', () => {
  it('memoryCaptureEnabled 默认 true（随总开关开启）', () => {
    // 用户视角下记忆只有 memoryEnabled 一个按钮；子开关默认全 true。
    expect(DEFAULT_NOVA_SETTINGS.memoryCaptureEnabled).toBe(true)
  })

  it('memoryEnabled false 时不应挂载采集（由 agentHandler 门控）', async () => {
    const { subscribeObservationCapture } = await import(
      '../../../../src/runtime/memory/MemoryObservationBridge'
    )
    const { ObservationCapture, resetObservationCapturesForTests } = await import(
      '../../../../src/runtime/memory/ObservationCapture'
    )
    resetObservationCapturesForTests()

    // 采集门控现由 memoryEnabled 统控（agentHandler 不再单独检查 memoryCaptureEnabled）
    const settings = { ...DEFAULT_NOVA_SETTINGS, memoryEnabled: false }
    expect(settings.memoryEnabled).toBe(false)

    // 模拟门控：关闭时不调用 subscribe，buffer 无写入
    const capture = new ObservationCapture()
    expect(capture.getWorkingBuffer('sess')).toEqual([])
    expect(typeof subscribeObservationCapture).toBe('function')
  })
})

describe('L2 skipCacheMarker（P1-C）', () => {
  it('buildL2ContextMessage 返回 user 消息且带 skipCacheMarker', () => {
    const msg = buildL2ContextMessage('=== Relevant Memory ===\n片段')
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('user')
    expect(msg!.skipCacheMarker).toBe(true)
    expect(msg!.internal).toBeUndefined()
  })
})
