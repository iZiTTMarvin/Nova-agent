/**
 * Composer 契约：
 * 1. 输入区使用 ChatComposerInput，不再用 TextArea + 手写包壳
 * 2. `/` 走官方 triggers，不再挂载 SkillAC 浮层
 * 3. 保留 hasHistory=false / pasteAsToken=false 的 Nova 语义决策
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPanelSource = readFileSync(
  new URL('../../../src/renderer/features/chat/ChatPanel.tsx', import.meta.url),
  'utf8'
)
const chatPanelCss = readFileSync(
  new URL('../../../src/renderer/features/chat/ChatPanel.css', import.meta.url),
  'utf8'
)

describe('Composer：ChatComposerInput 权威', () => {
  it('ChatPanel 使用 ChatComposerInput，不再 import TextArea', () => {
    expect(chatPanelSource).toContain("from '@astryxdesign/core/Chat'")
    expect(chatPanelSource).toMatch(/<ChatComposerInput[\s\S]*?handleRef=/)
    expect(chatPanelSource).not.toContain("from '@astryxdesign/core/TextArea'")
    expect(chatPanelSource).not.toContain('<TextArea')
  })

  it('ChatPanel 不再挂载 SkillAC 自研浮层', () => {
    expect(chatPanelSource).not.toContain("from '../skills/SkillAC'")
    expect(chatPanelSource).not.toContain('<SkillAC')
    expect(chatPanelSource).toContain("from '../skills/composerSkillTrigger'")
    expect(chatPanelSource).toMatch(/triggers=\{composerTriggers\}/)
  })

  it('关闭内置 history，并禁用 paste-as-token（保留明文粘贴）', () => {
    expect(chatPanelSource).toMatch(/hasHistory=\{false\}/)
    expect(chatPanelSource).toMatch(/pasteAsToken=\{false\}/)
  })

  it('Enter 由 onKeyDown 拥有，避免内置 onSubmit 拒发仍清框', () => {
    expect(chatPanelSource).toMatch(/onKeyDown=\{handleComposerKeyDown\}/)
    expect(chatPanelSource).not.toMatch(/onSubmit=\{/)
  })

  it('删除 textarea 尺寸 fork', () => {
    expect(chatPanelCss).not.toContain('chat-composer__textarea')
    expect(chatPanelCss).toContain('chat-composer__input')
  })
})

describe('Composer：/ trigger 菜单宽度封顶', () => {
  it('astryx-trigger-menu 有 max-width，避免长描述撑破边界', () => {
    const triggerCss = readFileSync(
      new URL('../../../src/renderer/features/skills/composerSkillTrigger.css', import.meta.url),
      'utf8'
    )
    expect(triggerCss).toMatch(/\.astryx-trigger-menu\s*\{[^}]*max-width:/)
  })
})
