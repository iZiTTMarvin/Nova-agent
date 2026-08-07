import { describe, expect, it } from 'vitest'
import {
  buildSchemaInstruction,
  renderSchemaSignature
} from '../../../../../src/runtime/workflow/host/schemaInstruction'
import type { JsonSchema } from '../../../../../src/shared/subagents'

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    version: { type: 'number' },
    goal: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } }
        },
        required: ['id']
      }
    },
    notes: { type: 'string' }
  },
  required: ['version', 'goal', 'tasks']
}

describe('renderSchemaSignature', () => {
  it('渲染确定性字段签名：嵌套展开一层，可选字段可区分', () => {
    expect(renderSchemaSignature(PLAN_SCHEMA)).toBe([
      '- version: number',
      '- goal: string',
      '- tasks: object[]',
      '  - id: string',
      '  - dependsOn?: string[]',
      '- notes?: string',
      '',
      '字段名后的 ? 表示可选，其余为必填。'
    ].join('\n'))
  })

  it('全部必填时不追加可选说明，枚举值随类型给出', () => {
    expect(renderSchemaSignature({
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'block'] },
        issues: { type: 'array', items: { type: 'string' } }
      },
      required: ['verdict', 'issues']
    })).toBe([
      '- verdict: string（"pass" | "block"）',
      '- issues: string[]'
    ].join('\n'))
  })

  it('非对象 schema 退化为单值说明', () => {
    expect(renderSchemaSignature({ type: 'string' })).toBe('单个 string 值')
  })
})

describe('buildSchemaInstruction', () => {
  it('保留原任务，追加自然语言在前、末尾单个 json 块的输出要求', () => {
    const instruction = buildSchemaInstruction('拆解需求', PLAN_SCHEMA)

    expect(instruction.startsWith('拆解需求\n')).toBe(true)
    expect(instruction).toContain('先用自然语言')
    expect(instruction).toContain('末尾给出恰好一个 ```json 代码块')
    expect(instruction).toContain(renderSchemaSignature(PLAN_SCHEMA))
  })

  it('不把 JSON Schema 原文塞进任务', () => {
    const instruction = buildSchemaInstruction('拆解需求', PLAN_SCHEMA)

    expect(instruction).not.toContain(JSON.stringify(PLAN_SCHEMA))
    expect(instruction).not.toContain('"properties"')
    expect(instruction).not.toContain('"type":"object"')
  })

  it('无 schema 时任务原样透传', () => {
    expect(buildSchemaInstruction('拆解需求', undefined)).toBe('拆解需求')
  })
})
