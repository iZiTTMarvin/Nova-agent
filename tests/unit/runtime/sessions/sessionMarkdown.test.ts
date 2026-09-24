/**
 * 会话导出 Markdown：给人看的格式（工具折叠、思考跳过、归档标注、激活路径由调用方保证）。
 */
import { describe, it, expect } from 'vitest'
import { exportSessionToMarkdown } from '../../../../src/runtime/sessions/sessionMarkdown'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'
import { createHash } from 'crypto'
import { ARCHIVED_PLACEHOLDER_KIND } from '../../../../src/runtime/request-projection'

function userMsg(content: string): SessionMessage {
  return { id: 'u1', parentId: null, role: 'user', content, timestamp: 1 }
}

function assistantMsg(blocks: SessionMessage['blocks'], content = ''): SessionMessage {
  return { id: 'a1', parentId: 'u1', role: 'assistant', content, blocks, timestamp: 2 }
}

describe('exportSessionToMarkdown', () => {
  it('用户/助手分段；代码块原样保留', () => {
    const out = exportSessionToMarkdown([
      userMsg('看一下这段'),
      assistantMsg([{ type: 'text', content: '代码如下：\n```ts\nconst a = 1\n```' }])
    ])
    expect(out).toContain('## 用户')
    expect(out).toContain('## 助手')
    expect(out).toContain('```ts')
    expect(out).toContain('const a = 1')
  })

  it('思考块跳过；工具调用折叠为一行摘要', () => {
    const out = exportSessionToMarkdown([
      userMsg('读文件'),
      assistantMsg([
        { type: 'thinking', content: '内部思考不应导出', durationMs: 100 },
        { type: 'tool', toolCallId: 't1', toolName: 'read', arguments: { path: 'src/foo.ts' }, status: 'success' },
        { type: 'text', content: '文件内容是…' }
      ])
    ])
    expect(out).not.toContain('内部思考不应导出')
    expect(out).toContain('`read src/foo.ts` ✓')
    expect(out).not.toContain('"toolName"')
  })

  it('归档的大结果显示为固定标注', () => {
    const body = '大段输出内容'
    const placeholder = JSON.stringify({
      kind: ARCHIVED_PLACEHOLDER_KIND,
      v: 1,
      resourceRef: 'artifact://art-1',
      artifactId: 'art-1',
      toolCallId: 't2',
      sha256: createHash('sha256').update(body).digest('hex'),
      originalBytes: body.length,
      preview: '预览',
      reason: 'consumed_then_archived'
    })
    const out = exportSessionToMarkdown([
      userMsg('跑测试'),
      assistantMsg([{ type: 'tool', toolCallId: 't2', toolName: 'bash', arguments: { command: 'npm test' }, status: 'success', result: placeholder }])
    ])
    expect(out).toContain('[大段输出已归档]')
    expect(out).not.toContain('nova.archived_tool_result')
  })

  it('错误工具显示 ✗；空消息跳过；标题可选', () => {
    const out = exportSessionToMarkdown(
      [
        userMsg(''),
        assistantMsg([{ type: 'tool', toolCallId: 't3', toolName: 'grep', arguments: {}, status: 'error' }])
      ],
      '修 bug 会话'
    )
    expect(out).toContain('# 修 bug 会话')
    expect(out).toContain('`grep` ✗')
    expect(out).not.toContain('## 用户')
  })
})
