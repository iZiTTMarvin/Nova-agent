/**
 * Code Mode SDK 声明生成：输入参数与结构化结果均从 JSON Schema 投影，
 * 避免执行契约和展示给模型的 TypeScript 声明各自漂移。
 */
import type { ToolDefinition } from '../model/types'

export interface CodeModeToolDefinition extends ToolDefinition {
  codeModeResultSchema?: Record<string, unknown>
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

function schemaTypeToTs(spec: Record<string, unknown>): string {
  const alternatives = spec.oneOf ?? spec.anyOf
  if (Array.isArray(alternatives)) {
    const types = alternatives
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map(schemaTypeToTs)
    return [...new Set(types)].join(' | ') || 'unknown'
  }
  if (Array.isArray(spec.enum)) {
    const values = spec.enum.map(value => JSON.stringify(value)).join(' | ')
    return values.length > 0 ? values : 'string'
  }
  if (spec.const !== undefined) return JSON.stringify(spec.const)
  const type = spec.type
  if (Array.isArray(type)) {
    return [...new Set(type.map(item => schemaTypeToTs({ ...spec, type: item })))].join(' | ')
  }
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const items = spec.items as Record<string, unknown> | undefined
      if (typeof items !== 'object' || items === null || Array.isArray(items)) return 'unknown[]'
      const itemType = schemaTypeToTs(items)
      return `${itemType.includes('|') ? `(${itemType})` : itemType}[]`
    }
    case 'object': {
      const props = (spec.properties as Record<string, Record<string, unknown>> | undefined) ?? {}
      const required = new Set((spec.required as string[] | undefined) ?? [])
      const fields = Object.entries(props).map(([name, child]) => {
        const marker = required.has(name) ? '' : '?'
        return `${propertyName(name)}${marker}: ${schemaTypeToTs(child)}`
      })
      const additional = spec.additionalProperties
      const index = typeof additional === 'object' && additional !== null && !Array.isArray(additional)
        ? `{ [key: string]: ${schemaTypeToTs(additional as Record<string, unknown>)} }`
        : undefined
      if (fields.length > 0 && index) return `({ ${fields.join('; ')} } & ${index})`
      if (fields.length > 0) return `{ ${fields.join('; ')} }`
      if (index) return index
      return 'Record<string, unknown>'
    }
    default:
      return 'unknown'
  }
}

function renderToolArgs(parameters: ToolDefinition['parameters']): string {
  const props = (parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}
  const required = new Set(((parameters as { required?: string[] } | undefined)?.required) ?? [])
  const fields = Object.entries(props).map(([name, spec]) => {
    const marker = required.has(name) ? '' : '?'
    return `${propertyName(name)}${marker}: ${schemaTypeToTs(spec)}`
  })
  return fields.length > 0 ? `{ ${fields.join('; ')} }` : '{}'
}

/** 生成 SDK 声明段；结构化工具直接返回数据，文本工具保持 { output: string }。 */
export function renderCodeModeSdkSection(tools: readonly CodeModeToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  const declarations = sorted.map(tool => {
    const summary = tool.description.split('\n')[0]?.trim() ?? ''
    const resultType = tool.codeModeResultSchema
      ? schemaTypeToTs(tool.codeModeResultSchema)
      : '{ output: string }'
    return [
      summary ? `  /** ${summary} */` : null,
      `  ${tool.name}(args: ${renderToolArgs(tool.parameters)}): Promise<${resultType}>`
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [
    '## Code Mode 只读探索 SDK',
    '',
    '以下只读工具不再作为独立工具调用，只能在 run_code 提交的代码中通过 `tools.<name>(args)` 使用：',
    '返回类型见各工具声明；结构化工具直接返回数据，文本工具返回 `{ output: string }`。调用失败会 throw `ToolCallError`（含 `toolName` 与 `message`，可 try/catch）。',
    '',
    '```ts',
    'declare const tools: {',
    declarations.join(',\n'),
    '}',
    '```'
  ].join('\n')
}
