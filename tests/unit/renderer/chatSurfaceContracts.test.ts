/**
 * 对话表面契约：
 * 1. ChatPanel.css 禁止 .astryx-* 覆盖（几何/颜色一律走 Astryx API 或 theme components hook）
 * 2. 消息结构走 ChatMessage/ChatMessageBubble（气泡/头像不再手写 flex）
 * 3. Markdown 内核为 Astryx <Markdown>（sealed/tail 流式算法仍归 Nova incrementalMarkdown）
 * 4. 不出现手写元数据行（未来元数据必须走 ChatMessage metadata 槽）
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPanelCss = readFileSync(
  new URL('../../../src/renderer/features/chat/ChatPanel.css', import.meta.url),
  'utf8'
)
const messageItemSource = readFileSync(
  new URL('../../../src/renderer/features/chat/MessageItem.tsx', import.meta.url),
  'utf8'
)
const markdownRendererSource = readFileSync(
  new URL('../../../src/renderer/features/chat/MarkdownRenderer.tsx', import.meta.url),
  'utf8'
)
const toolTraceRowSource = readFileSync(
  new URL('../../../src/renderer/features/chat/ToolTraceRow.tsx', import.meta.url),
  'utf8'
)
const toolCallGroupSource = readFileSync(
  new URL('../../../src/renderer/features/chat/ToolCallGroup.tsx', import.meta.url),
  'utf8'
)
const turnProcessTreeSource = readFileSync(
  new URL('../../../src/renderer/features/chat/TurnProcessTree.tsx', import.meta.url),
  'utf8'
)

/** 去掉 CSS 注释，避免注释中的说明文字误触选择器扫描 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('对话表面：.astryx-* 覆盖禁令', () => {
  it('ChatPanel.css 不存在任何 .astryx-* 选择器规则', () => {
    const rules = stripCssComments(chatPanelCss)
    expect(rules).not.toMatch(/\.astryx-/)
  })
})

describe('对话表面：消息结构走 Astryx ChatMessage/ChatMessageBubble', () => {
  it('MessageItem 使用 ChatMessage 作为消息 wrapper（sender 对齐语义）', () => {
    expect(messageItemSource).toContain("from '@astryxdesign/core/Chat'")
    expect(messageItemSource).toMatch(/<ChatMessage[\s\S]*?sender=/)
  })

  it('assistant 不渲染头像（产品决策：平铺正文即身份）', () => {
    expect(messageItemSource).not.toContain('NOVA_AVATAR')
    expect(messageItemSource).not.toContain("from '@astryxdesign/core/Avatar'")
  })

  it('用户气泡走 ChatMessageBubble（几何交给 Astryx + theme hook）', () => {
    expect(messageItemSource).toMatch(/<ChatMessageBubble[\s\S]*?variant="filled"/)
  })

  it('手写消息壳类名清零（chat-msg-wrapper 已删除）', () => {
    expect(messageItemSource).not.toContain('chat-msg-wrapper')
    expect(chatPanelCss).not.toContain('chat-msg-wrapper')
  })
})

describe('对话表面：Markdown 内核为 Astryx', () => {
  it('MarkdownRenderer 引擎为 @astryxdesign/core/Markdown，react-markdown 引用清零', () => {
    expect(markdownRendererSource).toContain("from '@astryxdesign/core/Markdown'")
    expect(markdownRendererSource).not.toContain("from 'react-markdown'")
    expect(markdownRendererSource).not.toContain("from 'remark-gfm'")
  })

  it('sealed/tail 流式算法仍由 Nova incrementalMarkdown 拥有', () => {
    expect(markdownRendererSource).toContain("from './incrementalMarkdown'")
  })

  it('围栏代码块走羊皮纸 token，不再硬编码 VS Code 深色底', () => {
    const markdownCss = readFileSync(
      new URL('../../../src/renderer/features/chat/MarkdownRenderer.css', import.meta.url),
      'utf8'
    )
    expect(markdownCss).toContain('var(--code-block-bg)')
    expect(markdownCss).not.toContain('#1e1e1e')
    expect(markdownCss).not.toContain('#161616')
  })
})

describe('对话表面：过程轨行用原生 disclosure 行（左对齐）', () => {
  // Astryx Button 内容居中，用作全宽过程轨行会把 [dot][action][target] 挤到行中央；
  // 过程轨行必须用原生 button + 结构化 span（action/target 分离）。
  it('ToolTraceRow 不使用 Astryx Button，且渲染 action/target 结构化 span', () => {
    expect(toolTraceRowSource).not.toContain("@astryxdesign/core/Button")
    expect(toolTraceRowSource).toContain('tool-trace-row__action')
    expect(toolTraceRowSource).toContain('tool-trace-row__target')
  })

  it('ToolCallGroup 不使用 Astryx Button，且行内动作/文件名为结构化 span', () => {
    expect(toolCallGroupSource).not.toContain("@astryxdesign/core/Button")
    expect(toolCallGroupSource).toContain('tool-call-group__item-action')
    expect(toolCallGroupSource).toContain('tool-call-group__item-filename')
  })

  it('TurnProcessTree 折叠头不使用 Astryx Button，且渲染 header-title span', () => {
    expect(turnProcessTreeSource).not.toContain("@astryxdesign/core/Button")
    expect(turnProcessTreeSource).toContain('turn-process-tree__header-title')
  })
})

describe('对话表面：元数据不手写 flex 行', () => {
  it('MessageItem 不渲染手写时间/元数据行（未来必须走 metadata 槽）', () => {
    expect(messageItemSource).not.toContain('chat-msg__meta')
    expect(messageItemSource).not.toContain('toLocaleTimeString')
    expect(messageItemSource).not.toContain('toLocaleDateString')
  })
})
