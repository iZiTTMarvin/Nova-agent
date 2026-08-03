import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('content-visibility（static 历史消息）', () => {
  const cssPath = path.resolve(
    __dirname,
    '../../../src/renderer/features/chat/ChatPanel.css'
  )
  const css = fs.readFileSync(cssPath, 'utf8')

  it('交互正文保持可测量，避免折叠内容与虚拟列表高度失配', () => {
    expect(css).toMatch(/\.chat-msg__static-body\s*\{[^}]*content-visibility:\s*visible/)
  })

  it('不再为交互正文声明固定 intrinsic 高度', () => {
    const rule = css.match(/\.chat-msg__static-body\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).not.toContain('contain-intrinsic-size')
  })
})
