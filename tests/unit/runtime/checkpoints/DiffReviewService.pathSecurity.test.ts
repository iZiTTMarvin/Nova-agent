import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { DiffReviewService } from '../../../../src/runtime/checkpoints/DiffReviewService'

describe('DiffReviewService 路径安全', () => {
  let tmpDir: string
  let workspaceRoot: string
  let store: SessionStore
  let service: DiffReviewService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-diff-sec-'))
    workspaceRoot = path.join(tmpDir, 'workspace')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    store = new SessionStore(tmpDir)
    service = new DiffReviewService(store)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejectAllFiles 拒绝含 .. 的相对路径', () => {
    const session = store.create(workspaceRoot)
    expect(() => service.rejectAllFiles(session.id, 'msg_x', ['../../etc/passwd'])).toThrow(/路径越界/)
  })

  it('rejectFile 拒绝绝对路径', () => {
    const session = store.create(workspaceRoot)
    const abs = path.join(workspaceRoot, '..', 'escape.txt')
    expect(() => service.rejectFile(session.id, 'msg_x', abs)).toThrow(/路径越界/)
  })
})
