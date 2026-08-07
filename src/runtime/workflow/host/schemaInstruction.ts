/**
 * 把结构化结果契约表达给子代理。
 *
 * 直接塞 JSON Schema 原文会让子代理的任务与回复都变成机器噪声；这里渲染成
 * 紧凑字段签名，并要求「自然语言结论 + 末尾单个 json 围栏块」——围栏块正是
 * 结果投影层提取结构化结果所依赖的形态。
 */
import type { JsonSchema, JsonSchemaObject } from '../../../shared/subagents'

export function buildSchemaInstruction(prompt: string, schema: JsonSchema | undefined): string {
  if (!schema) return prompt
  return [
    prompt,
    '',
    '输出要求：先用自然语言简要说明结论与关键取舍，再在消息末尾给出恰好一个 ```json 代码块，块内是符合以下字段签名的 JSON；正文其余部分不要出现 json 代码块。',
    '',
    renderSchemaSignature(schema)
  ].join('\n')
}

/** 字段签名文本，确定性输出：属性按声明顺序，可选字段以 `?` 标注。 */
export function renderSchemaSignature(schema: JsonSchema): string {
  const root = asObjectSchema(schema)
  if (!root?.properties) return `单个 ${typeLabel(schema)} 值`
  const rendered = renderFields(root, '')
  return rendered.hasOptional
    ? [...rendered.lines, '', '字段名后的 ? 表示可选，其余为必填。'].join('\n')
    : rendered.lines.join('\n')
}

interface RenderedFields {
  readonly lines: string[]
  readonly hasOptional: boolean
}

/** 只展开一层嵌套对象：更深层级用类型名表示，避免签名喧宾夺主。 */
function renderFields(schema: JsonSchemaObject, indent: string): RenderedFields {
  const required = new Set(schema.required ?? [])
  const lines: string[] = []
  let hasOptional = false
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const optional = !required.has(name)
    hasOptional = hasOptional || optional
    lines.push(`${indent}- ${name}${optional ? '?' : ''}: ${typeLabel(property)}`)
    if (indent) continue
    const nested = asObjectSchema(unwrapItems(property))
    if (!nested?.properties) continue
    const child = renderFields(nested, '  ')
    lines.push(...child.lines)
    hasOptional = hasOptional || child.hasOptional
  }
  return { lines, hasOptional }
}

function typeLabel(schema: JsonSchema): string {
  if (typeof schema === 'boolean') return '任意'
  if (schema.type === 'array') {
    return `${schema.items ? typeLabel(schema.items) : '任意'}[]`
  }
  if (schema.enum) {
    return `${schema.type}（${schema.enum.map((value) => JSON.stringify(value)).join(' | ')}）`
  }
  return schema.type
}

function unwrapItems(schema: JsonSchema): JsonSchema {
  return typeof schema === 'object' && schema.type === 'array' && schema.items
    ? schema.items
    : schema
}

function asObjectSchema(schema: JsonSchema): JsonSchemaObject | null {
  return typeof schema === 'object' && schema.type === 'object' ? schema : null
}
