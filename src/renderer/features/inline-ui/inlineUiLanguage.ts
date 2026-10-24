/**
 * openui 内联组件语言：解析 + 纯求值。
 *
 * 模型以 ```openui 围栏产出一份小型声明式脚本：$变量声明交互状态，name = expr
 * 定义值或组件，root 是渲染入口。求值是纯函数，永不抛异常：类型不对、除以 0、
 * 环引用、未定义引用、超出预算一律得到 null，渲染层显示为「—」或不渲染。
 * 动作（@Set/@Reset/@AskNova）只在 Button 第二参数位生成描述，点击时才另行求值。
 */
export type InlineUiPrimitive = number | string | boolean
export type InlineUiVars = Readonly<Record<string, InlineUiPrimitive>>

/** 容得下一份十几步、每步带源码摘录的 Walkthrough；解析是线性的，流式重解析的成本可以忽略 */
export const MAX_INLINE_UI_CODE_CHARS = 24_000

/** 语言里全部组件与函数名；写法说明列出的名字必须与这里一致（测试守卫） */
export const INLINE_UI_COMPONENTS = [
  'Col', 'Row', 'Grid', 'Card', 'Tabs', 'Collapsible',
  'Text', 'Callout', 'Badge', 'List', 'KV', 'Code', 'Divider',
  'Stat', 'Progress', 'Table', 'Bars', 'Chart',
  'Flow', 'Steps', 'Walkthrough', 'Flashcard',
  'Slider', 'Choice', 'Select', 'Switch', 'Input', 'Button'
] as const
export const INLINE_UI_FUNCTIONS = [
  'Round', 'Floor', 'Ceil', 'Abs', 'Sqrt', 'Pow', 'Min', 'Max', 'Clamp',
  'Sum', 'Avg', 'Len', 'Range', 'Each', 'Filter', 'Join', 'Format', 'Percent'
] as const
export const INLINE_UI_ACTIONS = ['Set', 'Reset', 'AskNova'] as const

type ComponentName = (typeof INLINE_UI_COMPONENTS)[number]
type FunctionName = (typeof INLINE_UI_FUNCTIONS)[number]
const COMPONENT_SET: ReadonlySet<string> = new Set(INLINE_UI_COMPONENTS)
const FUNCTION_SET: ReadonlySet<string> = new Set(INLINE_UI_FUNCTIONS)

export type Expr =
  | { kind: 'lit'; value: unknown }
  | { kind: 'var'; name: string }
  | { kind: 'ref'; name: string }
  | { kind: 'get'; target: Expr; key: string }
  | { kind: 'index'; target: Expr; index: Expr }
  | { kind: 'unary'; op: '!' | '-'; arg: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'cond'; cond: Expr; then: Expr; otherwise: Expr }
  | { kind: 'array'; items: Expr[] }
  | { kind: 'object'; entries: { key: string; value: Expr }[] }
  | { kind: 'component'; name: string; args: Expr[] }
  | { kind: 'call'; name: string; args: Expr[] }

type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'

export type InlineUiAction =
  | { kind: 'set'; variable: string; value: Expr }
  | { kind: 'reset' }
  | { kind: 'ask'; label: Expr; prompt: Expr }

export interface InlineUiAsk {
  readonly label: string
  readonly prompt: string
}

/** 一次点击的结果：变量按动作顺序依次更新，最多附带一次追问 */
export interface InlineUiActionOutcome {
  readonly vars: InlineUiVars
  readonly ask: InlineUiAsk | null
}

export type InlineUiTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** 交互控件绑定的变量；Tabs 可绑数字（下标）或字符串（标签） */
export interface InlineUiBinding {
  readonly variable: string
  readonly kind: 'number' | 'string'
}

export interface InlineUiFlowItem {
  readonly title: string
  readonly detail: string | null
}

export interface InlineUiWalkStep {
  readonly title: string
  /** 所在层与源码位置，如「Agent · agent.ts:454」 */
  readonly meta: string | null
  readonly detail: string | null
  /** 这一步之后数据的样子 */
  readonly data: { label: string; value: string }[] | null
  readonly code: string | null
  /** 源码摘录的出处，作为折叠标题 */
  readonly file: string | null
  /** 「深入讲讲这一步」要发出的追问；为空时不显示按钮 */
  readonly ask: string | null
}

export interface InlineUiWalkPhase {
  readonly title: string
  readonly summary: string | null
  /** 进出这一阶段的数据，写成「a → b」 */
  readonly io: string | null
  readonly steps: InlineUiWalkStep[]
}

export type InlineUiNode =
  | { type: 'col' | 'row'; children: InlineUiNode[] }
  | { type: 'grid'; children: InlineUiNode[]; columns: number }
  | { type: 'card'; children: InlineUiNode[]; title: string | null }
  | { type: 'collapsible'; children: InlineUiNode[]; title: string; defaultOpen: boolean }
  | { type: 'tabs'; tabs: { label: string; children: InlineUiNode[] }[]; binding: InlineUiBinding | null; active: number | null }
  | { type: 'text'; text: string; style: 'title' | 'body' | 'muted' | 'strong' }
  | { type: 'callout'; text: string; title: string | null; tone: InlineUiTone }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'list'; items: string[]; ordered: boolean }
  | { type: 'kv'; items: { label: string; value: string }[] }
  | { type: 'badge'; text: string; tone: InlineUiTone }
  | { type: 'divider' }
  | { type: 'stat'; label: string; value: string; tone: InlineUiTone; hint: string | null }
  | { type: 'progress'; label: string | null; value: number | null; max: number; display: string; tone: InlineUiTone }
  | { type: 'table'; headers: string[]; rows: string[][]; highlight: number | null }
  | { type: 'bars'; items: { label: string; value: number | null; display: string }[]; unit: string | null }
  | { type: 'chart'; kind: 'bar' | 'line' | 'area'; labels: string[]; series: { name: string; values: (number | null)[] }[]; unit: string | null }
  | { type: 'pie'; items: { label: string; value: number; display: string }[]; donut: boolean; unit: string | null }
  | { type: 'flow'; items: InlineUiFlowItem[]; current: { variable: string; value: number | null } | null; direction: 'row' | 'col' }
  | { type: 'steps'; steps: InlineUiFlowItem[]; current: { variable: string; value: number | null } | null }
  /** current 是跨阶段的全局步骤下标 */
  | { type: 'walkthrough'; phases: InlineUiWalkPhase[]; current: { variable: string; value: number | null } | null }
  | { type: 'flashcard'; front: string; back: string }
  | { type: 'slider'; variable: string; label: string | null; min: number | null; max: number | null; step: number; unit: string | null; value: number | null; valid: boolean }
  | { type: 'choice' | 'select'; variable: string; options: string[]; label: string | null; value: string | null }
  | { type: 'switch'; variable: string; label: string; value: boolean | null }
  | { type: 'input'; variable: string; label: string; placeholder: string | null; value: string | null }
  | { type: 'button'; label: string; variant: 'primary' | 'secondary'; actions: InlineUiAction[]; preview: string | null }

export interface InlineUiProgram {
  /** $变量名 → 初始值；值的类型即变量类型，之后不可变 */
  readonly declarations: ReadonlyMap<string, InlineUiPrimitive>
  /** 名字 → 定义表达式；同名以最后一条为准 */
  readonly definitions: ReadonlyMap<string, Expr>
}

const MAX_STATEMENTS = 100
const MAX_EXPR_DEPTH = 32
const MAX_EVAL_DEPTH = 200
const MAX_EVAL_STEPS = 50_000
const MAX_ARRAY_ITEMS = 50
const MAX_NODES = 150
const MAX_TEXT_CHARS = 500
const MAX_CODE_CHARS = 2000
const MAX_TABLE_COLS = 20
const MAX_TABLE_ROWS = 50
const MAX_LIST_ITEMS = 12
const MAX_TABS = 6
const MAX_SERIES = 6
const MAX_ACTIONS = 8
const MAX_SLIDER_STEPS = 10000
const MAX_WALK_PHASES = 6
const MAX_WALK_PHASE_STEPS = 8
const MAX_WALK_DATA_ROWS = 8
const ASK_LABEL_CHARS = 40
const ASK_PROMPT_CHARS = 500

const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

/* ---------- 语句切分与解析 ---------- */

/** 逐行扫描：括号（字符串内的不算）未闭合时语句跨行延续；// 行与空行跳过 */
function splitStatements(code: string): string[] {
  const statements: string[] = []
  let buffer = ''
  let depth = 0
  const scanDepth = (line: string): number => {
    let quote: string | null = null
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quote !== null) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '/' && line[i + 1] === '/') break
      if (ch === '(' || ch === '[' || ch === '{') depth += 1
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    }
    return depth
  }
  for (const line of code.split('\n')) {
    const trimmed = line.trim()
    if (buffer === '' && (trimmed === '' || trimmed.startsWith('//'))) continue
    buffer += `${line}\n`
    if (scanDepth(line) <= 0 && buffer.trim() !== '') {
      statements.push(buffer)
      buffer = ''
      depth = 0
    }
  }
  // 末尾没写完的半截语句照常进入解析，解析失败被整条跳过
  if (buffer.trim() !== '') statements.push(buffer)
  return statements.slice(0, MAX_STATEMENTS)
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'var'; v: string }
  | { t: 'at'; v: string }
  | { t: 'op'; v: string }

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y
const NUMBER = /\d+(?:\.\d+)?/y
const STRING_ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '"': '"', "'": "'" }

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if (ch === '/' && text[i + 1] === '/') {
      // 语句内部也允许 // 注释到行尾
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let value = ''
      i += 1
      let closed = false
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') {
          const esc = STRING_ESCAPES[text[i + 1]] ?? text[i + 1]
          if (esc === undefined) return null
          value += esc
          i += 2
          continue
        }
        if (c === quote) { closed = true; i += 1; break }
        if (c === '\n') return null
        value += c
        i += 1
      }
      if (!closed) return null
      tokens.push({ t: 'str', v: value })
      continue
    }
    if (ch === '$' || ch === '@') {
      IDENT.lastIndex = i + 1
      const match = IDENT.exec(text)
      if (!match) return null
      tokens.push({ t: ch === '$' ? 'var' : 'at', v: match[0] })
      i = IDENT.lastIndex
      continue
    }
    IDENT.lastIndex = i
    const ident = IDENT.exec(text)
    if (ident) {
      tokens.push({ t: 'id', v: ident[0] })
      i = IDENT.lastIndex
      continue
    }
    NUMBER.lastIndex = i
    const num = NUMBER.exec(text)
    if (num) {
      tokens.push({ t: 'num', v: Number(num[0]) })
      i = NUMBER.lastIndex
      continue
    }
    const two = text.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      tokens.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('()[]{},:?.+-*/%<>!'.includes(ch)) {
      tokens.push({ t: 'op', v: ch })
      i += 1
      continue
    }
    return null
  }
  return tokens
}

/**
 * 递归下降解析器；任何失败抛错，由语句级 catch 吞掉。
 * 嵌套深度在 ternary 与 unary 两个递归入口统一计数：括号、数组、参数都经 ternary，
 * 连续前缀运算符经 unary，二者都封顶才能挡住 `!!!!…` 这类不经过括号的深链。
 */
class ExprParser {
  private pos = 0
  private depth = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr | null {
    const expr = this.ternary()
    return this.pos === this.tokens.length ? expr : null
  }

  private enter(): void {
    this.depth += 1
    if (this.depth > MAX_EXPR_DEPTH) throw new Error('parse')
  }

  private peek(): Token | undefined { return this.tokens[this.pos] }

  private op(v: string): boolean {
    const tok = this.tokens[this.pos]
    if (tok?.t === 'op' && tok.v === v) { this.pos += 1; return true }
    return false
  }

  private expectOp(v: string): void {
    if (!this.op(v)) throw new Error('parse')
  }

  private ternary(): Expr {
    this.enter()
    try {
      const cond = this.binary(0)
      if (!this.op('?')) return cond
      const then = this.ternary()
      this.expectOp(':')
      return { kind: 'cond', cond, then, otherwise: this.ternary() }
    } finally {
      this.depth -= 1
    }
  }

  private static readonly LEVELS: string[][] = [
    ['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']
  ]

  private binary(level: number): Expr {
    if (level >= ExprParser.LEVELS.length) return this.unary()
    let left = this.binary(level + 1)
    for (;;) {
      const tok = this.peek()
      if (!tok || tok.t !== 'op' || !ExprParser.LEVELS[level].includes(tok.v)) return left
      this.pos += 1
      left = { kind: 'binary', op: tok.v as BinaryOp, left, right: this.binary(level + 1) }
    }
  }

  private unary(): Expr {
    this.enter()
    try {
      if (this.op('!')) return { kind: 'unary', op: '!', arg: this.unary() }
      if (this.op('-')) return { kind: 'unary', op: '-', arg: this.unary() }
      return this.postfix()
    } finally {
      this.depth -= 1
    }
  }

  private postfix(): Expr {
    let expr = this.primary()
    for (;;) {
      if (this.op('.')) {
        const tok = this.peek()
        if (!tok || tok.t !== 'id') throw new Error('parse')
        this.pos += 1
        expr = { kind: 'get', target: expr, key: tok.v }
        continue
      }
      if (this.op('[')) {
        const index = this.ternary()
        this.expectOp(']')
        expr = { kind: 'index', target: expr, index }
        continue
      }
      return expr
    }
  }

  private list(close: string): Expr[] {
    const items: Expr[] = []
    if (this.op(close)) return items
    for (;;) {
      items.push(this.ternary())
      if (this.op(close)) return items
      this.expectOp(',')
      // 允许尾逗号
      if (this.op(close)) return items
    }
  }

  private primary(): Expr {
    const tok = this.peek()
    if (!tok) throw new Error('parse')
    if (tok.t === 'num') { this.pos += 1; return { kind: 'lit', value: tok.v } }
    if (tok.t === 'str') { this.pos += 1; return { kind: 'lit', value: tok.v } }
    if (tok.t === 'var') { this.pos += 1; return { kind: 'var', name: tok.v } }
    if (tok.t === 'at') {
      this.pos += 1
      this.expectOp('(')
      return { kind: 'call', name: tok.v, args: this.list(')') }
    }
    if (tok.t === 'id') {
      if (tok.v === 'true' || tok.v === 'false') { this.pos += 1; return { kind: 'lit', value: tok.v === 'true' } }
      if (tok.v === 'null') { this.pos += 1; return { kind: 'lit', value: null } }
      const name = tok.v
      this.pos += 1
      // 组件调用要求首字母大写的标识符紧跟 (
      if (this.peek()?.t === 'op' && this.peek()?.v === '(') {
        if (!/^[A-Z]/.test(name)) throw new Error('parse')
        this.pos += 1
        return { kind: 'component', name, args: this.list(')') }
      }
      return { kind: 'ref', name }
    }
    if (this.op('(')) {
      const inner = this.ternary()
      this.expectOp(')')
      return inner
    }
    if (this.op('[')) {
      return { kind: 'array', items: this.list(']').slice(0, MAX_ARRAY_ITEMS) }
    }
    if (this.op('{')) {
      const entries: { key: string; value: Expr }[] = []
      if (!this.op('}')) {
        for (;;) {
          const key = this.peek()
          if (key?.t === 'id' || key?.t === 'str') { this.pos += 1 }
          else throw new Error('parse')
          this.expectOp(':')
          entries.push({ key: key.v as string, value: this.ternary() })
          if (this.op('}')) break
          this.expectOp(',')
          if (this.op('}')) break
        }
      }
      return { kind: 'object', entries }
    }
    throw new Error('parse')
  }
}

const ASSIGN = /^\s*(\$?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/

export function parseInlineUi(code: string): InlineUiProgram | null {
  if (code.length > MAX_INLINE_UI_CODE_CHARS) return null
  const declarations = new Map<string, InlineUiPrimitive>()
  const definitions = new Map<string, Expr>()
  for (const statement of splitStatements(code)) {
    const match = ASSIGN.exec(statement)
    if (!match) continue
    const [, dollar, name, rhs] = match
    const tokens = tokenize(rhs)
    if (!tokens || tokens.length === 0) continue
    let expr: Expr | null = null
    try {
      expr = new ExprParser(tokens).parse()
    } catch {
      expr = null
    }
    if (!expr) continue
    if (dollar === '$') {
      // 变量声明只接受基本字面量，类型由初始值固定
      if (expr.kind === 'lit' && (typeof expr.value === 'number' || typeof expr.value === 'string' || typeof expr.value === 'boolean')) {
        declarations.set(name, expr.value)
      } else if (expr.kind === 'unary' && expr.op === '-' && expr.arg.kind === 'lit' && typeof expr.arg.value === 'number') {
        declarations.set(name, -expr.arg.value)
      }
      continue
    }
    definitions.set(name, expr)
  }
  return { declarations, definitions }
}

/* ---------- 求值 ---------- */

/** 渲染产物的品牌：作者对象无法伪造，children 过滤只认它 */
const nodeBrand = new WeakSet<object>()
const brand = <T extends InlineUiNode>(node: T): T => { nodeBrand.add(node); return node }
const isNode = (v: unknown): v is InlineUiNode =>
  typeof v === 'object' && v !== null && nodeBrand.has(v as object)

interface EvalBudget {
  steps: number
  depth: number
}

interface EvalCtx {
  readonly program: InlineUiProgram
  readonly vars: InlineUiVars
  /** 单次求值内按名字缓存结果，挡住 a=b+b 链式引用的指数级重复 */
  readonly memo: Map<string, unknown>
  /** 正在展开的名字集合，命中即环引用 */
  readonly expanding: Set<string>
  /** 整次求值共享的步数与深度预算；@Each 嵌套等放大写法超出后一律得 null */
  readonly budget: EvalBudget
  /** @Each / @Filter 模板内的 item 与 index；只在模板表达式本身可见，具名定义里看不到 */
  readonly locals: ReadonlyMap<string, unknown> | null
}

const createCtx = (program: InlineUiProgram, vars: InlineUiVars): EvalCtx => ({
  program, vars, memo: new Map(), expanding: new Set(), budget: { steps: 0, depth: 0 }, locals: null
})

const truncTo = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)
const trunc = (s: string): string => truncTo(s, MAX_TEXT_CHARS)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isNode(v)

const isPrimitiveOrNull = (v: unknown): v is InlineUiPrimitive | null =>
  v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'

const formatNumber = (n: number): string => (Number.isFinite(n) ? NUMBER_FORMAT.format(n) : '—')

/** 任意求值结果转显示文字：非基本值与 null 都是「—」 */
export const inlineUiText = (v: unknown): string => {
  if (typeof v === 'string') return trunc(v)
  if (typeof v === 'number') return trunc(formatNumber(v))
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return '—'
}
const text = inlineUiText

const optionalText = (v: unknown): string | null => (v === null || v === undefined ? null : text(v))

const finite = (n: number): number | null => (Number.isFinite(n) ? n : null)

const numberOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function evalExpr(expr: Expr, ctx: EvalCtx): unknown {
  const { budget } = ctx
  budget.steps += 1
  if (budget.steps > MAX_EVAL_STEPS || budget.depth >= MAX_EVAL_DEPTH) return null
  budget.depth += 1
  try {
    return evalExprInner(expr, ctx)
  } finally {
    budget.depth -= 1
  }
}

function evalExprInner(expr: Expr, ctx: EvalCtx): unknown {
  switch (expr.kind) {
    case 'lit': return expr.value
    case 'var':
      return ctx.program.declarations.has(expr.name) ? (ctx.vars[expr.name] ?? null) : null
    case 'ref': return evalRef(expr.name, ctx)
    case 'get': {
      const target = evalExpr(expr.target, ctx)
      if (isRecord(target)) return Object.hasOwn(target, expr.key) ? target[expr.key] : null
      if (expr.key === 'length' && (Array.isArray(target) || typeof target === 'string')) return target.length
      return null
    }
    case 'index': {
      const target = evalExpr(expr.target, ctx)
      const index = evalExpr(expr.index, ctx)
      if (Array.isArray(target) && typeof index === 'number' && Number.isInteger(index)) {
        const i = index < 0 ? target.length + index : index
        return i >= 0 && i < target.length ? target[i] : null
      }
      if (isRecord(target) && typeof index === 'string') return Object.hasOwn(target, index) ? target[index] : null
      return null
    }
    case 'unary': {
      const arg = evalExpr(expr.arg, ctx)
      if (expr.op === '!') return typeof arg === 'boolean' ? !arg : null
      return typeof arg === 'number' ? finite(-arg) : null
    }
    case 'cond': {
      const cond = evalExpr(expr.cond, ctx)
      if (typeof cond !== 'boolean') return null
      return evalExpr(cond ? expr.then : expr.otherwise, ctx)
    }
    case 'binary': return evalBinary(expr.op, expr.left, expr.right, ctx)
    case 'array': return expr.items.map(item => evalExpr(item, ctx))
    case 'object': {
      // 无原型对象：作者写的 __proto__ 只是普通键，属性读取也不会落到原型链上
      const out: Record<string, unknown> = Object.create(null)
      for (const { key, value } of expr.entries) out[key] = evalExpr(value, ctx)
      return out
    }
    case 'component': return evalComponent(expr.name, expr.args, ctx)
    case 'call': return evalCall(expr.name, expr.args, ctx)
  }
}

function evalRef(name: string, ctx: EvalCtx): unknown {
  if (ctx.locals?.has(name)) return ctx.locals.get(name)
  if (ctx.memo.has(name)) return ctx.memo.get(name)
  if (ctx.expanding.has(name)) return null
  const def = ctx.program.definitions.get(name)
  if (!def) { ctx.memo.set(name, null); return null }
  ctx.expanding.add(name)
  // 具名定义总在无局部变量的上下文里求值，memo 因此与调用位置无关
  const value = evalExpr(def, ctx.locals ? { ...ctx, locals: null } : ctx)
  ctx.expanding.delete(name)
  ctx.memo.set(name, value)
  return value
}

function evalBinary(op: BinaryOp, leftExpr: Expr, rightExpr: Expr, ctx: EvalCtx): unknown {
  if (op === '&&' || op === '||') return evalLogical(op, leftExpr, rightExpr, ctx)
  const left = evalExpr(leftExpr, ctx)
  const right = evalExpr(rightExpr, ctx)
  switch (op) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') return trunc(text(left) + text(right))
      return typeof left === 'number' && typeof right === 'number' ? finite(left + right) : null
    case '-':
      return typeof left === 'number' && typeof right === 'number' ? finite(left - right) : null
    case '*':
      return typeof left === 'number' && typeof right === 'number' ? finite(left * right) : null
    case '/':
      return typeof left === 'number' && typeof right === 'number' && right !== 0 ? finite(left / right) : null
    case '%':
      return typeof left === 'number' && typeof right === 'number' && right !== 0 ? finite(left % right) : null
    case '<': case '<=': case '>': case '>=':
      if (typeof left !== 'number' || typeof right !== 'number') return null
      if (op === '<') return left < right
      if (op === '<=') return left <= right
      if (op === '>') return left > right
      return left >= right
    case '==': case '!=':
      if (!isPrimitiveOrNull(left) || !isPrimitiveOrNull(right)) return false
      return op === '==' ? left === right : left !== right
  }
}

/** 短路求值：左侧已决定结果时不求右侧，`$x != 0 && 10 / $x > 1` 这类保护写法才成立 */
function evalLogical(op: '&&' | '||', leftExpr: Expr, rightExpr: Expr, ctx: EvalCtx): boolean | null {
  const left = evalExpr(leftExpr, ctx)
  if (typeof left !== 'boolean') return null
  if (op === '&&' ? !left : left) return left
  const right = evalExpr(rightExpr, ctx)
  return typeof right === 'boolean' ? right : null
}

/** 以 item / index 为局部变量逐项求模板；模板与列表都受总预算约束 */
function mapTemplate(list: unknown[], template: Expr, ctx: EvalCtx): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < list.length && out.length < MAX_ARRAY_ITEMS; i += 1) {
    const locals = new Map<string, unknown>([['item', list[i]], ['index', i]])
    out.push(evalExpr(template, { ...ctx, locals }))
  }
  return out
}

/** 数值列表：可传数组，也可传若干数字参数；任一项不是有限数字即 null */
function numericList(args: Expr[], ctx: EvalCtx): number[] | null {
  const values = args.length === 1 ? evalExpr(args[0], ctx) : args.map(arg => evalExpr(arg, ctx))
  const list = Array.isArray(values) ? values : [values]
  if (list.length === 0 || list.some(v => numberOrNull(v) === null)) return null
  return list as number[]
}

/** 可选第二参数是逐项取值模板，如 @Sum(items, item.cost) */
function projectedNumbers(args: Expr[], ctx: EvalCtx): number[] | null {
  const list = evalArg(args, 0, ctx)
  if (!Array.isArray(list)) return null
  const values = args.length > 1 ? mapTemplate(list, args[1], ctx) : list.slice(0, MAX_ARRAY_ITEMS)
  return values.every(v => numberOrNull(v) !== null) ? (values as number[]) : null
}

function evalCall(rawName: string, args: Expr[], ctx: EvalCtx): unknown {
  // 动作只在 Button 第二参数位由 evalComponent 单独处理；其他位置与未知函数都求值为 null
  if (!FUNCTION_SET.has(rawName)) return null
  const name = rawName as FunctionName
  const num = (i: number): number | null => numberOrNull(evalArg(args, i, ctx))
  switch (name) {
    case 'Round': case 'Floor': case 'Ceil': {
      const x = num(0)
      if (x === null) return null
      const digitsArg = num(1)
      const digits = digitsArg === null ? 0 : Math.min(6, Math.max(0, Math.trunc(digitsArg)))
      const factor = 10 ** digits
      const fn = name === 'Round' ? Math.round : name === 'Floor' ? Math.floor : Math.ceil
      return finite(fn(x * factor) / factor)
    }
    case 'Abs': { const x = num(0); return x === null ? null : finite(Math.abs(x)) }
    case 'Sqrt': { const x = num(0); return x === null || x < 0 ? null : finite(Math.sqrt(x)) }
    case 'Pow': {
      const [x, y] = [num(0), num(1)]
      return x === null || y === null ? null : finite(x ** y)
    }
    case 'Min': case 'Max': {
      const list = numericList(args, ctx)
      return list === null ? null : finite(name === 'Min' ? Math.min(...list) : Math.max(...list))
    }
    case 'Clamp': {
      const [x, lo, hi] = [num(0), num(1), num(2)]
      return x === null || lo === null || hi === null ? null : finite(Math.min(hi, Math.max(lo, x)))
    }
    case 'Sum': case 'Avg': {
      const list = projectedNumbers(args, ctx)
      if (list === null) return null
      const sum = list.reduce((acc, v) => acc + v, 0)
      if (name === 'Sum') return finite(sum)
      return list.length === 0 ? null : finite(sum / list.length)
    }
    case 'Len': {
      const v = evalArg(args, 0, ctx)
      return Array.isArray(v) || typeof v === 'string' ? v.length : null
    }
    case 'Range': {
      const [start, end] = [num(0), num(1)]
      const stepArg = args.length > 2 ? num(2) : 1
      if (start === null || end === null || stepArg === null || stepArg <= 0) return null
      const out: number[] = []
      const dir = end >= start ? 1 : -1
      for (let v = start; dir > 0 ? v <= end + 1e-9 : v >= end - 1e-9; v += dir * stepArg) {
        out.push(Number(v.toFixed(6)))
        if (out.length >= MAX_ARRAY_ITEMS) break
      }
      return out
    }
    case 'Each': {
      const list = evalArg(args, 0, ctx)
      return Array.isArray(list) && args[1] ? mapTemplate(list, args[1], ctx) : null
    }
    case 'Filter': {
      const list = evalArg(args, 0, ctx)
      if (!Array.isArray(list) || !args[1]) return null
      const keep = mapTemplate(list, args[1], ctx)
      return list.slice(0, keep.length).filter((_, i) => keep[i] === true)
    }
    case 'Join': {
      const list = evalArg(args, 0, ctx)
      if (!Array.isArray(list)) return null
      const sep = evalArg(args, 1, ctx)
      return trunc(list.map(text).join(typeof sep === 'string' ? sep : '、'))
    }
    case 'Format': {
      const x = num(0)
      if (x === null) return null
      const digits = num(1)
      const unit = evalArg(args, 2, ctx)
      const formatted = digits === null
        ? formatNumber(x)
        : new Intl.NumberFormat('zh-CN', {
          minimumFractionDigits: Math.min(6, Math.max(0, Math.trunc(digits))),
          maximumFractionDigits: Math.min(6, Math.max(0, Math.trunc(digits)))
        }).format(x)
      return trunc(formatted + (typeof unit === 'string' ? unit : ''))
    }
    case 'Percent': {
      const x = num(0)
      if (x === null) return null
      const digitsArg = num(1)
      const digits = digitsArg === null ? 0 : Math.min(4, Math.max(0, Math.trunc(digitsArg)))
      return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(x * 100)}%`
    }
    default: {
      const exhaustive: never = name
      return exhaustive
    }
  }
}

const evalArg = (args: Expr[], i: number, ctx: EvalCtx): unknown =>
  i < args.length ? evalExpr(args[i], ctx) : null

/** 子节点：单个节点、节点数组，或数组里再嵌一层数组（@Each 的结果）都拍平成列表 */
const nodeChildren = (v: unknown): InlineUiNode[] => {
  if (isNode(v)) return [v]
  if (!Array.isArray(v)) return []
  const out: InlineUiNode[] = []
  for (const item of v) {
    if (isNode(item)) out.push(item)
    else if (Array.isArray(item)) out.push(...item.filter(isNode))
  }
  return out
}

const enumOr = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback

const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const

/** 控件的第一个参数必须直接写 $变量，且声明类型与控件要求一致 */
function boundVariable(arg: Expr | undefined, program: InlineUiProgram, type: 'number' | 'string' | 'boolean'): string | null {
  if (arg?.kind !== 'var') return null
  return typeof program.declarations.get(arg.name) === type ? arg.name : null
}

function flowItems(v: unknown): InlineUiFlowItem[] | null {
  if (!Array.isArray(v)) return null
  return v.slice(0, MAX_LIST_ITEMS).map(item => {
    if (isRecord(item)) {
      return { title: text(item.title ?? item.label ?? null), detail: optionalText(item.detail ?? null) }
    }
    return { title: text(item), detail: null }
  })
}

function currentStep(arg: Expr | undefined, ctx: EvalCtx): { variable: string; value: number | null } | null {
  const variable = boundVariable(arg, ctx.program, 'number')
  if (variable === null) return null
  const value = ctx.vars[variable]
  return { variable, value: typeof value === 'number' ? value : null }
}

const optionalPlain = (v: unknown, max = MAX_TEXT_CHARS): string | null =>
  typeof v === 'string' || typeof v === 'number' ? truncTo(text(v), max) || null : null

function walkStep(item: unknown): InlineUiWalkStep | null {
  if (!isRecord(item)) return null
  const data = item.data === undefined || item.data === null ? null : kvItems(item.data)
  return {
    title: text(item.title ?? null),
    meta: optionalPlain(item.meta),
    detail: optionalPlain(item.detail),
    data: data && data.length > 0 ? data.slice(0, MAX_WALK_DATA_ROWS) : null,
    code: typeof item.code === 'string' && item.code !== '' ? truncTo(item.code, MAX_CODE_CHARS) : null,
    file: optionalPlain(item.file, 120),
    ask: optionalPlain(item.ask, ASK_PROMPT_CHARS)
  }
}

/**
 * 阶段与步骤允许先引用后定义：尚未写出的名字求值为 null，在这里滤掉，
 * 流式期间阶段条和步骤因此按书写顺序逐个长出来。
 */
function walkPhases(v: unknown): InlineUiWalkPhase[] | null {
  if (!Array.isArray(v)) return null
  const phases: InlineUiWalkPhase[] = []
  for (const item of v) {
    if (phases.length >= MAX_WALK_PHASES) break
    if (!isRecord(item) || !Array.isArray(item.steps)) continue
    const steps = item.steps.map(walkStep).filter((s): s is InlineUiWalkStep => s !== null).slice(0, MAX_WALK_PHASE_STEPS)
    if (steps.length === 0) continue
    phases.push({ title: text(item.title ?? null), summary: optionalPlain(item.summary), io: optionalPlain(item.io, 200), steps })
  }
  return phases
}

/** 追问的显示名取步骤标题，长度与 @AskNova 的上限一致 */
export const walkAskLabel = (step: InlineUiWalkStep): string => step.title.slice(0, ASK_LABEL_CHARS)

function chartSeries(data: unknown): { labels: string[]; series: { name: string; values: (number | null)[] }[] } | null {
  // 单系列：[{label, value}]
  if (Array.isArray(data)) {
    const items = data.slice(0, MAX_ARRAY_ITEMS).filter(isRecord)
    if (items.length === 0) return null
    return {
      labels: items.map(item => text(item.label ?? null)),
      series: [{ name: '', values: items.map(item => numberOrNull(item.value)) }]
    }
  }
  // 多系列：{labels: [...], series: [{name, values}]}
  if (!isRecord(data) || !Array.isArray(data.labels) || !Array.isArray(data.series)) return null
  const labels = data.labels.slice(0, MAX_ARRAY_ITEMS).map(text)
  const series = data.series.slice(0, MAX_SERIES).filter(isRecord).map(s => ({
    name: text(s.name ?? null),
    values: labels.map((_, i) => (Array.isArray(s.values) ? numberOrNull(s.values[i]) : null))
  }))
  return series.length > 0 && labels.length > 0 ? { labels, series } : null
}

function kvItems(v: unknown): { label: string; value: string }[] | null {
  if (Array.isArray(v)) {
    return v.slice(0, MAX_TABLE_ROWS).flatMap(item => {
      if (isRecord(item)) return [{ label: text(item.label ?? item.key ?? null), value: text(item.value ?? null) }]
      if (Array.isArray(item) && item.length >= 2) return [{ label: text(item[0]), value: text(item[1]) }]
      return []
    })
  }
  if (isRecord(v)) return Object.keys(v).slice(0, MAX_TABLE_ROWS).map(key => ({ label: trunc(key), value: text(v[key]) }))
  return null
}

function buttonActions(arg: Expr | undefined, program: InlineUiProgram): InlineUiAction[] {
  if (!arg) return []
  const calls = arg.kind === 'array' ? arg.items : [arg]
  const actions: InlineUiAction[] = []
  let hasAsk = false
  for (const call of calls.slice(0, MAX_ACTIONS)) {
    if (call.kind !== 'call') continue
    if (call.name === 'Set' && call.args[0]?.kind === 'var' && program.declarations.has(call.args[0].name) && call.args[1]) {
      actions.push({ kind: 'set', variable: call.args[0].name, value: call.args[1] })
    } else if (call.name === 'Reset') {
      actions.push({ kind: 'reset' })
    } else if (call.name === 'AskNova' && call.args[0] && call.args[1] && !hasAsk) {
      // 一次点击最多发起一次追问
      hasAsk = true
      actions.push({ kind: 'ask', label: call.args[0], prompt: call.args[1] })
    }
  }
  return actions
}

function evalComponent(rawName: string, args: Expr[], ctx: EvalCtx): InlineUiNode | null {
  if (!COMPONENT_SET.has(rawName)) return null
  const name = rawName as ComponentName
  const { program, vars } = ctx
  const arg = (i: number): unknown => evalArg(args, i, ctx)
  switch (name) {
    case 'Col': case 'Row':
      return brand({ type: name === 'Col' ? 'col' : 'row', children: nodeChildren(arg(0)) })
    case 'Grid': {
      const columns = numberOrNull(arg(1))
      return brand({ type: 'grid', children: nodeChildren(arg(0)), columns: columns === null ? 2 : Math.min(4, Math.max(1, Math.trunc(columns))) })
    }
    case 'Card': {
      const title = args.length > 1 ? arg(1) : null
      return brand({ type: 'card', children: nodeChildren(arg(0)), title: optionalText(title) })
    }
    case 'Collapsible':
      return brand({ type: 'collapsible', title: text(arg(0)), children: nodeChildren(arg(1)), defaultOpen: arg(2) === true })
    case 'Tabs': {
      const list = arg(0)
      if (!Array.isArray(list)) return null
      const tabs = list.slice(0, MAX_TABS).filter(isRecord).map(tab => ({
        label: text(tab.label ?? null),
        children: nodeChildren(tab.content ?? null)
      }))
      if (tabs.length === 0) return null
      const numberVar = boundVariable(args[1], program, 'number')
      const stringVar = numberVar === null ? boundVariable(args[1], program, 'string') : null
      let binding: InlineUiBinding | null = null
      let active: number | null = null
      if (numberVar !== null) {
        binding = { variable: numberVar, kind: 'number' }
        const value = vars[numberVar]
        active = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < tabs.length ? value : 0
      } else if (stringVar !== null) {
        binding = { variable: stringVar, kind: 'string' }
        const index = tabs.findIndex(tab => tab.label === vars[stringVar])
        active = index >= 0 ? index : 0
      }
      return brand({ type: 'tabs', tabs, binding, active })
    }
    case 'Text':
      return brand({ type: 'text', text: text(arg(0)), style: enumOr(arg(1), ['title', 'body', 'muted', 'strong'] as const, 'body') })
    case 'Callout':
      return brand({ type: 'callout', text: text(arg(0)), tone: enumOr(arg(1), TONES, 'info'), title: optionalText(arg(2)) })
    case 'Code': {
      const code = arg(0)
      const language = arg(1)
      return brand({
        type: 'code',
        code: typeof code === 'string' ? truncTo(code, MAX_CODE_CHARS) : text(code),
        language: typeof language === 'string' && /^[A-Za-z0-9_+#-]{1,20}$/.test(language) ? language : null
      })
    }
    case 'List': {
      const items = arg(0)
      if (!Array.isArray(items)) return null
      return brand({ type: 'list', items: items.slice(0, MAX_TABLE_ROWS).map(text), ordered: arg(1) === true })
    }
    case 'KV': {
      const items = kvItems(arg(0))
      return items === null ? null : brand({ type: 'kv', items })
    }
    case 'Badge':
      return brand({ type: 'badge', text: text(arg(0)), tone: enumOr(arg(1), TONES, 'neutral') })
    case 'Divider':
      return brand({ type: 'divider' })
    case 'Stat':
      return brand({
        type: 'stat',
        label: text(arg(0)),
        value: text(arg(1)),
        tone: enumOr(arg(2), TONES, 'neutral'),
        hint: optionalText(arg(3))
      })
    case 'Progress': {
      const value = numberOrNull(arg(1))
      const maxArg = numberOrNull(arg(2))
      const max = maxArg !== null && maxArg > 0 ? maxArg : 100
      return brand({
        type: 'progress',
        label: optionalText(arg(0)),
        value,
        max,
        display: value === null ? '—' : (max === 100 ? `${formatNumber(value)}%` : `${formatNumber(value)} / ${formatNumber(max)}`),
        tone: enumOr(arg(3), TONES, 'info')
      })
    }
    case 'Table': {
      const headers = arg(0)
      const rows = arg(1)
      if (!Array.isArray(headers) || !Array.isArray(rows)) return null
      const head = headers.slice(0, MAX_TABLE_COLS).map(text)
      const body = rows.slice(0, MAX_TABLE_ROWS).map(row =>
        Array.isArray(row) ? row.slice(0, MAX_TABLE_COLS).map(text) : []
      )
      const highlight = numberOrNull(arg(2))
      return brand({
        type: 'table',
        headers: head,
        rows: body,
        highlight: highlight !== null && Number.isInteger(highlight) && highlight >= 0 && highlight < body.length ? highlight : null
      })
    }
    case 'Bars': {
      const items = arg(0)
      if (!Array.isArray(items)) return null
      const unit = optionalText(args.length > 1 ? arg(1) : null)
      return brand({
        type: 'bars',
        items: items.slice(0, MAX_LIST_ITEMS).map(item => {
          const value = isRecord(item) ? numberOrNull(item.value) : null
          return {
            label: isRecord(item) ? text(item.label ?? null) : '—',
            value,
            display: value === null ? '—' : `${formatNumber(value)}${unit ?? ''}`
          }
        }),
        unit
      })
    }
    case 'Chart': {
      const kind = arg(0)
      const unit = optionalText(args.length > 2 ? arg(2) : null)
      if (kind === 'pie' || kind === 'donut') {
        const data = arg(1)
        if (!Array.isArray(data)) return null
        const items = data.slice(0, MAX_LIST_ITEMS).filter(isRecord).flatMap(item => {
          const value = numberOrNull(item.value)
          return value !== null && value >= 0
            ? [{ label: text(item.label ?? null), value, display: `${formatNumber(value)}${unit ?? ''}` }]
            : []
        })
        return items.length === 0 ? null : brand({ type: 'pie', items, donut: kind === 'donut', unit })
      }
      if (kind !== 'bar' && kind !== 'line' && kind !== 'area') return null
      const data = chartSeries(arg(1))
      return data === null ? null : brand({ type: 'chart', kind, labels: data.labels, series: data.series, unit })
    }
    case 'Flow': {
      const items = flowItems(arg(0))
      if (items === null) return null
      return brand({ type: 'flow', items, current: currentStep(args[1], ctx), direction: enumOr(arg(2), ['row', 'col'] as const, 'row') })
    }
    case 'Steps': {
      const steps = flowItems(arg(0))
      return steps === null ? null : brand({ type: 'steps', steps, current: currentStep(args[1], ctx) })
    }
    case 'Walkthrough': {
      const phases = walkPhases(arg(0))
      return phases === null || phases.length === 0 ? null : brand({ type: 'walkthrough', phases, current: currentStep(args[1], ctx) })
    }
    case 'Flashcard':
      return brand({ type: 'flashcard', front: text(arg(0)), back: text(arg(1)) })
    case 'Slider': {
      const variable = boundVariable(args[0], program, 'number')
      const minN = numberOrNull(arg(2))
      const maxN = numberOrNull(arg(3))
      const stepArg = args.length > 4 ? arg(4) : null
      const stepN = stepArg === null ? 1 : (numberOrNull(stepArg) ?? NaN)
      const valid =
        variable !== null &&
        minN !== null && maxN !== null && minN < maxN &&
        Number.isFinite(stepN) && stepN > 0 &&
        (maxN - minN) / stepN <= MAX_SLIDER_STEPS
      const rawValue = variable !== null ? vars[variable] : null
      const value = typeof rawValue === 'number' && minN !== null && maxN !== null
        ? Math.min(maxN, Math.max(minN, rawValue))
        : null
      return brand({
        type: 'slider',
        variable: variable ?? '',
        label: args.length > 1 ? text(arg(1)) : null,
        min: minN, max: maxN,
        step: Number.isFinite(stepN) && stepN > 0 ? stepN : 1,
        unit: optionalText(args.length > 5 ? arg(5) : null),
        value, valid
      })
    }
    case 'Choice': case 'Select': {
      const variable = boundVariable(args[0], program, 'string')
      const options = arg(1)
      return brand({
        type: name === 'Choice' ? 'choice' : 'select',
        variable: variable ?? '',
        options: Array.isArray(options)
          ? options.filter((o): o is string => typeof o === 'string').map(trunc).slice(0, name === 'Choice' ? MAX_LIST_ITEMS : MAX_ARRAY_ITEMS)
          : [],
        label: args.length > 2 ? text(arg(2)) : null,
        value: variable !== null ? (vars[variable] as string | undefined) ?? null : null
      })
    }
    case 'Switch': {
      const variable = boundVariable(args[0], program, 'boolean')
      const value = variable !== null ? vars[variable] : undefined
      return brand({ type: 'switch', variable: variable ?? '', label: text(arg(1)), value: typeof value === 'boolean' ? value : null })
    }
    case 'Input': {
      const variable = boundVariable(args[0], program, 'string')
      const value = variable !== null ? vars[variable] : undefined
      return brand({
        type: 'input',
        variable: variable ?? '',
        label: text(arg(1)),
        placeholder: optionalText(arg(2)),
        value: typeof value === 'string' ? value : null
      })
    }
    case 'Button': {
      const actions = buttonActions(args[1], program)
      const ask = actions.find((a): a is Extract<InlineUiAction, { kind: 'ask' }> => a.kind === 'ask')
      let preview: string | null = null
      if (ask) {
        const prompt = evalExpr(ask.prompt, ctx)
        preview = isPrimitiveOrNull(prompt) && prompt !== null ? text(prompt) : null
      }
      return brand({
        type: 'button',
        label: text(arg(0)),
        actions,
        preview,
        variant: enumOr(arg(2), ['primary', 'secondary'] as const, 'primary')
      })
    }
    default: {
      const exhaustive: never = name
      return exhaustive
    }
  }
}

/* ---------- 对外入口 ---------- */

export function initialInlineUiVars(program: InlineUiProgram): InlineUiVars {
  return { ...Object.fromEntries(program.declarations) }
}

/** 恢复时只采纳声明过且类型一致的变量，其余回退到初始值 */
export function adoptInlineUiVars(program: InlineUiProgram, stored: unknown): InlineUiVars {
  const vars = initialInlineUiVars(program) as Record<string, InlineUiPrimitive>
  if (typeof stored !== 'object' || stored === null) return vars
  for (const [name, initial] of program.declarations) {
    const candidate = (stored as Record<string, unknown>)[name]
    if ((typeof candidate === 'number' || typeof candidate === 'string' || typeof candidate === 'boolean') && typeof candidate === typeof initial) {
      vars[name] = candidate
    }
  }
  return vars
}

/** 子节点所在的容器类型；遍历与剪枝共用 */
export function inlineUiChildren(node: InlineUiNode): InlineUiNode[] {
  switch (node.type) {
    case 'col': case 'row': case 'grid': case 'card': case 'collapsible':
      return node.children
    case 'tabs':
      return node.tabs.flatMap(tab => tab.children)
    default:
      return []
  }
}

/** 超过 150 个节点的树剪掉后续部分；因为 memo 会共享节点，只能在物化时计数 */
function pruneNodes(root: InlineUiNode): InlineUiNode {
  let count = 0
  const visitList = (nodes: InlineUiNode[]): InlineUiNode[] => {
    const out: InlineUiNode[] = []
    for (const child of nodes) {
      const pruned = visit(child)
      if (pruned) out.push(pruned)
    }
    return out
  }
  const visit = (node: InlineUiNode): InlineUiNode | null => {
    if (count >= MAX_NODES) return null
    count += 1
    switch (node.type) {
      case 'col': case 'row': case 'grid': case 'card': case 'collapsible':
        return brand({ ...node, children: visitList(node.children) })
      case 'tabs':
        return brand({ ...node, tabs: node.tabs.map(tab => ({ label: tab.label, children: visitList(tab.children) })) })
      default:
        return node
    }
  }
  return visit(root) ?? root
}

export function renderInlineUi(program: InlineUiProgram, vars: InlineUiVars): InlineUiNode | null {
  const root = evalRef('root', createCtx(program, vars))
  if (!isNode(root)) return null
  return pruneNodes(root)
}

/**
 * 点击时才调用：按顺序把动作求值成新的变量表与可选追问。
 * 后一个 @Set 看到前一个 @Set 的结果；类型不符的单个动作被跳过；
 * 没有任何动作生效时返回 null。
 */
export function runInlineUiActions(
  actions: readonly InlineUiAction[],
  program: InlineUiProgram,
  vars: InlineUiVars
): InlineUiActionOutcome | null {
  let current: InlineUiVars = vars
  let ask: InlineUiAsk | null = null
  let applied = false
  for (const action of actions) {
    const ctx = createCtx(program, current)
    if (action.kind === 'reset') {
      current = initialInlineUiVars(program)
      applied = true
      continue
    }
    if (action.kind === 'set') {
      const declared = program.declarations.get(action.variable)
      const value = evalExpr(action.value, ctx)
      if (declared === undefined || !isPrimitiveOrNull(value) || value === null || typeof value !== typeof declared) continue
      current = { ...current, [action.variable]: value }
      applied = true
      continue
    }
    const label = evalExpr(action.label, ctx)
    const prompt = evalExpr(action.prompt, ctx)
    if (!isPrimitiveOrNull(label) || label === null || !isPrimitiveOrNull(prompt) || prompt === null) continue
    ask = {
      label: text(label).slice(0, ASK_LABEL_CHARS),
      prompt: text(prompt).slice(0, ASK_PROMPT_CHARS)
    }
    applied = true
  }
  return applied ? { vars: current, ask } : null
}
