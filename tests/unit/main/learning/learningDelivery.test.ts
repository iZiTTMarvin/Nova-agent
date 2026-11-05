import { describe, expect, it } from 'vitest'
import { resolveLearningDelivery, type LearningDeliveryPorts } from '../../../../src/main/learning/LearningDelivery'

const ports = {
  loadTopicTitle: async () => null,
  loadDevChange: () => ({ ok: false as const, message: 'unused' })
}

describe('学习投递的界面状态', () => {
  it('界面状态只进模型输入；Renderer 送来的脏数据在边界被截断或丢弃', async () => {
    const text = await resolveLearningDelivery(JSON.stringify({
      kind: 'deliver_command',
      action: {
        type: 'message',
        text: '为什么命中率掉了',
        interfaceState: {
          widgets: [
            { title: '缓存命中', values: [{ label: '前缀长度', value: '4k' }, { label: 42, value: 'x' }] },
            { title: '', values: [] },
            'junk',
            { title: '长值', values: [{ label: '说明', value: '很'.repeat(500) }] }
          ]
        }
      }
    }), ports)

    expect(text.displayText).toBe('为什么命中率掉了')
    const [question, note] = text.modelInput.split('\n\n')
    expect(question).toBe('为什么命中率掉了')
    expect(note).toContain('「缓存命中」：前缀长度 = 4k')
    expect(note).not.toContain('42')
    expect(note).toContain('「长值」：说明 = ')
    expect(note.length).toBeLessThan(400)
  })

  it('没有界面状态时 message 的模型输入与原文一致，不触发投递事实改写', async () => {
    const text = await resolveLearningDelivery(JSON.stringify({
      kind: 'deliver_command',
      action: { type: 'message', text: '继续', interfaceState: { widgets: [] } }
    }), ports)
    expect(text).toEqual({ displayText: '继续', modelInput: '继续' })
  })

  it('选点、直接讲解与改动讲解都不强制展示代码或配图', async () => {
    const deliver = (
      action: Record<string, unknown>,
      customPorts: LearningDeliveryPorts = ports
    ) => resolveLearningDelivery(
      JSON.stringify({ kind: 'deliver_command', action }),
      customPorts
    )

    const selected = await deliver({ type: 'select_node', nodeId: 'node-data' })
    expect(selected.modelInput).toContain('默认不展示代码位置')
    expect(selected.modelInput).toContain('是否配图按【可视化讲解】判断')
    expect(selected.modelInput).not.toContain('把它画出来')

    const explained = await deliver({ type: 'explain', checkpointId: 'checkpoint-data' })
    expect(explained.modelInput).toContain('把答案、运行过程和原因讲清楚')
    expect(explained.modelInput).toContain('用户明确要求看实现时再展开')
    expect(explained.modelInput).not.toContain('并给出代码位置')

    const changed = await deliver(
      { type: 'explain_change', devSessionId: 'dev-session', devMessageId: 'dev-message' },
      {
        loadTopicTitle: async () => null,
        loadDevChange: () => ({
          ok: true as const,
          sessionTitle: '保存数据',
          files: ['src/data.ts'],
          excerpt: '完成保存'
        })
      }
    )
    expect(changed.modelInput).toContain('默认不展示代码位置')
    expect(changed.modelInput).toContain('用户追问实现或证据时再给最少必要的位置')
    expect(changed.modelInput).not.toContain('再给出关键代码位置')
  })
})
