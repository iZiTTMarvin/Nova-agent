import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'

describe('SessionStore 路径安全', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sess-sec-'))
    store = new SessionStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('delete 拒绝 ../../ 逃逸 sessionId', () => {
    expect(() => store.delete('../../outside')).toThrow(/非法 sessionId|路径越界/)
    const outside = path.join(tmpDir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('load 对非法 sessionId 返回 null', () => {
    expect(store.load('../evil')).toBeNull()
  })

  it('合法 sess_ UUID 会话行为不变', () => {
    const session = store.create('/project/root')
    store.appendMessage(session.id, {
      id: 'msg_1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now()
    })
    const loaded = store.load(session.id)
    expect(loaded?.messages).toHaveLength(1)
    expect(loaded?.messages[0].content).toBe('hello')
  })
})
