// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, renderDom, waitFor, type DomRenderResult } from '../../../unit/renderer/renderDom'
import { InlineUiBlock } from '../../../../src/renderer/features/inline-ui/InlineUiBlock'
import { InlineUiScope, type InlineUiScopeValue } from '../../../../src/renderer/features/inline-ui/InlineUiScope'
import { claimInterfaceState } from '../../../../src/renderer/lib/interfaceStateOutbox'
import { MarkdownRenderer } from '../../../../src/renderer/features/chat/MarkdownRenderer'
import { VisualizationMessageContext } from '../../../../src/renderer/features/visualization/VisualizationMessageContext'
import type { VisualizationSubmitOutcome } from '../../../../src/renderer/features/visualization/visualizationMessages'

const CODE = 'root = Card([Stat("吞吐", $v + "x"), Button("加一", @Set($v, $v + 1)), Button("复原", @Reset(), "secondary")], "吞吐估算")\n$v = 2'
const ASK_CODE = 'root = Button("问", @AskNova("瓶颈", "现在卡在哪？"))'
const SLIDER_CODE = 'root = Slider($v, "并发", 1, 16, 1)\n$v = 4'

const scopeOf = (blockKey: string): InlineUiScopeValue => ({ sessionId: blockKey.split(':')[0], blockKey })

const wrap = (
  blockKey: string,
  code = CODE,
  interactive = true,
  submitter?: (text: string, kind: string) => Promise<VisualizationSubmitOutcome>
) => {
  const scope = scopeOf(blockKey)
  return (
    <VisualizationMessageContext.Provider value={submitter ?? (async () => ({ status: 'sent' as const }))}>
      <InlineUiScope.Provider value={scope}>
        <InlineUiBlock scope={scope} code={code} interactive={interactive} fallback={<div data-testid="fallback">FALLBACK</div>} />
      </InlineUiScope.Provider>
    </VisualizationMessageContext.Provider>
  )
}

const clickButton = (container: HTMLElement, label: string): void => {
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(label))
  expect(button, `未找到按钮 ${label}`).toBeTruthy()
  act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('InlineUiBlock', () => {
  let view: DomRenderResult | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('同作用域、同代码卸载再挂载后变量恢复', () => {
    view = renderDom(wrap('s1:m1:0'))
    clickButton(view.container, '加一')
    expect(view.container.textContent).toContain('3x')
    view.unmount()
    view = renderDom(wrap('s1:m1:0'))
    expect(view.container.textContent).toContain('3x')
  })

  it('作用域不同时互不影响', () => {
    const a = scopeOf('s2:m1:0')
    const b = scopeOf('s2:m2:0')
    view = renderDom(
      <VisualizationMessageContext.Provider value={async () => ({ status: 'sent' as const })}>
        <InlineUiBlock scope={a} code={CODE} interactive={true} fallback={null} />
        <InlineUiBlock scope={b} code={CODE} interactive={true} fallback={null} />
      </VisualizationMessageContext.Provider>
    )
    clickButton(view.container, '加一')
    const stats = view.container.querySelectorAll('.inline-ui__stat-value')
    expect(stats[0].textContent).toBe('3x')
    expect(stats[1].textContent).toBe('2x')
  })

  it('流式中控件禁用、不读写状态；切到可交互时原地换用已保存的值且不重播入场动画', () => {
    view = renderDom(wrap('s3:m1:0'))
    clickButton(view.container, '加一')
    view.unmount()
    view = renderDom(wrap('s3:m1:0', CODE, false))
    // 流式尾部始终按初始值渲染
    expect(view.container.textContent).toContain('2x')
    const disabled = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent?.includes('加一'))
    expect(disabled?.disabled || disabled?.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(view.container.querySelector('.inline-ui--animate')).not.toBeNull()
    view.render(wrap('s3:m1:0', CODE, true))
    expect(view.container.textContent).toContain('3x')
    // 同一实例原地切换：动画类保持不变，不会再挂一次触发重播
    const root = view.container.querySelector('.inline-ui')
    expect(root?.getAttribute('data-interactive')).toBe('true')
    view.unmount()
    // 回合结束后重挂：流式期间出现过的块直接显示终态
    view = renderDom(wrap('s3:m1:0', CODE, true))
    expect(view.container.querySelector('.inline-ui--animate')).toBeNull()
  })

  it('流式中 root 还没写出时显示占位，完成后仍无效才回退为代码块', () => {
    view = renderDom(wrap('s4:m1:0', 'a = Text("x")', false))
    expect(view.container.querySelector('.inline-ui--pending')).not.toBeNull()
    expect(view.container.querySelector('[data-testid="fallback"]')).toBeNull()
    view.render(wrap('s4:m1:0', 'a = Text("x")', true))
    expect(view.container.querySelector('[data-testid="fallback"]')).not.toBeNull()
  })

  it('滑块在流式中禁用', () => {
    view = renderDom(wrap('s1:m9:0', SLIDER_CODE, false))
    expect(view.container.querySelector('[aria-disabled="true"], [disabled]')).not.toBeNull()
  })

  it('用户改过的值记入待回传状态，复原后报告为已恢复初始值；发送失败可放回', () => {
    view = renderDom(wrap('s5:m1:0'))
    clickButton(view.container, '加一')
    const claim = claimInterfaceState('s5')
    expect(claim?.report).toEqual({ widgets: [{ title: '吞吐估算', values: [{ label: 'v', value: '3' }] }] })
    // 取走后为空；发送被拒时放回
    expect(claimInterfaceState('s5')).toBeNull()
    claim!.release()
    clickButton(view.container, '复原')
    expect(view.container.textContent).toContain('2x')
    expect(claimInterfaceState('s5')?.report).toEqual({ widgets: [{ title: '吞吐估算', values: [] }] })
  })

  it('@AskNova 经 Context 提交器发送，返回 blocked 时显示提示', async () => {
    const sent: string[] = []
    const submitter = async (text: string): Promise<VisualizationSubmitOutcome> => {
      sent.push(text)
      return { status: 'blocked', notice: '请先回答当前问题' }
    }
    view = renderDom(wrap('s1:m1:1', ASK_CODE, true, submitter))
    const button = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent?.includes('问'))
    expect(button).toBeTruthy()
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await waitFor(() =>
      view!.container.querySelector('.inline-ui__notice[role="status"]')?.textContent?.includes('请先回答当前问题') === true
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('【可视化】瓶颈 · explore')
    expect(sent[0]).toContain('现在卡在哪？')
  })

  it('没有作用域时经 MarkdownRenderer 渲染为普通代码块', () => {
    view = renderDom(<MarkdownRenderer content={'```openui\nroot = Text("hi")\n```'} />)
    expect(view.container.querySelector('.md-code-block')).not.toBeNull()
    expect(view.container.querySelector('.md-code-block__lang')?.textContent).toBe('openui')
    expect(view.container.querySelector('.inline-ui')).toBeNull()
  })
})
