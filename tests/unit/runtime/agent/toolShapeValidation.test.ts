import { describe, it, expect } from 'vitest'
import {
  validateAndRepairToolArgs,
  type ShapeRepairKind
} from '../../../../src/runtime/agent/execution/toolShapeValidation'

/** 形态对齐 edit 工具：string 必填 + array（object items）必填 */
const EDIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: '文件路径' },
    edits: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
        required: ['oldText', 'newText']
      }
    }
  },
  required: ['filePath', 'edits']
}

/** 形态对齐 read 工具：string 必填 + 可选 number 分页参数 */
const READ_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { type: 'number' },
    limit: { type: 'number' }
  },
  required: ['path']
}

function collectKinds(
  toolName: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): { kinds: ShapeRepairKind[]; result: ReturnType<typeof validateAndRepairToolArgs> } {
  const kinds: ShapeRepairKind[] = []
  const result = validateAndRepairToolArgs(toolName, schema, args, kind => {
    kinds.push(kind)
  })
  return { kinds, result }
}

describe('validateAndRepairToolArgs —— 回归守护', () => {
  it('正常参数原样返回（同一对象引用），无错误无诊断', () => {
    const args = { filePath: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
    const { kinds, result } = collectKinds('edit', EDIT_SCHEMA, args)
    expect(result.args).toBe(args)
    expect(result.errorText).toBeUndefined()
    expect(kinds).toEqual([])
  })

  it('schema 未声明的字段（别名/多余参数）不可见，不触碰', () => {
    const args = { filePath: 'a.ts', pattern: 123 }
    const { kinds, result } = collectKinds('read', READ_SCHEMA, args)
    expect(result.args).toBe(args)
    expect(result.errorText).toBeUndefined()
    expect(kinds).toEqual([])
  })

  it('无 properties 的 schema 直接跳过', () => {
    const args = { x: 1 }
    const result = validateAndRepairToolArgs('t', { type: 'object' }, args)
    expect(result.args).toBe(args)
    expect(result.errorText).toBeUndefined()
  })

  it('修复返回浅拷贝，原对象不被改动', () => {
    const args = { path: 'a.ts', offset: '30' }
    const { result } = collectKinds('read', READ_SCHEMA, args)
    expect(result.args).not.toBe(args)
    expect(result.args.offset).toBe(30)
    expect(args.offset).toBe('30')
  })
})

describe('validateAndRepairToolArgs —— 修复', () => {
  it('null 一律剥离（含 required 字段），缺参判定仍归工具', () => {
    const args = { filePath: null, edits: [{ oldText: 'a', newText: 'b' }] }
    const { kinds, result } = collectKinds('edit', EDIT_SCHEMA, args)
    expect(result.args).not.toHaveProperty('filePath')
    expect(result.errorText).toBeUndefined()
    expect(kinds).toEqual(['shape_null_strip'])
  })

  it('数组以 JSON 字符串输出时解析为真数组', () => {
    const args = { filePath: 'a.ts', edits: '[{"oldText":"a","newText":"b"}]' }
    const { kinds, result } = collectKinds('edit', EDIT_SCHEMA, args)
    expect(result.args.edits).toEqual([{ oldText: 'a', newText: 'b' }])
    expect(result.errorText).toBeUndefined()
    expect(kinds).toEqual(['shape_array_repair'])
  })

  it('排序：JSON 数组字符串先于裸串包装，不会被包成单元素', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags']
    }
    const args = { tags: '["a","b"]' }
    const { result } = collectKinds('t', schema, args)
    expect(result.args.tags).toEqual(['a', 'b'])
  })

  it('裸字符串包装为单元素数组', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } }
    }
    const args = { tags: 'foo' }
    const { kinds, result } = collectKinds('t', schema, args)
    expect(result.args.tags).toEqual(['foo'])
    expect(kinds).toEqual(['shape_array_repair'])
  })

  it('空字符串不包装，走字段清单报错', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } }
    }
    const args = { tags: '' }
    const { kinds, result } = collectKinds('t', schema, args)
    expect(result.args.tags).toBe('')
    expect(result.errorText).toContain('参数 "tags" 应为 array，实际为 string')
    expect(kinds).toEqual([])
  })

  it('残缺数组字面量不误包装', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } }
    }
    const args = { tags: '["a",' }
    const { result } = collectKinds('t', schema, args)
    expect(result.errorText).toContain('参数 "tags" 应为 array')
  })

  it('期望数组处的 {} 空占位替换为空数组', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } }
    }
    const args = { tags: {} }
    const { kinds, result } = collectKinds('t', schema, args)
    expect(result.args.tags).toEqual([])
    expect(kinds).toEqual(['shape_array_repair'])
  })

  it('数字字符串还原为 number（修复静默错读）', () => {
    const args = { path: 'a.ts', offset: '30' }
    const { kinds, result } = collectKinds('read', READ_SCHEMA, args)
    expect(result.args.offset).toBe(30)
    expect(kinds).toEqual(['shape_scalar_coercion'])
  })

  it('布尔字符串还原为 boolean', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { ignoreCase: { type: 'boolean' } }
    }
    const args = { ignoreCase: 'true' }
    const { kinds, result } = collectKinds('t', schema, args)
    expect(result.args.ignoreCase).toBe(true)
    expect(kinds).toEqual(['shape_scalar_coercion'])
  })

  it('string 字段收 number/boolean 时无损还原为字符串', () => {
    const args = { path: 123 }
    const { kinds, result } = collectKinds('read', READ_SCHEMA, args)
    expect(result.args.path).toBe('123')
    expect(kinds).toEqual(['shape_scalar_coercion'])
  })
})

describe('validateAndRepairToolArgs —— 字段清单式错误', () => {
  it('不可修复的类型不符回传可读错误与合法字段清单', () => {
    const args = { filePath: 'a.ts', edits: 123 }
    const { kinds, result } = collectKinds('edit', EDIT_SCHEMA, args)
    expect(result.errorText).toContain('工具执行失败:')
    expect(result.errorText).toContain('参数 "edits" 应为 array，实际为 number')
    expect(result.errorText).toContain('filePath（string，必填）')
    expect(result.errorText).toContain('edits（array，必填，每项为对象）')
    expect(kinds).toEqual([])
  })

  it('多处不符并列报告；enum 字段列出可选值', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'] },
        count: { type: 'number' }
      },
      required: ['mode', 'count']
    }
    const args = { mode: {}, count: { x: 1 } }
    const { result } = collectKinds('t', schema, args)
    expect(result.errorText).toContain('参数 "mode" 应为 string，实际为 object')
    expect(result.errorText).toContain('参数 "count" 应为 number，实际为 object')
    expect(result.errorText).toContain('mode（string，必填，可选：a/b）')
  })
})
