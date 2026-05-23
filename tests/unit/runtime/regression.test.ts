import { describe, it, expect } from 'vitest'
import { buildConversationContext } from '../../../src/runtime/agent/contextBuilder'
import { formatVerificationSummary } from '../../../src/runtime/verification/service'
import type { SessionData } from '../../../src/runtime/sessions/types'
import type { VerificationResult } from '../../../src/runtime/verification/types'

/**
 * S14 回归测试
 *
 * 验证三条主链路：
 * 1. 多轮对话上下文恢复
 * 2. 模型层 abort 支持（已在 abortSignal.test.ts 覆盖）
 * 3. 验证结果持久化与恢复
 */

function makeSession(messages: SessionData['messages']): SessionData {
  return {
    id: 'sess_regression',
    workspaceRoot: '/tmp/project',
    mode: 'default',
    messages,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('S14 回归测试', () => {
  describe('多轮对话上下文恢复', () => {
    it('模拟真实的两轮对话：第一轮只读 → 第二轮追问', () => {
      // 第一轮：用户问项目结构 → agent 读文件
      // 第二轮：用户追问文件内容 → agent 应看到上文
      const session = makeSession([
        { id: 'm1', role: 'user', content: '项目有哪些文件？', timestamp: 1 },
        {
          id: 'm2',
          role: 'assistant',
          content: '让我看看目录结构。',
          toolCalls: [
            { id: 'tc_1', name: 'ls', arguments: '{"path":"."}', result: 'src/\ntests/\npackage.json' }
          ],
          timestamp: 2
        },
        { id: 'm3', role: 'user', content: '读一下 package.json', timestamp: 3 },
        {
          id: 'm4',
          role: 'assistant',
          content: 'package.json 内容如下：\n{ "name": "nova-agent" }',
          timestamp: 4
        }
      ])

      const context = buildConversationContext(session, 'default')

      // 验证上下文完整恢复
      expect(context).toEqual([
        { role: 'user', content: '项目有哪些文件？' },
        {
          role: 'assistant',
          content: '让我看看目录结构。',
          toolCalls: [{ id: 'tc_1', name: 'ls', arguments: '{"path":"."}' }]
        },
        { role: 'tool', content: 'src/\ntests/\npackage.json', toolCallId: 'tc_1' },
        { role: 'user', content: '读一下 package.json' },
        { role: 'assistant', content: 'package.json 内容如下：\n{ "name": "nova-agent" }' }
      ])

      // 关键：context 长度 = 5（4 条历史消息 + 1 条 tool 消息）
      // 第二轮发送时，模型能看到完整的第一轮对话
      expect(context).toHaveLength(5)
    })

    it('带 thinking 块的历史不影响上下文恢复', () => {
      const session = makeSession([
        { id: 'm1', role: 'user', content: '分析代码', timestamp: 1 },
        {
          id: 'm2',
          role: 'assistant',
          content: '分析结果如下...',
          blocks: [
            { type: 'thinking', content: '先分析代码结构...' },
            { type: 'text', content: '分析结果如下...' }
          ],
          timestamp: 2
        },
        { id: 'm3', role: 'user', content: '继续深入分析', timestamp: 3 }
      ])

      const context = buildConversationContext(session, 'default')

      // thinking 不进入上下文
      const assistantMsg = context.find(m => m.role === 'assistant')!
      expect(assistantMsg.content).toBe('分析结果如下...')
      expect(assistantMsg.toolCalls).toBeUndefined()

      // 第二轮的 user 消息保留
      expect(context[2]).toEqual({ role: 'user', content: '继续深入分析' })
    })

    it('切换 session 后上下文以新 session 为准', () => {
      const sessionA = makeSession([
        { id: 'm1', role: 'user', content: 'Session A 的问题', timestamp: 1 }
      ])

      const sessionB = makeSession([
        { id: 'm1', role: 'user', content: 'Session B 的问题', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'Session B 的回答', timestamp: 2 }
      ])

      const contextA = buildConversationContext(sessionA, 'default')
      const contextB = buildConversationContext(sessionB, 'default')

      expect(contextA).toHaveLength(1)
      expect(contextA[0].content).toBe('Session A 的问题')

      expect(contextB).toHaveLength(2)
      expect(contextB[0].content).toBe('Session B 的问题')
      expect(contextB[1].content).toBe('Session B 的回答')
    })
  })

  describe('验证结果持久化与恢复', () => {
    it('验证摘要格式包含关键信息', () => {
      const result: VerificationResult = {
        command: 'npm test',
        type: 'test',
        success: true,
        output: '5 tests passed',
        exitCode: 0,
        durationMs: 2500
      }

      const summary = formatVerificationSummary(result)

      // 摘要应包含：状态、类型、耗时、命令
      expect(summary).toContain('✓')
      expect(summary).toContain('测试')
      expect(summary).toContain('2.5s')
      expect(summary).toContain('npm test')
    })

    it('失败验证摘要包含输出片段', () => {
      const result: VerificationResult = {
        command: 'npm test',
        type: 'test',
        success: false,
        output: 'FAIL: test should pass\n  at test.js:5\n  at runner.js:10\n\n1 test failed',
        exitCode: 1,
        durationMs: 1200
      }

      const summary = formatVerificationSummary(result)

      expect(summary).toContain('✗')
      expect(summary).toContain('测试失败')
      expect(summary).toContain('1.2s')
      expect(summary).toContain('1 test failed')
    })

    it('SessionMessage 的 verificationSummary 可序列化恢复', () => {
      const summary = '✓ 测试通过 (1.5s) — npm test'

      // 模拟持久化和恢复
      const msgJson = JSON.stringify({
        id: 'msg_1',
        role: 'assistant',
        content: '修改完成',
        verificationSummary: summary,
        timestamp: 1
      })

      const restored = JSON.parse(msgJson)

      expect(restored.verificationSummary).toBe(summary)
      expect(restored.verificationSummary).toContain('✓')
      expect(restored.verificationSummary).toContain('测试通过')
    })
  })
})
