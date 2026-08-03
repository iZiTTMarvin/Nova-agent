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
  it('keeps messages and composer in one flex column', () => {
    expect(rule('.chat-panel')).toMatch(/display:\s*flex/)
    expect(rule('.chat-panel')).toMatch(/flex-direction:\s*column/)
    expect(rule('.chat-messages')).toMatch(/flex:\s*1/)
    expect(rule('.chat-panel__composer-area')).toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('does not overlay the composer on message content', () => {
    const composerRule = rule('.chat-panel__composer-area')
    expect(composerRule).toMatch(/position:\s*relative/)
    expect(composerRule).not.toMatch(/position:\s*(?:absolute|fixed)/)
    expect(composerRule).not.toMatch(/\bbottom\s*:/)
  })

  it('scroll-to-bottom floats above composer without claiming document flow', () => {
    const scrollRule = rule('.chat-scroll-to-bottom')
    expect(scrollRule).toMatch(/position:\s*absolute/)
    expect(scrollRule).toMatch(/bottom:\s*100%/)
    expect(scrollRule).toMatch(/background:\s*var\(--bg-card\)/)
    expect(scrollRule).toMatch(/box-shadow:/)
    expect(rule('.chat-panel__composer-inner')).toMatch(/position:\s*relative/)
  })
})
