/**
 * 工具参数形状关卡：按工具 schema 做类型级「校验→修复」，修复开源模型
 * 的高频坏参数（null 可选字段、JSON 字符串数组、裸字符串/{} 占位、
 * 数字字符串数值）。
 *
 * 关键不变量：正常参数原对象引用直接返回；只遍历 args 与 schema.properties
 * 的交集键（别名 / 缺参校验归工具本身，否则会误杀别名合法传参）；数组修复
 * 必须先试 JSON 字符串解析再做裸串包装，否则 '["a","b"]' 会被包成
 * ['["a","b"]']。
 */

/** 形状修复分型（repair_diagnostic 遥测） */
export type ShapeRepairKind = 'shape_null_strip' | 'shape_array_repair' | 'shape_scalar_coercion'

export interface ShapeValidationResult {
  args: Record<string, unknown>
  /** 存在不可修复的类型不符时，回传给模型的字段清单式错误文案 */
  errorText?: string
}

type JsonSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object'

const SCHEMA_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'array', 'object'])

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/
/** 看起来像数组字面量的字符串只走 JSON 解析路径，失败即不可修复，不做裸串包装 */
const ARRAY_LITERAL_HINT = /^\s*\[/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeMatches(declared: JsonSchemaType, value: unknown): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
  }
}

function actualTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isPlainObject(value)) return 'object'
  return typeof value
}

/** 数组修复：JSON 字符串 → 数组、非空裸字符串 → 单元素包装、{} 占位 → 空数组 */
function repairArrayValue(value: unknown): unknown[] | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (ARRAY_LITERAL_HINT.test(trimmed)) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // 残缺数组字面量按不可修复处理，交给字段清单报错
      }
      return null
    }
    if (trimmed.length > 0) return [value]
    return null
  }
  if (isPlainObject(value) && Object.keys(value).length === 0) {
    return []
  }
  return null
}

/** 无损标量还原：只做双向信息无损的转换；返回 undefined 表示不可修复（还原结果永远是标量，不会与该哨兵混淆） */
function repairScalarValue(declared: JsonSchemaType, value: unknown): unknown {
  if (declared === 'number' && typeof value === 'string' && NUMERIC_STRING.test(value.trim())) {
    return Number(value.trim())
  }
  if (declared === 'boolean' && (value === 'true' || value === 'false')) {
    return value === 'true'
  }
  if (declared === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
    return String(value)
  }
  return undefined
}

/** 字段描述 = 基础类型 + 附加说明（每项形态 / 可选值），必填标记由清单拼装时插入中间 */
function describeFieldType(prop: Record<string, unknown>): { type: string; suffix: string } {
  const type = typeof prop.type === 'string' ? prop.type : 'unknown'
  let suffix = ''
  if (type === 'array' && isPlainObject(prop.items) && prop.items.type === 'object') {
    suffix += '，每项为对象'
  }
  if (
    Array.isArray(prop.enum) &&
    prop.enum.length > 0 &&
    prop.enum.length <= 8 &&
    prop.enum.every(item => typeof item === 'string')
  ) {
    suffix += `，可选：${(prop.enum as string[]).join('/')}`
  }
  return { type, suffix }
}

function buildFieldList(schema: Record<string, unknown>): string {
  const properties = schema.properties
  if (!isPlainObject(properties)) return ''
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : []
  return Object.keys(properties)
    .map(name => {
      const prop = properties[name]
      if (!isPlainObject(prop)) return name
      const { type, suffix } = describeFieldType(prop)
      const requiredMark = required.includes(name) ? '，必填' : ''
      return `${name}（${type}${requiredMark}${suffix}）`
    })
    .join('、')
}

/**
 * 校验并修复单个工具调用的参数形状。
 * 正常参数返回原对象引用；发生修复时返回浅拷贝（原对象不被改动）。
 */
export function validateAndRepairToolArgs(
  toolName: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  onRepair?: (kind: ShapeRepairKind) => void
): ShapeValidationResult {
  const properties = schema.properties
  if (!isPlainObject(properties)) {
    return { args }
  }

  let repairedArgs = args
  const mutate = (apply: () => void): void => {
    if (repairedArgs === args) {
      repairedArgs = { ...args }
    }
    apply()
  }

  const violations: string[] = []

  for (const key of Object.keys(args)) {
    const prop = properties[key]
    if (!isPlainObject(prop)) continue
    const declared = prop.type
    if (typeof declared !== 'string' || !SCHEMA_TYPES.has(declared)) continue

    const value = args[key]
    // null 一律剥离（含 required 字段）：「缺参数」的别名感知校验在工具内，
    // 这里报 required 只会误杀「required 传 null + 别名传了合法值」的组合
    if (value === null) {
      mutate(() => {
        delete repairedArgs[key]
      })
      onRepair?.('shape_null_strip')
      continue
    }
    if (value === undefined) continue
    if (typeMatches(declared as JsonSchemaType, value)) continue

    if (declared === 'array') {
      const repaired = repairArrayValue(value)
      if (repaired !== null) {
        const fixed = repaired
        mutate(() => {
          repairedArgs[key] = fixed
        })
        onRepair?.('shape_array_repair')
        continue
      }
    } else {
      const repaired = repairScalarValue(declared as JsonSchemaType, value)
      if (repaired !== undefined) {
        const fixed = repaired
        mutate(() => {
          repairedArgs[key] = fixed
        })
        onRepair?.('shape_scalar_coercion')
        continue
      }
    }
    violations.push(`参数 "${key}" 应为 ${declared}，实际为 ${actualTypeName(value)}`)
  }

  if (violations.length === 0) {
    return { args: repairedArgs }
  }
  return {
    args: repairedArgs,
    errorText: `工具执行失败: ${violations.join('；')}。${toolName} 的参数：${buildFieldList(schema)}`
  }
}
