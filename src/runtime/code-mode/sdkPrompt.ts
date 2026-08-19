/**
 * Code Mode SDK 声明生成：把进入沙箱的只读工具渲染为确定性 TypeScript 声明，
 * 注入 system prompt 的工具目录层（§23/§36）。
 * 字节级稳定：工具按名称排序、类型按 schema 声明顺序渲染、不嵌入运行时状态。
 */
import type { ToolDefinition } from '../model/types'

/** JSON Schema property → TS 类型串（覆盖工具参数实际使用的类型面） */
function schemaTypeToTs(spec: Record<string, unknown>): string {
  if (Array.isArray(spec.enum)) {
    const values = spec.enum.map(v => JSON.stringify(v)).join(' | ')
    return values.length > 0 ? values : 'string'
  }
  const type = spec.type
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array': {
      const items = spec.items as Record<string, unknown> | undefined
      return Array.isArray(items) ? `${schemaTypeToTs(items)}[]` : 'unknown[]'
    }
    case 'object':
      return 'Record<string, unknown>'
    default:
      return 'unknown'
  }
}

function renderToolArgs(parameters: ToolDefinition['parameters']): string {
  const props = (parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}
  const required = new Set(((parameters as { required?: string[] } | undefined)?.required) ?? [])
  const fields = Object.entries(props).map(([name, spec]) => {
    const marker = required.has(name) ? '' : '?'
    return `${name}${marker}: ${schemaTypeToTs(spec)}`
  })
  return fields.length > 0 ? `{ ${fields.join('; ')} }` : '{}'
}

/** 生成 SDK 声明段（追加在工具目录层末尾；入参为进入沙箱的工具定义） */
export function renderCodeModeSdkSection(tools: readonly ToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  const declarations = sorted.map(tool => {
    const summary = tool.description.split('\n')[0]?.trim() ?? ''
    return [
      summary ? `  /** ${summary} */` : null,
      `  ${tool.name}(args: ${renderToolArgs(tool.parameters)}): Promise<{ output: string }>`
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [
    '## Code Mode 只读探索 SDK',
    '',
    '以下只读工具不再作为独立工具调用，只能在 run_code 提交的代码中通过 `tools.<name>(args)` 使用：',
    'await 返回 `{ output: string }`；调用失败会 throw `ToolCallError`（含 `toolName` 与 `message`，可 try/catch）。',
    '',
    '```ts',
    'declare const tools: {',
    declarations.join(',\n'),
    '}',
    '```'
  ].join('\n')
}
