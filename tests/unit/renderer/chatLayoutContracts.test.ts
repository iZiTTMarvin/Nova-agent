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
})
