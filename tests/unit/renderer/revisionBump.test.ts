import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'

const mockInvoke = vi.fn()
const mockOn = vi.fn()

global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: vi.fn()
  }
} as unknown as Window & typeof globalThis

describe('_revision bump', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
  })

  it('handleMessageStart 创建的消息 _revision 应为 0', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const msg = useChatStore.getState().messages[0]
    expect(msg._revision).toBe(0)
  })

  it('applyStreamDeltas 后 _revision 应单调递增', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    expect(useChatStore.getState().messages[0]._revision).toBe(0)

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_1', delta: 'hello' }
    ])
    expect(useChatStore.getState().messages[0]._revision).toBe(1)

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_1', delta: ' world' }
    ])
    expect(useChatStore.getState().messages[0]._revision).toBe(2)
  })

  it('handleToolCallStart 应 bump _revision', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const rev0 = useChatStore.getState().messages[0]._revision!

    useChatStore.getState().handleToolCallStart('msg_1', 'tc_1', 'bash')
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })

  it('handleToolResult 应 bump _revision', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    useChatStore.getState().handleToolCallStart('msg_1', 'tc_1', 'bash')
    const revBefore = useChatStore.getState().messages[0]._revision!

    useChatStore.getState().handleToolResult('msg_1', 'tc_1', 'bash', 'done')
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(revBefore)
  })

  it('handleVerificationResult 应 bump _revision', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const rev0 = useChatStore.getState().messages[0]._revision!

    useChatStore.getState().handleVerificationResult('msg_1', 'all passed')
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })

  it('handleMessageEnd (interrupted) 应 bump _revision', async () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const rev0 = useChatStore.getState().messages[0]._revision!

    // handleMessageEnd 是 async，需要 mock 掉内部动态 import
    vi.mocked(mockInvoke).mockResolvedValue(undefined)
    await useChatStore.getState().handleMessageEnd('msg_1', true)
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })

  it('handleError 创建的消息 _revision 应为 0', () => {
    useChatStore.getState().handleError('msg_err', '出错了')
    const msg = useChatStore.getState().messages.find(m => m.id === 'msg_err')
    expect(msg?._revision).toBe(0)
  })

  it('sendMessage 创建的用户消息 _revision 应为 0', async () => {
    // PRD §5.1：sendMessage 现在从 workspace store 读 currentProjectPath
    const { useWorkspaceStore } = await import('../../../src/renderer/stores/useWorkspaceStore')
    useWorkspaceStore.setState({ currentProjectPath: '/test/project' })

    vi.mocked(mockInvoke).mockResolvedValue(undefined)
    await useChatStore.getState().sendMessage('hello')
    const userMsg = useChatStore.getState().messages[0]
    expect(userMsg.role).toBe('user')
    expect(userMsg._revision).toBe(0)
  })

  it('deprecated handleThinkingDelta 应 bump _revision', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const rev0 = useChatStore.getState().messages[0]._revision!

    useChatStore.getState().handleThinkingDelta('msg_1', '思考中')
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })

  it('deprecated handleTextDelta 应 bump _revision', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const rev0 = useChatStore.getState().messages[0]._revision!

    useChatStore.getState().handleTextDelta('msg_1', '文字')
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })

  it('deprecated handleToolCallDelta 应 bump _revision', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    useChatStore.getState().handleToolCallStart('msg_1', 'tc_1', 'bash')
    const rev0 = useChatStore.getState().messages[0]._revision!

    useChatStore.getState().handleToolCallDelta('msg_1', 'tc_1', '{"co')
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })

  it('markRunningAsCancelled 应对被修改的消息 bump _revision', async () => {
    useChatStore.getState().handleMessageStart('msg_1')
    useChatStore.getState().handleToolCallStart('msg_1', 'tc_1', 'bash')
    const rev0 = useChatStore.getState().messages[0]._revision!

    vi.mocked(mockInvoke).mockResolvedValue(undefined)
    await useChatStore.getState().markRunningAsCancelled()
    expect(useChatStore.getState().messages[0]._revision).toBeGreaterThan(rev0)
  })
})
