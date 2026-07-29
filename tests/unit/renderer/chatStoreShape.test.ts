import { beforeEach, describe, expect, it } from 'vitest'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'

const CHAT_STATE_KEYS = [
  'sessions', 'currentSessionId', 'messages', 'messageIndexById', 'lastMessagesRevision',
  'pendingBranchMetaReload', 'branchForkInProgress', 'tier1BranchContext', 'isGenerating',
  'currentGeneratingMessageId', 'activeAgentSessionId', 'sendInFlight', 'streamingToolArgs',
  'messageDiffs', 'loadingDiffs', 'loadingDiffPlaceholders', 'pendingUserMessages',
  'recoveryState', 'recoveryHints', 'hookErrors', 'rollbackErrors', 'hasMoreMessagesAbove',
  'isLoadingOlderMessages', 'oldestLoadedMessageId', 'suspendHeadTrim',
  'loadSessions', 'selectSession', 'deleteSession', 'renameSession', 'createNewSession',
  'sendMessage', 'regenerateAssistant', 'switchBranch', 'editResend', 'acceptFile',
  'rejectFile', 'acceptAllFiles', 'rejectAllFiles', 'loadMessageDiffs', 'clearMessageDiffs',
  'loadOlderMessages', 'finishBranchMetaRefresh', 'dismissTier1BranchNotice', 'applyStreamDeltas',
  'handleMessageStart', 'handleAttemptFailed', 'handleThinkingDelta', 'handleTextDelta',
  'handleToolCallStart', 'handleToolCallDelta', 'handleToolCall', 'handleToolResult',
  'handleDiffUpdate', 'handleMessageEnd', 'handleError', 'handleRecoveryState',
  'handleRecoveryHint', 'handleHookError', 'markRunningAsCancelled', 'enqueuePendingMessage',
  'removePendingMessage', 'clearPendingMessages', 'syncFromWorkspace'
] as const

describe('chat store shape baseline', () => {
  beforeEach(() => {
    resetChatStoreForTests()
  })

  it('ChatState 对外 key 集合保持固定', () => {
    const actual = Object.keys(useChatStore.getState()).sort()
    const expected = [...CHAT_STATE_KEYS].sort()
    expect(actual).toEqual(expected)
    expect(actual).toHaveLength(63)
  })

  it('resetChatStoreForTests 恢复全部状态字段默认值', () => {
    useChatStore.setState({
      sessions: [{ id: 's1', workspaceRoot: 'w', mode: 'default', createdAt: 1, updatedAt: 1, messageCount: 1 }],
      currentSessionId: 's1',
      messages: [{ id: 'm1', sessionId: 's1', role: 'assistant', content: 'x', timestamp: 1, _revision: 0 }],
      messageIndexById: { m1: 0 },
      lastMessagesRevision: 99,
      pendingBranchMetaReload: true,
      branchForkInProgress: true,
      tier1BranchContext: { branchMessageId: 'm1', branchType: 'tier1', siblingCount: 2, selectedSiblingIndex: 1 },
      isGenerating: true,
      currentGeneratingMessageId: 'm1',
      activeAgentSessionId: 's1',
      sendInFlight: true,
      streamingToolArgs: { tc1: '{}' },
      messageDiffs: { m1: { diffs: [], reviews: {} } },
      loadingDiffs: new Set(['m1']),
      loadingDiffPlaceholders: { m1: [{ filePath: 'a.ts', status: 'modified' }] },
      pendingUserMessages: [{ text: 'q', images: [] }],
      recoveryState: { m1: 'recovering' },
      recoveryHints: { m1: [{ hint: 'h', attempt: 1 }] },
      hookErrors: { m1: [{ hookEvent: 'tool_before' as const, error: 'err' }] },
      rollbackErrors: { m1: 'err' },
      hasMoreMessagesAbove: true,
      isLoadingOlderMessages: true,
      oldestLoadedMessageId: 'm1',
      suspendHeadTrim: true
    })

    const firstSet = useChatStore.getState().loadingDiffs
    resetChatStoreForTests()
    const state = useChatStore.getState()

    expect(state.sessions).toEqual([])
    expect(state.currentSessionId).toBeNull()
    expect(state.messages).toEqual([])
    expect(state.messageIndexById).toEqual({})
    expect(state.lastMessagesRevision).toBe(0)
    expect(state.pendingBranchMetaReload).toBe(false)
    expect(state.branchForkInProgress).toBe(false)
    expect(state.tier1BranchContext).toBeNull()
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.streamingToolArgs).toEqual({})
    expect(state.messageDiffs).toEqual({})
    expect(state.loadingDiffs.size).toBe(0)
    expect(state.loadingDiffPlaceholders).toEqual({})
    expect(state.pendingUserMessages).toEqual([])
    expect(state.recoveryState).toEqual({})
    expect(state.recoveryHints).toEqual({})
    expect(state.hookErrors).toEqual({})
    expect(state.rollbackErrors).toEqual({})
    expect(state.hasMoreMessagesAbove).toBe(false)
    expect(state.isLoadingOlderMessages).toBe(false)
    expect(state.oldestLoadedMessageId).toBeNull()
    expect(state.suspendHeadTrim).toBe(false)
    expect(state.loadingDiffs).not.toBe(firstSet)
  })
})
