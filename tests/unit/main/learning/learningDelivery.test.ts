import { describe, expect, it } from 'vitest'
import { resolveLearningDelivery } from '../../../../src/main/learning/LearningDelivery'

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
})
