/**
 * 工具描述渲染器 —— 为 system prompt 生成工具目录。
 *
 * 两种模式：
 * - native：OpenAI/Anthropic 原生 tool_calls，system prompt 里只需列名称和简短描述，
 *   具体 schema 由 API 的 tools 字段提供。
 * - xml：国产 / 类 OpenAI 模型走 inband XML，system prompt 里必须给出完整 XML 调用
 *   示例、参数说明和格式规则，模型按此格式输出到正文，后端 scanner 解析执行。
 */

import type { ToolDefinition } from '../../model/types'
import type { Mode } from '../../../shared/session/types'
import { getModeVisibleTools } from '../../../shared/session/toolVisibility'

export interface RenderOptions {
  /** 当前工具调用方言 */
  dialect: 'native' | 'xml'
}

/** 把 JSON Schema properties 渲染为简短 TS-like 类型串（用于 native 列表）。 */
function summarizeParameters(parameters?: ToolDefinition['parameters']): string {
  if (!parameters || typeof parameters !== 'object') return '()'
  const props = (parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const required = new Set((parameters as { required?: string[] }).required ?? [])
  const fields = Object.entries(props).map(([name, spec]) => {
    const type = (spec as { type?: string }).type ?? 'unknown'
    const marker = required.has(name) ? '' : '?'
    return `${name}${marker}: ${type}`
  })
  return fields.length === 0 ? '()' : `({ ${fields.join(', ')} })`
}

/** load_tools 连接器可见时附加的按需加载说明；文本冻结，任何字节变化会作废全部会话的前缀缓存。 */
const LOAD_TOOLS_HINT =
  'Tool groups load on demand: call load_tools to see and activate deferred groups; activated tools join on the next model step.'

/** 渲染 native 模式下的简洁工具目录。 */
function renderNativeInventory(tools: ToolDefinition[]): string {
  if (tools.length === 0) return ''
  const lines = tools.map(
    t => `- ${t.name}${summarizeParameters(t.parameters)} — ${t.description.split('\n')[0].trim()}`
  )
  return tools.some(t => t.name === 'load_tools')
    ? `${lines.join('\n')}\n\n${LOAD_TOOLS_HINT}`
    : lines.join('\n')
}

/**
 * XML 示例中跳过的兼容字段。
 * edit 的 path/old/new 仅用于 native JSON 向后兼容；放进 XML 示例会让模型
 * 只传 old/new 而漏掉 filePath，触发「缺少 filePath 参数」。
 */
const XML_EXAMPLE_SKIP: Record<string, Set<string>> = {
  edit: new Set(['path', 'old', 'new']),
}

/** 把 JSON Schema property 类型转 XML 示例值。 */
function exampleValueForSchema(
  name: string,
  spec: Record<string, unknown>,
  required: Set<string>
): string {
  const type = spec.type
  if (type === 'number' || type === 'integer') return '1'
  if (type === 'boolean') return 'true'
  if (type === 'array') {
    // edit.edits 需展示真实结构，避免模型抄成 ["a","b"]
    if (name === 'edits') {
      return '[{"oldText":"原始文本","newText":"替换后文本"}]'
    }
    return '["a", "b"]'
  }
  if (type === 'object') return '{"key": "value"}'
  // 默认字符串示例，带语义倾向
  if (name === 'path' || name === 'filePath') return 'src/example.ts'
  if (name === 'command') return 'echo hello'
  if (name === 'pattern') return '*.ts'
  if (name === 'content') return 'file content'
  if (name === 'oldText') return 'old text'
  if (name === 'newText') return 'new text'
  return required.has(name) ? `value for ${name}` : ''
}

/** 渲染单个工具的 XML 调用示例。 */
function renderXmlToolExample(t: ToolDefinition): string {
  const parameters = (t.parameters ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  const props = parameters.properties ?? {}
  const required = new Set(parameters.required ?? [])
  const skipProps = XML_EXAMPLE_SKIP[t.name] ?? new Set<string>()
  const parameterLines: string[] = []
  for (const [name, spec] of Object.entries(props)) {
    if (skipProps.has(name)) continue
    const value = exampleValueForSchema(name, spec, required)
    if (value === '') continue
    const escaped = value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    parameterLines.push(`  <parameter name="${name}">${escaped}</parameter>`)
  }
  if (parameterLines.length === 0) return `<invoke name="${t.name}"></invoke>`
  return `<invoke name="${t.name}">\n${parameterLines.join('\n')}\n</invoke>`
}

/** 渲染 XML 模式下的完整工具目录和格式规则。 */
function renderXmlInventory(tools: ToolDefinition[]): string {
  if (tools.length === 0) return ''

  const toolBlocks = tools.map(t => {
    const parts = [
      `### ${t.name}`,
      t.description.trim(),
      '',
      '示例调用：',
      '```xml',
      renderXmlToolExample(t),
      '```'
    ]
    return parts.join('\n')
  })

  return [
    '## Tool catalog (XML inband calls)',
    '',
    'Call tools by writing the XML tags below directly in your reply:',
    '',
    '```xml',
    '<invoke name="tool-name">',
    '  <parameter name="param-name">value</parameter>',
    '</invoke>',
    '```',
    '',
    'Rules:',
    '- `name` must be one of the tools listed below; never call unlisted tools.',
    '- One `<parameter name="...">value</parameter>` per parameter; path arguments such as `filePath` are never omitted.',
    '- String values are plain text, without JSON quotes or escaping.',
    '- Numbers / booleans / arrays / objects are JSON literals.',
    '- Emit calls consecutively; stop after all calls and wait for results.',
    '- Do not output `<tool_response>`; results are returned to you.',
    ...(tools.some(t => t.name === 'load_tools') ? [LOAD_TOOLS_HINT] : []),
    '',
    ...toolBlocks
  ].join('\n')
}

/** 根据方言渲染工具目录。 */
export function renderToolInventory(tools: ToolDefinition[], options: RenderOptions): string {
  return options.dialect === 'native'
    ? renderNativeInventory(tools)
    : renderXmlInventory(tools)
}

/** 按运行模式收窄后渲染工具目录，确保 XML prompt 与 native schema 使用同一可见性口径。 */
export function renderModeToolInventory(
  mode: Mode,
  tools: ToolDefinition[],
  options: RenderOptions
): string {
  return renderToolInventory(getModeVisibleTools(mode, tools), options)
}

/** 渲染“当前工作区路径”提示（system prompt 的 agentRole 层）。 */
export function renderWorkingDirectoryHint(workingDir: string): string {
  return [
    '## Workspace',
    '',
    `Workspace root: ${workingDir}`,
    'Relative paths in tool arguments resolve against this root.'
  ].join('\n')
}
