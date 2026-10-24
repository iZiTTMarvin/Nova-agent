import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_UI_CODE_CHARS,
  initialInlineUiVars,
  parseInlineUi,
  renderInlineUi,
  runInlineUiActions,
  type InlineUiNode,
  type InlineUiPrimitive,
  type InlineUiVars
} from '../../../../src/renderer/features/inline-ui/inlineUiLanguage'

const render = (code: string, vars?: InlineUiVars): InlineUiNode | null => {
  const program = parseInlineUi(code)
  if (!program) return null
  return renderInlineUi(program, vars ?? initialInlineUiVars(program))
}

describe('inlineUiLanguage', () => {
  it('末尾半截语句整条跳过，不影响前面的定义', () => {
    const program = parseInlineUi('root = Text("OK")\nbroken = Col([1,')
    expect(program).not.toBeNull()
    expect(program!.definitions.has('broken')).toBe(false)
    const node = renderInlineUi(program!, initialInlineUiVars(program!))
    expect(node).toMatchObject({ type: 'text', text: 'OK' })
  })

  it('允许先引用后定义，定义流入后按定义渲染', () => {
    const node = render('root = Col([a])\na = Text("晚到", "muted")')
    expect(node).toMatchObject({
      type: 'col',
      children: [{ type: 'text', text: '晚到', style: 'muted' }]
    })
  })

  it('环引用不会死循环，环上的引用渲染为空', () => {
    const cyclic = render('a = Col([a])\nroot = a')
    expect(cyclic).toMatchObject({ type: 'col', children: [] })
    const mutual = render('a = b\nb = a\nroot = Text("ok")')
    expect(mutual).toMatchObject({ type: 'text', text: 'ok' })
  })

  it('各项上限生效', () => {
    // 代码长度：整块按代码块显示
    expect(parseInlineUi('x'.repeat(MAX_INLINE_UI_CODE_CHARS + 1))).toBeNull()

    // 语句数：第 101 条起被忽略，引用它的表达式求值为 null →「—」
    const defs = Array.from({ length: 120 }, (_, i) => `v${i} = ${i}`).join('\n')
    const node = render(`root = Text(v110)\n${defs}`)
    expect(node).toMatchObject({ type: 'text', text: '—' })

    // 深度：超过 32 层括号整条语句失败；不经括号的前缀运算符链同样封顶
    const deep = '('.repeat(40) + '1' + ')'.repeat(40)
    expect(render(`root = ${deep}`)).toBeNull()
    expect(render(`root = Text(${'!'.repeat(40)}true)`)).toBeNull()

    // 数组字面量超过 50 只留前 50
    const sixty = Array.from({ length: 60 }, () => 'Text("x")').join(', ')
    const col = render(`root = Col([${sixty}])`)
    expect(col?.type).toBe('col')
    expect((col as { children: unknown[] }).children).toHaveLength(50)

    // 节点数：超过 150 截断后续部分
    const texts = Array.from({ length: 200 }, () => 'Text("x")').join(', ')
    const big = render(`root = Col([${texts}])`)
    const count = (n: InlineUiNode): number =>
      1 + ('children' in n ? n.children.reduce((sum, c) => sum + count(c), 0) : 0)
    expect(count(big!)).toBeLessThanOrEqual(150)

    // Table 20 列 × 50 行（用名字引用让测试代码保持简短）
    const headers = Array.from({ length: 30 }, (_, i) => `"h${i}"`).join(', ')
    const rowRefs = Array.from({ length: 60 }, () => 'h').join(', ')
    const table = render(`h = [${headers}]\nr = [${rowRefs}]\nroot = Table(h, r)`)
    expect(table).toMatchObject({ type: 'table' })
    expect((table as { headers: string[] }).headers).toHaveLength(20)
    expect((table as { rows: string[][] }).rows).toHaveLength(50)

    // Bars 最多 12 项
    const items = Array.from({ length: 20 }, (_, i) => `{ label: "i${i}", value: ${i} }`).join(', ')
    const bars = render(`root = Bars([${items}])`)
    expect((bars as { items: unknown[] }).items).toHaveLength(12)
  })

  it('指数级拼接链能在合理时间内返回且字符串截断到 500', () => {
    const chain = ['a0 = "x"', ...Array.from({ length: 20 }, (_, i) => `a${i + 1} = a${i} + a${i}`)].join('\n')
    const start = Date.now()
    const node = render(`root = Text(a20)\n${chain}`)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(node).toMatchObject({ type: 'text' })
    expect((node as { text: string }).text.length).toBeLessThanOrEqual(500)
  })

  it('除以 0、类型不匹配得到 null 而不是 NaN', () => {
    expect(render('root = Text(1 / 0)')).toMatchObject({ type: 'text', text: '—' })
    expect(render('root = Text(1 % 0)')).toMatchObject({ type: 'text', text: '—' })
    expect(render('root = Text("a" - 1)')).toMatchObject({ type: 'text', text: '—' })
    expect(render('root = Text(1 < "x")')).toMatchObject({ type: 'text', text: '—' })
    expect(render('root = Text(undefined_name)')).toMatchObject({ type: 'text', text: '—' })
  })

  it('&& / || 短路：左侧已定结果时右侧的除零不污染整个条件', () => {
    const guarded = (expr: string) => render(`root = Text(${expr} ? "ok" : "bad")\n$x = 0`)
    expect(guarded('$x != 0 && 10 / $x > 1')).toMatchObject({ type: 'text', text: 'bad' })
    expect(guarded('$x == 0 || 10 / $x > 1')).toMatchObject({ type: 'text', text: 'ok' })
    // 需要右侧时照常求值，右侧不是布尔仍得到 null
    expect(render('root = Text(true && 10 / $x > 1 ? "ok" : "bad")\n$x = 0')).toMatchObject({ type: 'text', text: '—' })
    expect(render('root = Text(1 && true)')).toMatchObject({ type: 'text', text: '—' })
  })

  it('动作在求值阶段不执行，点击时按当前变量求值', () => {
    const code = 'root = Button("加一", @Set($v, $v + 1))\n$v = 1'
    const program = parseInlineUi(code)!
    const vars = initialInlineUiVars(program)
    const node = renderInlineUi(program, vars) as Extract<InlineUiNode, { type: 'button' }>
    expect(node.actions).toMatchObject([{ kind: 'set', variable: 'v' }])
    // 求值阶段只生成描述，变量没有被改写
    expect(vars.v).toBe(1)
    // 点击时按当时变量求值
    const later: InlineUiVars = { v: 5 }
    expect(runInlineUiActions(node.actions, program, later)).toEqual({ vars: { v: 6 }, ask: null })
    // @Set 求值类型与声明类型不符时整次点击无效
    expect(runInlineUiActions(node.actions, program, { v: 's' } as InlineUiVars)).toBeNull()
  })

  it('多个动作按顺序生效，一次点击最多一次追问', () => {
    const code = [
      'root = Button("下一档", [@Set($a, $a + 1), @Set($b, $a * 10), @AskNova("档位", "现在是 " + $a), @AskNova("x", "y")])',
      '$a = 1',
      '$b = 0'
    ].join('\n')
    const program = parseInlineUi(code)!
    const node = renderInlineUi(program, initialInlineUiVars(program)) as Extract<InlineUiNode, { type: 'button' }>
    expect(node.actions.filter(a => a.kind === 'ask')).toHaveLength(1)
    // 后一个动作看到前一个动作的结果，追问文案用更新后的值
    expect(runInlineUiActions(node.actions, program, initialInlineUiVars(program))).toEqual({
      vars: { a: 2, b: 20 },
      ask: { label: '档位', prompt: '现在是 2' }
    })
  })

  it('@AskNova 求值为动作描述，preview 反映当前变量；其他位置的动作求值为 null', () => {
    const node = render('root = Button("问", @AskNova("标题", "值是 " + $v))\n$v = 3') as Extract<InlineUiNode, { type: 'button' }>
    expect(node.actions).toMatchObject([{ kind: 'ask' }])
    expect(node.preview).toBe('值是 3')
    expect(render('root = Text(@Set($v, 1))\n$v = 1')).toMatchObject({ type: 'text', text: '—' })
  })

  it('@Each 的 item / index 只在模板内可见，结果拍平进子节点', () => {
    const node = render([
      'items = [{name: "读", cost: 2}, {name: "写", cost: 5}]',
      'leak = Text(item)',
      'root = Col([Text("总计 " + @Sum(items, item.cost)), @Each(items, Text(index + 1 + ". " + item.name)), leak])'
    ].join('\n'))
    expect(node).toMatchObject({
      type: 'col',
      children: [
        { type: 'text', text: '总计 7' },
        { type: 'text', text: '1. 读' },
        { type: 'text', text: '2. 写' },
        // 具名定义里看不到模板局部变量
        { type: 'text', text: '—' }
      ]
    })
  })

  it('嵌套 @Each 的放大写法受求值预算约束，按时返回', () => {
    const start = Date.now()
    const node = render('r = @Range(1, 50)\nroot = Col(@Each(r, Col(@Each(r, Col(@Each(r, Text(item)))))))')
    expect(Date.now() - start).toBeLessThan(2000)
    expect(node?.type).toBe('col')
  })

  it('下标、长度与格式化函数', () => {
    expect(render('xs = [10, 20, 30]\nroot = Text(xs[1] + "/" + xs[-1] + "/" + xs.length)')).toMatchObject({ text: '20/30/3' })
    expect(render('root = Text(@Percent(0.256, 1))')).toMatchObject({ text: '25.6%' })
    expect(render('root = Text(@Format(1234.5, 2, " ms"))')).toMatchObject({ text: '1,234.50 ms' })
    const bars = render('root = Bars([{label: "a", value: 1234.567}], " ms")') as Extract<InlineUiNode, { type: 'bars' }>
    expect(bars.items[0].display).toBe('1,234.57 ms')
  })

  it('Tabs 绑定字符串变量时按标签选中，未知值回落第一页', () => {
    const code = 'tabs = [{label: "读", content: Text("R")}, {label: "写", content: Text("W")}]\nroot = Tabs(tabs, $view)\n$view = "写"'
    const program = parseInlineUi(code)!
    expect(renderInlineUi(program, initialInlineUiVars(program))).toMatchObject({ type: 'tabs', active: 1, binding: { variable: 'view', kind: 'string' } })
    expect(renderInlineUi(program, { view: '删' })).toMatchObject({ active: 0 })
  })

  it('Slider 校验与变量类型门槛', () => {
    const program = parseInlineUi('$v = 4\n$s = "a"\nroot = Col([Slider($v, "量", 1, 16, 1), Slider($s, "坏", 1, 16)])')!
    const node = renderInlineUi(program, initialInlineUiVars(program)) as { children: InlineUiNode[] }
    expect(node.children[0]).toMatchObject({ type: 'slider', variable: 'v', value: 4, valid: true })
    expect(node.children[1]).toMatchObject({ type: 'slider', valid: false })
    const bad = render('$v = 1\nroot = Slider($v, "量", 16, 1)') as { valid: boolean }
    expect(bad.valid).toBe(false)
  })
})
