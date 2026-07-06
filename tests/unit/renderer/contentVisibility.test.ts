import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 任务 3 验收：static 层 content-visibility 样式契约（实现已在 ChatPanel.css + MessageItem）。
 */
describe('content-visibility（static 历史消息）', () => {
  const cssPath = path.resolve(
    __dirname,
    '../../../src/renderer/features/chat/ChatPanel.css'
  )
  const css = fs.readFileSync(cssPath, 'utf8')

  it('.chat-msg__static-body 含 content-visibility: auto', () => {
    expect(css).toMatch(/\.chat-msg__static-body\s*\{[^}]*content-visibility:\s*auto/)
  })

  it('.chat-msg__static-body 含 contain-intrinsic-size 估计高度', () => {
    expect(css).toMatch(/\.chat-msg__static-body\s*\{[^}]*contain-intrinsic-size:\s*auto\s+120px/)
  })
})
