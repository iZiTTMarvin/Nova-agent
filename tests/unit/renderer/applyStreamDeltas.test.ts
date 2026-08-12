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

  it('单次 batch 含多个 text delta 合并到活跃回合，messages 引用不变', () => {
    useChatStore.getState().handleMessageStart('msg_1')
    const messagesRefBefore = useChatStore.getState().messages

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_1', delta: '你' },
      { kind: 'text', messageId: 'msg_1', delta: '好' },
      { kind: 'text', messageId: 'msg_1', delta: '，' },
      { kind: 'text', messageId: 'msg_1', delta: 'Nova' }
    ])

    // text 只进活跃回合，messages 不动
    expect(useChatStore.getState().messages).toBe(messagesRefBefore)
    expect(useChatStore.getState().messages[0].content).toBe('')
    expect(useChatStore.getState().liveTurn['msg_1']).toEqual({ type: 'text', content: '你好，Nova' })

    // 轮次终态 fold 后内容逐字落到 messages
    useChatStore.getState().handleToolCallStart('msg_1', 'tc_fold', 'read')
    const folded = useChatStore.getState().messages[0]
    expect(folded.content).toBe('你好，Nova')
    expect(folded.blocks?.[0]).toMatchObject({ type: 'text', content: '你好，Nova' })
    expect(useChatStore.getState().liveTurn['msg_1']).toBeUndefined()
  })

  it('同一 batch 内 thinking→text 类型切换：thinking 封存进 messages，text 留活跃回合', () => {
    useChatStore.getState().handleMessageStart('msg_2')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_2', delta: '让我想想' },
      { kind: 'thinking', messageId: 'msg_2', delta: '...' },
      { kind: 'text', messageId: 'msg_2', delta: '结果' }
    ])

    const msg = useChatStore.getState().messages[0]
    // thinking 因类型切换被封存进 messages
    expect(msg.thinking).toBe('让我想想...')
    expect(msg.blocks).toEqual([{ type: 'thinking', content: '让我想想...' }])
    // text 仍在活跃回合（尚未到边界）
    expect(msg.content).toBe('')
    expect(useChatStore.getState().liveTurn['msg_2']).toEqual({ type: 'text', content: '结果' })
  })

  it('不同 messageId 的 text delta 应分别累积到各自活跃回合，互不污染', () => {
    useChatStore.getState().handleMessageStart('msg_a')
    useChatStore.getState().handleMessageStart('msg_b')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_a', delta: 'A1' },
      { kind: 'text', messageId: 'msg_b', delta: 'B1' },
      { kind: 'text', messageId: 'msg_a', delta: 'A2' }
    ])

    const liveTurn = useChatStore.getState().liveTurn
    expect(liveTurn['msg_a']).toEqual({ type: 'text', content: 'A1A2' })
    expect(liveTurn['msg_b']).toEqual({ type: 'text', content: 'B1' })
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

  it('thinking 与 text 顺序正确：先全部 thinking 进活跃回合，text 到来时封存 thinking', () => {
    useChatStore.getState().handleMessageStart('msg_seq')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'thinking', messageId: 'msg_seq', delta: '思考1' },
      { kind: 'thinking', messageId: 'msg_seq', delta: '思考2' }
    ])
    // thinking 先入活跃回合
    expect(useChatStore.getState().liveTurn['msg_seq']).toEqual({ type: 'thinking', content: '思考1思考2' })

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_seq', delta: '开始正文' }
    ])

    const msg = useChatStore.getState().messages[0]
    // text 到来触发类型切换：thinking 封存进 messages，text 进入活跃回合
    expect(msg.blocks).toEqual([{ type: 'thinking', content: '思考1思考2' }])
    expect(msg.thinking).toBe('思考1思考2')
    expect(useChatStore.getState().liveTurn['msg_seq']).toEqual({ type: 'text', content: '开始正文' })
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

  it('纯 text delta 不创建 messages 数组拷贝（messages 引用严格稳定）', () => {
    useChatStore.getState().handleMessageStart('msg_ref')

    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_ref', delta: 'a' },
      { kind: 'text', messageId: 'msg_ref', delta: 'b' },
      { kind: 'text', messageId: 'msg_ref', delta: 'c' },
      { kind: 'text', messageId: 'msg_ref', delta: 'd' },
      { kind: 'text', messageId: 'msg_ref', delta: 'e' }
    ])

    // 活跃回合累积；messages 完全不变
    expect(useChatStore.getState().liveTurn['msg_ref']).toMatchObject({ type: 'text', content: 'abcde' })
    expect(useChatStore.getState().messages[0].content).toBe('')

    const refBefore = useChatStore.getState().messages
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_ref', delta: 'f' }
    ])
    const refAfter = useChatStore.getState().messages
    // 关键：流式 text 期间 messages 数组引用严格不变（Object.is），ChatPanel 不会重提交
    expect(refAfter).toBe(refBefore)
    expect(useChatStore.getState().liveTurn['msg_ref']).toMatchObject({ type: 'text', content: 'abcdef' })
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

    // msg_a: 纯文本 → 活跃回合（messages 未动）
    expect(a.content).toBe('')
    expect(state.liveTurn['msg_a']).toEqual({ type: 'text', content: 'AA2' })
    // msg_a 的 toolCalls 由 handleMessageStart 初始化为 []（不是 undefined）
    expect(a.toolCalls).toEqual([])

    // msg_b: 文本被随后的 toolCall 封存进 messages + toolCall partial 解析
    expect(b.content).toBe('B')
    expect(b.blocks?.map(block => block.type)).toEqual(['tool', 'text'])
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

  it('回归：toolCallStart 前须先落盘 text delta，否则旁白会错落到 tool 块之后', () => {
    // 复现截图类 bug：text_delta 走 16ms 缓冲，tool_call_start 直达 store。
    // 若 start 抢先插入 tool 块，本应属于 tool 之前的正文会开新 text 块挂在 tool 后面，
    // UI 上表现为工具卡片之间冒出残片、Markdown 在反引号处被截断（如「`方法」）。
    useChatStore.getState().handleMessageStart('msg_order')
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_order', delta: '调用前先说明' }
    ])
    // App.tsx 在 handleToolCallStart 前会 buffer.flushNow()，等价于 text 已写入 store
    useChatStore.getState().handleToolCallStart('msg_order', 'tc_order', 'read')

    const ordered = useChatStore.getState().messages[0]
    expect(ordered.blocks?.map(b => b.type)).toEqual(['text', 'tool'])
    expect(ordered.blocks?.[0]).toMatchObject({ type: 'text', content: '调用前先说明' })

    // 反例对照：tool 块先占位、text 后到 → text 进入活跃回合（挂在 tool 之后），
    // 与第一段「text 在 tool 之前 → 封存为 [text, tool]」形成顺序对照。
    useChatStore.getState().handleMessageStart('msg_wrong')
    useChatStore.getState().handleToolCallStart('msg_wrong', 'tc_wrong', 'read')
    useChatStore.getState().applyStreamDeltas([
      { kind: 'text', messageId: 'msg_wrong', delta: '本应在前面的旁白' }
    ])
    const wrong = useChatStore.getState().messages.find(m => m.id === 'msg_wrong')
    // text 尚未封存，messages 只有 tool 块；活跃回合保留 text（投影时位于 tool 之后）
    expect(wrong?.blocks?.map(b => b.type)).toEqual(['tool'])
    expect(useChatStore.getState().liveTurn['msg_wrong']).toEqual({ type: 'text', content: '本应在前面的旁白' })
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
