import { describe, expect, it } from 'vitest'
import {
  renderModeToolInventory,
  renderToolInventory,
  renderWorkingDirectoryHint
} from '../../../../src/runtime/agent/promptBuilder/toolPromptRenderer'
import type { ToolDefinition } from '../../../../src/runtime/model/types'

const sampleTools: ToolDefinition[] = [
  {
    name: 'ls',
    description: '列出目录内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } },
      required: ['path']
    }
  },
  {
    name: 'read',
    description: '读取文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path']
    }
  }
]

describe('toolPromptRenderer', () => {
  it('native 模式只列出工具名和简短描述', () => {
    const out = renderToolInventory(sampleTools, { dialect: 'native' })
    expect(out).toContain('- ls({ path: string }) — 列出目录内容')
    expect(out).toContain('- read({ path: string }) — 读取文件')
    expect(out).not.toContain('<invoke>')
  })

  it('xml 模式给出完整 XML 调用示例和格式规则', () => {
    const out = renderToolInventory(sampleTools, { dialect: 'xml' })
    expect(out).toContain('工具目录（XML inband 调用）')
    expect(out).toContain('<invoke name="ls">')
    expect(out).toContain('<parameter name="path">src/example.ts</parameter>')
    expect(out).toContain('`name` 必须是下面列出的工具名之一')
  })

  it('Plan 的 XML 工具目录不暴露写入、命令或子代理工具', () => {
    const tools = [
      ...sampleTools,
      ...['write', 'edit', 'bash', 'task', 'save_plan', 'switch_mode'].map(name => ({
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} }
      }))
    ]
    const out = renderModeToolInventory('plan', tools, { dialect: 'xml' })

    expect(out).toContain('<invoke name="read">')
    expect(out).toContain('<invoke name="save_plan">')
    expect(out).toContain('<invoke name="switch_mode">')
    expect(out).not.toContain('<invoke name="write">')
    expect(out).not.toContain('<invoke name="edit">')
    expect(out).not.toContain('<invoke name="bash">')
    expect(out).not.toContain('<invoke name="task">')
  })

  it('renderWorkingDirectoryHint 返回工作区绝对路径', () => {
    const out = renderWorkingDirectoryHint('D:\\work\\project')
    expect(out).toContain('D:\\work\\project')
    expect(out).toContain('相对路径都基于该绝对路径解析')
  })

  it('xml 模式下 edit 示例不含旧版 path/old/new，避免模型漏传 filePath', () => {
    const editTool: ToolDefinition = {
      name: 'edit',
      description: '精确修改已有文件',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          edits: { type: 'array' },
          path: { type: 'string', description: '（兼容旧格式）' },
          old: { type: 'string', description: '（兼容旧格式）' },
          new: { type: 'string', description: '（兼容旧格式）' }
        },
        required: ['filePath']
      }
    }
    const out = renderToolInventory([editTool], { dialect: 'xml' })
    expect(out).toContain('<parameter name="filePath">')
    expect(out).toContain('<parameter name="edits">')
    expect(out).not.toContain('<parameter name="old">')
    expect(out).not.toContain('<parameter name="new">')
    expect(out).not.toMatch(/<parameter name="path">[^<]*<\/parameter>/)
  })
})
