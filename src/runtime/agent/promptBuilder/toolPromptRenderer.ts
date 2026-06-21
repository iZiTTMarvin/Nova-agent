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

/** 渲染 native 模式下的简洁工具目录。 */
function renderNativeInventory(tools: ToolDefinition[]): string {
  if (tools.length === 0) return ''
  return tools
    .map(t => `- ${t.name}${summarizeParameters(t.parameters)} — ${t.description.split('\n')[0].trim()}`)
    .join('\n')
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
    '## 工具目录（XML inband 调用）',
    '',
    '你必须通过下面的 XML 标签调用工具，把调用直接写在你的回复正文中：',
    '',
    '```xml',
    '<invoke name="工具名">',
    '  <parameter name="参数名">参数值</parameter>',
    '</invoke>',
    '```',
    '',
    '规则：',
    '- `name` 必须是下面列出的工具名之一，禁止调用未列出的工具。',
    '- 每个参数用一个 `<parameter name="...">值</parameter>` 表示；`filePath` / `path` 等路径参数不可省略。',
    '- 字符串值直接写文本，不要加 JSON 引号或转义。',
    '- 数值 / 布尔值 / 数组 / 对象直接写 JSON 字面量。',
    '- 多个调用连续输出；输出完所有工具调用后停止，等待返回结果再继续。',
    '- 你不需要输出 `<tool_response>`，系统会返回结果给你。',
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

/**
 * 渲染“当前工作区路径”提示，用于 XML 模式下让模型知道 cwd。
 * oh-my-pi 的做法是把这个信息放到 project / base rules 层，而不是每条 user 消息前缀。
 */
export function renderWorkingDirectoryHint(workingDir: string): string {
  return [
    '## 当前工作区',
    '',
    `工作区绝对路径：${workingDir}`,
    '所有工具参数中的相对路径都基于该绝对路径解析。'
  ].join('\n')
}
