import { describe, expect, it } from 'vitest'
import {
  renderModeToolInventory,
  renderToolInventory,
  renderWorkingDirectoryHint,
  renderXmlToolContracts,
  xmlToolDisclosureCovers
} from '../../../../src/runtime/agent/promptBuilder/toolPromptRenderer'
import type { ToolDefinition } from '../../../../src/runtime/model/types'

const sampleTools: ToolDefinition[] = [
  {
    name: 'ls',
    description: 'List directory contents',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: ['path']
    }
  },
  {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path']
    }
  }
]

describe('toolPromptRenderer', () => {
  it('native 模式只列出工具名和简短描述', () => {
    const out = renderToolInventory(sampleTools, { dialect: 'native' })
    expect(out).toContain('- ls({ path: string }) — List directory contents')
    expect(out).toContain('- read({ path: string }) — Read a file')
    expect(out).not.toContain('<invoke>')
  })

  it('xml 模式给出完整 XML 调用示例和格式规则', () => {
    const out = renderToolInventory(sampleTools, { dialect: 'xml' })
    expect(out).toContain('Tool catalog (XML inband calls)')
    expect(out).toContain('<invoke name="ls">')
    expect(out).toContain('<parameter name="path">src/example.ts</parameter>')
    expect(out).toContain('`name` must be one of the tools listed below')
  })

  it('load_tools 可见时按需加载说明出现，不可见时不出现', () => {
    const connector = {
      name: 'load_tools',
      description: 'Load tool groups',
      parameters: { type: 'object' as const, properties: {} }
    }
    const withConnector = [...sampleTools, connector]

    expect(renderToolInventory(withConnector, { dialect: 'native' }))
      .toContain('Tool groups load on demand')
    expect(renderToolInventory(sampleTools, { dialect: 'native' }))
      .not.toContain('Tool groups load on demand')
    expect(renderToolInventory(withConnector, { dialect: 'xml' }))
      .toContain('Tool groups load on demand')
    expect(renderToolInventory(withConnector, { dialect: 'xml' }))
      .toContain('or a tool later activated by a successful load_tools call')
    expect(renderToolInventory(sampleTools, { dialect: 'xml' }))
      .not.toContain('Tool groups load on demand')
    expect(renderToolInventory(sampleTools, { dialect: 'xml' }))
      .toContain('`name` must be one of the tools listed below; never call unlisted tools.')
  })

  it('xmlToolDisclosureCovers 要求当前完整契约，invoke 字样或旧参数均不足', () => {
    const tools = [
      { name: 'task', description: '委派', parameters: { type: 'object', properties: {} } },
      { name: 'task_followup', description: '追问', parameters: { type: 'object', properties: {} } }
    ]
    const corpus = renderXmlToolContracts(tools)
    expect(xmlToolDisclosureCovers(tools, 'Activated tool group "agent".')).toBe(false)
    expect(xmlToolDisclosureCovers(
      tools,
      tools.map(tool => `<invoke name="${tool.name}"></invoke>`).join('\n')
    )).toBe(false)
    expect(xmlToolDisclosureCovers(tools, corpus)).toBe(true)
    expect(xmlToolDisclosureCovers(
      [{ ...tools[0], description: '新契约' }],
      corpus
    )).toBe(false)
    expect(xmlToolDisclosureCovers([], 'anything')).toBe(true)
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

  it('plan 在 XML 方言目录中隐藏编排工具（与 native 同源）', () => {
    const taskTool: ToolDefinition = {
      name: 'task',
      description: 'Launch a subagent',
      parameters: { type: 'object', properties: {} }
    }

    expect(renderModeToolInventory('default', [taskTool], { dialect: 'xml' }))
      .toContain('task')
    expect(renderModeToolInventory('pilot', [taskTool], { dialect: 'xml' }))
      .toContain('task')
    expect(renderModeToolInventory('plan', [taskTool], { dialect: 'xml' }))
      .not.toContain('task')
    expect(renderModeToolInventory('plan', [taskTool], { dialect: 'native' }))
      .not.toContain('task')
  })

  it('renderWorkingDirectoryHint 返回工作区绝对路径', () => {
    const out = renderWorkingDirectoryHint('D:\\work\\project')
    expect(out).toContain('D:\\work\\project')
    expect(out).toContain('resolve against this root')
  })

  it('xml 模式下 edit 示例不含旧版 path/old/new，避免模型漏传 filePath', () => {
    const editTool: ToolDefinition = {
      name: 'edit',
      description: 'Precisely modify an existing file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          edits: { type: 'array' },
          path: { type: 'string', description: '(legacy format)' },
          old: { type: 'string', description: '(legacy format)' },
          new: { type: 'string', description: '(legacy format)' }
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
