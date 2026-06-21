import { describe, expect, it } from 'vitest'
import { buildStableSystemPrompt, getStableSystemPrompt, normalizeFrozenSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'

describe('buildStableSystemPrompt', () => {
  it('native 模式下不包含工具目录，仅保留工作区与模式说明', () => {
    const prompt = buildStableSystemPrompt({
      workingDir: 'D:\\work'
    })

    expect(prompt).not.toContain('<invoke>')
    expect(prompt).not.toContain('你拥有以下工具')
    expect(prompt).toContain('D:\\work')
    expect(prompt).toContain('plan')
    expect(prompt).toContain('default')
    expect(prompt).toContain('auto')
  })
})

describe('getStableSystemPrompt', () => {
  it('默认返回 native 模式 prompt（无工具）', () => {
    const prompt = getStableSystemPrompt()
    expect(prompt).toContain('plan')
    expect(prompt).toContain('default')
    expect(prompt).toContain('auto')
  })

  it('多次调用返回逐字节相同内容', () => {
    expect(getStableSystemPrompt()).toBe(getStableSystemPrompt())
  })
  it('错误宣称“每条消息都有前缀”的 v2 frozen prompt 会被归一化', () => {
    const legacyV2Prompt = [
      '你是 Nova 的编程助手。',
      '基于当前工作区和工具结果回答，保持诚实、具体、可执行。',
      '对话开始时（以及跨天或压缩后），用户消息的开头会带一个 [Session context: ...] 前缀，给出工作区**绝对路径**（Working directory）、当前日期和模型。所有 ls/read/edit/write 等工具的相对路径都基于该绝对路径解析。',
      '不要用任何其他概念覆盖它——不要假设、不要脑补、不要因为 ls 返回相对路径就以为自己在别处。你就是在该工作区内工作。',
      '',
      '你拥有以下工具：',
      '- ls：列出目录内容',
      '- read：读取文件内容',
      '- grep：在文件中搜索内容',
      '- find：按文件名模式查找文件',
      '- edit：编辑文件（修改已有内容）',
      '- write：写入文件（创建或覆盖）',
      '- bash：执行终端命令',
      '',
      'Nova 有三种运行模式，当前激活的模式会在每轮对话中告知你：',
      '- plan 模式：只读规划。你只能读取和分析项目，不能编辑、写入或执行命令。',
      '- default 模式：标准模式。你可以读取、修改和验证工作区，高风险操作需用户审批。',
      '- auto 模式：主动模式。你可以更主动地推进实现和验证，但仍遵守安全边界。',
      '',
      '请严格遵守当前模式的约束。如果在 plan 模式下被要求写入，请说明需要切换模式。'
    ].join('\n')

    expect(normalizeFrozenSystemPrompt(legacyV2Prompt)).toBe(getStableSystemPrompt())
  })

  it('未知 frozen prompt 保持原样，避免误伤自定义 prompt', () => {
    const customPrompt = 'custom prompt'
    expect(normalizeFrozenSystemPrompt(customPrompt)).toBe(customPrompt)
  })
})
