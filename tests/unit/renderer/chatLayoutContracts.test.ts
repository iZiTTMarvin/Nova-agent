import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  new URL('../../../src/renderer/features/chat/ChatPanel.css', import.meta.url),
  'utf8'
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('chat panel layout contracts', () => {
  it('keeps messages stream in full-height flex container with floating composer overlay', () => {
    expect(rule('.chat-panel')).toMatch(/display:\s*flex/)
    expect(rule('.chat-panel')).toMatch(/flex-direction:\s*column/)
    expect(rule('.chat-messages')).toMatch(/flex:\s*1/)
    const composerRule = rule('.chat-panel__composer-area')
    expect(composerRule).toMatch(/position:\s*absolute/)
    expect(composerRule).toMatch(/bottom:\s*0/)
    expect(composerRule).toMatch(/background:\s*transparent/)
    expect(composerRule).toMatch(/pointer-events:\s*none/)
  })

  it('keeps empty state composer centered in document flow', () => {
    const emptyComposerRule = rule('.chat-panel__composer-area--empty')
    expect(emptyComposerRule).toMatch(/position:\s*relative/)
    expect(emptyComposerRule).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(emptyComposerRule).toMatch(/justify-content:\s*center/)
  })

  it('scroll-to-bottom floats above composer without claiming document flow', () => {
    const scrollRule = rule('.chat-scroll-to-bottom')
    expect(scrollRule).toMatch(/position:\s*absolute/)
    expect(scrollRule).toMatch(/bottom:\s*100%/)
    expect(scrollRule).toMatch(/background:\s*var\(--bg-card\)/)
    expect(scrollRule).toMatch(/box-shadow:/)
    expect(rule('.chat-panel__composer-inner')).toMatch(/position:\s*relative/)
    expect(rule('.chat-panel__composer-inner')).toMatch(/pointer-events:\s*none/)
  })

  it('locks message flow and composer to centered reading column with responsive gutters', () => {
    const flowInner = rule('.chat-messages__flow-inner')
    expect(flowInner).toMatch(/max-width:\s*var\(--chat-content-max-width,\s*48rem\)/)
    expect(flowInner).toMatch(/margin-inline:\s*auto/)

    const virtualList = rule('.chat-messages__virtual')
    expect(virtualList).toMatch(/max-width:\s*var\(--chat-content-max-width,\s*48rem\)/)
    expect(virtualList).toMatch(/margin-inline:\s*auto/)

    const composerInner = rule('.chat-panel__composer-inner')
    expect(composerInner).toMatch(/max-width:\s*var\(--chat-content-max-width,\s*48rem\)/)

    const tier1Notice = rule('.chat-tier1-notice')
    expect(tier1Notice).toMatch(/max-width:\s*var\(--chat-content-max-width,\s*48rem\)/)
  })

  it('freezes reading column widths via per-container variables while inspector drags', () => {
    // 根容器裁剪溢出：冻结宽度超出收缩后的主区时不产生横向滚动
    expect(rule('.chat-panel--reading-width-frozen')).toMatch(/overflow:\s*hidden/)
    // 阅读柱与 Composer 冻结到各自容器的实际渲染宽度，而非单一 max-width
    expect(rule('.chat-panel--reading-width-frozen .chat-messages__flow-inner'))
      .toMatch(/width:\s*var\(--chat-frozen-flow-width,\s*100%\)/)
    expect(rule('.chat-panel--reading-width-frozen .chat-panel__composer-inner'))
      .toMatch(/width:\s*var\(--chat-frozen-composer-width,\s*100%\)/)
  })
})
