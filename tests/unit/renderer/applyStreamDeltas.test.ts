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

describe('useChatStore.applyStreamDeltas', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
  })

  it('单次 batch 含多个 text delta 应只产生一次 setState（合并到同一消息）', () => {
    useChatStore.getState().handleMessageStart('msg_1')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_1', delta: '你' },
      { kind: 'text', messageId: 'msg_1', delta: '好' },
      { kind: 'text', messageId: 'msg_1', delta: '，' },
      { kind: 'text', messageId: 'msg_1', delta: 'Nova' }
    ])

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toBe('你好，Nova')
    expect(msg.blocks).toEqual([{ type: 'text', content: '你好，Nova' }])
  })

  it('同一 batch 内的 thinking 与 text 应分别累加到对应 block', () => {
    useChatStore.getState().handleMessageStart('msg_2')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_2', delta: '让我想想' },
      { kind: 'thinking', messageId: 'msg_2', delta: '...' },
      { kind: 'text', messageId: 'msg_2', delta: '结果' }
    ])

    const msg = useChatStore.getState().messages[0]
    expect(msg.thinking).toBe('让我想想...')
    expect(msg.content).toBe('结果')
    expect(msg.blocks).toEqual([
      { type: 'thinking', content: '让我想想...' },
      { type: 'text', content: '结果' }
    ])
  })

  it('不同 messageId 的 delta 应分别更新到对应消息，互不污染', () => {
    useChatStore.getState().handleMessageStart('msg_a')
    useChatStore.getState().handleMessageStart('msg_b')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_a', delta: 'A1' },
      { kind: 'text', messageId: 'msg_b', delta: 'B1' },
      { kind: 'text', messageId: 'msg_a', delta: 'A2' }
    ])

    const messages = useChatStore.getState().messages
    expect(messages[0].content).toBe('A1A2')
    expect(messages[1].content).toBe('B1')
  })

  it('toolCall delta 应累积 argumentsRaw 并 partial 解析', () => {
    useChatStore.getState().handleMessageStart('msg_tc')
    useChatStore.getState().handleToolCallStart('msg_tc', 'tc_1', 'write')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_tc', toolCallId: 'tc_1', delta: '{"path":' },
      { kind: 'toolCall', messageId: 'msg_tc', toolCallId: 'tc_1', delta: '"foo.ts",' },
      { kind: 'toolCall', messageId: 'msg_tc', toolCallId: 'tc_1', delta: '"content":' },
      { kind: 'toolCall', messageId: 'msg_tc', toolCallId: 'tc_1', delta: '"hi"}' }
    ])

    const state = useChatStore.getState()
    const toolCall = state.messages[0].toolCalls![0]
    expect(toolCall.arguments).toEqual({ path: 'foo.ts', content: 'hi' })
    expect(state.streamingToolArgs['tc_1']).toBe('{"path":"foo.ts","content":"hi"}')
  })

  it('空 batch 调用应 no-op，不修改任何状态', () => {
    useChatStore.getState().handleMessageStart('msg_empty')
    const beforeContent = useChatStore.getState().messages[0].content

    useChatStore.getState().applyStreamDeltas([])

    const afterContent = useChatStore.getState().messages[0].content
    expect(afterContent).toBe(beforeContent)
  })

  it('对不存在的 messageId 应静默忽略', () => {
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_nonexistent', delta: 'x' }
    ])

    expect(useChatStore.getState().messages).toEqual([])
  })

  it('thinking 与 text 顺序正确：先全部 thinking，再切到 text 块', () => {
    useChatStore.getState().handleMessageStart('msg_seq')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_seq', delta: '思考1' },
      { kind: 'thinking', messageId: 'msg_seq', delta: '思考2' }
    ])

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_seq', delta: '开始正文' }
    ])

    const msg = useChatStore.getState().messages[0]
    expect(msg.blocks).toEqual([
      { type: 'thinking', content: '思考1思考2' },
      { type: 'text', content: '开始正文' }
    ])
  })

  it('partial JSON 渐进解析：write 工具的 path/content 字段随参数累积逐步可见', () => {
    useChatStore.getState().handleMessageStart('msg_pj')
    useChatStore.getState().handleToolCallStart('msg_pj', 'tc_w', 'write')

    // 第一阶段：仅有 {"path" 还无法解析（值未开始）
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_pj', toolCallId: 'tc_w', delta: '{"path":' }
    ])
    let state = useChatStore.getState()
    expect(state.streamingToolArgs['tc_w']).toBe('{"path":')
    // 字符串值还没开始，partial 解析不出 path
    expect(state.messages[0].toolCalls![0].arguments.path).toBeUndefined()

    // 第二阶段：path 字符串部分出现 → partial 拿到 'ind'
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_pj', toolCallId: 'tc_w', delta: '"ind' }
    ])
    state = useChatStore.getState()
    expect(state.messages[0].toolCalls![0].arguments.path).toBe('ind')

    // 第三阶段：path 闭合且 content 字符串开始
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_pj', toolCallId: 'tc_w', delta: 'ex.ts","content":"hel' }
    ])
    state = useChatStore.getState()
    expect(state.messages[0].toolCalls![0].arguments.path).toBe('index.ts')
    expect(state.messages[0].toolCalls![0].arguments.content).toBe('hel')

    // 第四阶段：完全闭合
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_pj', toolCallId: 'tc_w', delta: 'lo"}' }
    ])
    state = useChatStore.getState()
    expect(state.messages[0].toolCalls![0].arguments).toEqual({
      path: 'index.ts',
      content: 'hello'
    })
  })

  it('applyStreamDeltas 不应为同消息的 N 个 delta 创建 N 个数组拷贝（消息引用稳定）', () => {
    useChatStore.getState().handleMessageStart('msg_ref')

    // 5 个 text delta
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_ref', delta: 'a' },
      { kind: 'text', messageId: 'msg_ref', delta: 'b' },
      { kind: 'text', messageId: 'msg_ref', delta: 'c' },
      { kind: 'text', messageId: 'msg_ref', delta: 'd' },
      { kind: 'text', messageId: 'msg_ref', delta: 'e' }
    ])

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toBe('abcde')

    // 关键：所有其他消息引用保持不变（messages 数组只有索引 0 变更）
    // 没法直接验证数组拷贝次数，但可以验证"其他消息没被错误影响"
    // 把指针记录下来
    const refBefore = useChatStore.getState().messages
    // 再发一次 delta
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_ref', delta: 'f' }
    ])
    const refAfter = useChatStore.getState().messages
    // 数组长度不变
    expect(refAfter.length).toBe(refBefore.length)
  })

  it('混合 batch：同一 batch 内同时含多 messageId 的 text + toolCall delta，应在一次 setState 中各自正确合并', () => {
    // 真实场景：buffer 的 16ms timer 触发时，可能在同帧内积累到来自
    // 不同 messageId 的 text delta（消息 A 的中间文本）+ toolCall delta
    // （消息 B 的工具参数）。验证混合 batch 一次处理不漏不串。
    useChatStore.getState().handleMessageStart('msg_a')
    useChatStore.getState().handleMessageStart('msg_b')
    useChatStore.getState().handleToolCallStart('msg_b', 'tc_b1', 'write')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_a', delta: 'A' },
      { kind: 'text', messageId: 'msg_b', delta: 'B' },
      { kind: 'toolCall', messageId: 'msg_b', toolCallId: 'tc_b1', delta: '{"path":' },
      { kind: 'text', messageId: 'msg_a', delta: 'A2' },
      { kind: 'toolCall', messageId: 'msg_b', toolCallId: 'tc_b1', delta: '"a.ts"}' }
    ])

    const state = useChatStore.getState()
    const a = state.messages[0]
    const b = state.messages[1]

    // msg_a: 文本累积
    expect(a.content).toBe('AA2')
    expect(a.blocks).toEqual([{ type: 'text', content: 'AA2' }])
    // msg_a 的 toolCalls 由 handleMessageStart 初始化为 []（不是 undefined）
    expect(a.toolCalls).toEqual([])

    // msg_b: 文本 + toolCall partial 解析
    expect(b.content).toBe('B')
    expect(b.toolCalls).toBeDefined()
    expect(b.toolCalls![0].arguments).toEqual({ path: 'a.ts' })
    expect(state.streamingToolArgs['tc_b1']).toBe('{"path":"a.ts"}')
  })

  it('混合 batch：thinking→text→toolCall 应保持 blocks 数组顺序（tool 块由 start 事件先建）', () => {
    // 实际顺序：handleToolCallStart 先把 tool block 入栈 → thinking → text。
    // 这是"先声明占位、再流式内容"的标准流式协议顺序。
    useChatStore.getState().handleMessageStart('msg_mix')
    useChatStore.getState().handleToolCallStart('msg_mix', 'tc_m1', 'bash')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_mix', delta: '思考' },
      { kind: 'text', messageId: 'msg_mix', delta: '正文' },
      { kind: 'toolCall', messageId: 'msg_mix', toolCallId: 'tc_m1', delta: '{"command":"ls"}' }
    ])

    const msg = useChatStore.getState().messages[0]
    // 三个 block 顺序：tool (from start) → thinking → text
    expect(msg.blocks?.map(b => b.type)).toEqual(['tool', 'thinking', 'text'])
    expect(msg.thinking).toBe('思考')
    expect(msg.content).toBe('正文')
    // bash 工具的 partial 解析字段是 command，不是 cmd
    expect(msg.toolCalls![0].arguments).toEqual({ command: 'ls' })
  })

  it('混合 batch：text 在 toolCallStart 之后才到，应按"tool 块先占位 → text 追加"顺序', () => {
    // 真实场景：tool_call_start 走主进程事件独立通道，但 text_delta
    // 走 buffer；text 可能在 tool start 之后才到（罕见但合法）。
    useChatStore.getState().handleMessageStart('msg_combined')
    useChatStore.getState().handleToolCallStart('msg_combined', 'tc_c', 'write')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_combined', delta: '前置文字' },
      { kind: 'toolCall', messageId: 'msg_combined', toolCallId: 'tc_c', delta: '{"path":"' },
      { kind: 'toolCall', messageId: 'msg_combined', toolCallId: 'tc_c', delta: 'foo.txt"}' }
    ])

    const msg = useChatStore.getState().messages[0]
    // blocks: tool (from start) → text
    expect(msg.blocks?.map(b => b.type)).toEqual(['tool', 'text'])
    // write 工具的 partial 解析字段是 path
    expect(msg.toolCalls![0].arguments).toEqual({ path: 'foo.txt' })
  })

  it('竞态回归：handleToolCall finalize 后，迟到的 buffered partial delta 不得覆盖完整 args', () => {
    // 复现截图 bug：工具参数 delta 走 300ms 缓冲，最终 tool-call 事件直接进 store。
    // 若最终事件先写入完整 args，随后缓冲 flush 的残留 partial delta 用残缺解析结果
    // 覆盖完整 args，会导致文件名丢失（UI 显示「未命名文件」）。
    useChatStore.getState().handleMessageStart('msg_race')
    useChatStore.getState().handleToolCallStart('msg_race', 'tc_r', 'write')

    // 1) 流式期间累积了一部分 partial（content 在前，path 还没流到）
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_race', toolCallId: 'tc_r', delta: '{"content":"body' }
    ])

    // 2) 最终事件到达，写入完整 args（path + 完整 content）
    useChatStore.getState().handleToolCall('msg_race', 'tc_r', 'write', {
      path: 'index.html',
      content: 'body-full'
    })

    const afterFinal = useChatStore.getState().messages[0]
    const toolBlockAfterFinal = afterFinal.blocks!.find(
      b => b.type === 'tool' && b.toolCallId === 'tc_r'
    )
    expect(toolBlockAfterFinal).toMatchObject({ arguments: { path: 'index.html', content: 'body-full' } })

    // 3) 缓冲迟到的残留 delta 此刻才 flush —— 不得覆盖已 finalize 的完整 args
    useChatStore.getState().applyStreamDeltas([
      { kind: 'toolCall', messageId: 'msg_race', toolCallId: 'tc_r', delta: '-content"}' }
    ])

    const afterLate = useChatStore.getState().messages[0]
    const toolBlock = afterLate.blocks!.find(b => b.type === 'tool' && b.toolCallId === 'tc_r')
    const toolCall = afterLate.toolCalls!.find(tc => tc.id === 'tc_r')
    // 关键断言：path 不丢失，完整 args 保持不变
    expect(toolBlock).toMatchObject({ arguments: { path: 'index.html', content: 'body-full' } })
    expect(toolCall!.arguments).toEqual({ path: 'index.html', content: 'body-full' })
  })

  it('handleToolCall 会剥掉正文末尾的伪工具调用 JSON，避免和真实工具卡片重复展示', () => {
    useChatStore.getState().handleMessageStart('msg_text_tool')
    useChatStore.getState().handleTextDelta(
      'msg_text_tool',
      [
        '我来看看当前目录。',
        '',
        '```json',
        '{"name":"list_directory","arguments":{"path":"."}}',
        '```'
      ].join('\n')
    )

    useChatStore.getState().handleToolCall('msg_text_tool', 'tc_text', 'ls', { path: '.' })

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toBe('我来看看当前目录。')
    expect(msg.blocks?.find(b => b.type === 'text')).toMatchObject({ content: '我来看看当前目录。' })
    expect(msg.toolCalls?.[0]).toMatchObject({ name: 'ls', arguments: { path: '.' } })
  })
  it('handleToolCall 会剥掉正文行内的多个伪工具调用 JSON', () => {
    useChatStore.getState().handleMessageStart('msg_inline_tools')
    useChatStore.getState().handleTextDelta(
      'msg_inline_tools',
      '我先看目录。{ "name": "directory_tree", "arguments": { "path": ".", "max_depth": 2 } } 再读 README。{ "name": "read_file", "arguments": { "path": "README.md" } }'
    )

    useChatStore.getState().handleToolCall('msg_inline_tools', 'tc_1', 'ls', { path: '.', max_depth: 2 })

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toBe('我先看目录。 再读 README。')
    const textBlock = msg.blocks?.find(b => b.type === 'text')
    expect(textBlock).toMatchObject({ content: '我先看目录。 再读 README。' })
    expect(msg.toolCalls?.[0]).toMatchObject({ name: 'ls', arguments: { path: '.', max_depth: 2 } })
  })
})
