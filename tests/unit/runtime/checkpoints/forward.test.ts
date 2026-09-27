import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  revertWorkspaceForMessageIds,
  applyForwardForMessageIds
} from '../../../../src/runtime/checkpoints/restore'
import {
  writeManifest,
  getFilesDir,
  getForwardDir
} from '../../../../src/runtime/checkpoints/manifest'
import type { CheckpointManifest } from '../../../../src/runtime/checkpoints/types'

let tmpDir: string
let checkpointRoot: string
let workspaceRoot: string
const sessionId = 'sess_forward'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-forward-test-'))
  checkpointRoot = path.join(tmpDir, 'checkpoints')
  workspaceRoot = path.join(tmpDir, 'workspace')
  fs.mkdirSync(checkpointRoot, { recursive: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeWorkspace(relPath: string, content: string): void {
  const abs = path.join(workspaceRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

function readWorkspace(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(workspaceRoot, relPath), 'utf8')
  } catch {
    return null
  }
}

function createManifestWithSnapshots(
  messageId: string,
  opts: {
    before: Record<string, string>
    after: Record<string, string>
    createdFiles?: string[]
    modifiedFiles?: string[]
    forwardCaptured?: boolean
  }
): CheckpointManifest {
  const manifest: CheckpointManifest = {
    sessionId,
    messageId,
    workspaceRoot,
    createdFiles: opts.createdFiles ?? [],
    modifiedFiles: opts.modifiedFiles ?? [],
    deletedFiles: [],
    status: 'active',
    createdAt: Date.now(),
    forwardCaptured: opts.forwardCaptured ?? true
  }
  writeManifest(checkpointRoot, manifest)

  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
  const forwardDir = getForwardDir(checkpointRoot, sessionId, messageId)
  for (const [rel, content] of Object.entries(opts.before)) {
    const p = path.join(filesDir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
  }
  for (const [rel, content] of Object.entries(opts.after)) {
    const p = path.join(forwardDir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
  }
  return manifest
}

describe('Tier 2 forward 快照', () => {
  it('revertWorkspaceForMessageIds 应还原工作区且保留 checkpoint 目录', () => {
    writeWorkspace('a.txt', 'branch-b')
    const manifest = createManifestWithSnapshots('a1', {
      before: { 'a.txt': 'base' },
      after: { 'a.txt': 'branch-b' },
      modifiedFiles: ['a.txt']
    })

    revertWorkspaceForMessageIds(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      new Set(['a1']),
      [manifest]
    )

    expect(readWorkspace('a.txt')).toBe('base')
    expect(fs.existsSync(getFilesDir(checkpointRoot, sessionId, 'a1'))).toBe(true)
    expect(fs.existsSync(getForwardDir(checkpointRoot, sessionId, 'a1'))).toBe(true)
  })

  it('applyForwardForMessageIds 应把 forward 快照写回工作区', () => {
    writeWorkspace('a.txt', 'base')
    const manifest = createManifestWithSnapshots('a1', {
      before: { 'a.txt': 'base' },
      after: { 'a.txt': 'branch-a' },
      modifiedFiles: ['a.txt']
    })

    const result = applyForwardForMessageIds(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      ['a1'],
      [manifest]
    )

    expect(result.incompleteMessageIds).toHaveLength(0)
    expect(readWorkspace('a.txt')).toBe('branch-a')
  })

  it('缺少 forward 快照时应标记 incomplete', () => {
    writeWorkspace('a.txt', 'base')
    const manifest: CheckpointManifest = {
      sessionId,
      messageId: 'a_old',
      workspaceRoot,
      modifiedFiles: ['a.txt'],
      createdFiles: [],
      deletedFiles: [],
      status: 'active',
      createdAt: Date.now()
    }
    writeManifest(checkpointRoot, manifest)
    const filesDir = getFilesDir(checkpointRoot, sessionId, 'a_old')
    fs.mkdirSync(filesDir, { recursive: true })
    fs.writeFileSync(path.join(filesDir, 'a.txt'), 'base', 'utf8')

    const result = applyForwardForMessageIds(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      ['a_old'],
      [manifest]
    )

    expect(result.incompleteMessageIds).toEqual(['a_old'])
    expect(readWorkspace('a.txt')).toBe('base')
  })

  it('同一消息第二个 forward 文件缺失时整消息不应用，工作区保持 base', () => {
    writeWorkspace('a.txt', 'base')
    writeWorkspace('b.txt', 'base')
    const manifest: CheckpointManifest = {
      sessionId,
      messageId: 'm_gap_file',
      workspaceRoot,
      modifiedFiles: ['a.txt', 'b.txt'],
      createdFiles: [],
      deletedFiles: [],
      status: 'active',
      createdAt: Date.now(),
      forwardCaptured: true
    }
    writeManifest(checkpointRoot, manifest)
    const forwardDir = getForwardDir(checkpointRoot, sessionId, 'm_gap_file')
    fs.mkdirSync(forwardDir, { recursive: true })
    // 只写第一个文件的 forward 快照，制造半条消息缺口
    fs.writeFileSync(path.join(forwardDir, 'a.txt'), 'branch-a', 'utf8')

    const result = applyForwardForMessageIds(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      ['m_gap_file'],
      [manifest]
    )

    expect(result.incompleteMessageIds).toEqual(['m_gap_file'])
    expect(readWorkspace('a.txt')).toBe('base')
    expect(readWorkspace('b.txt')).toBe('base')
  })

  it('中间消息缺 forward 时，后续消息不再跨过缺口应用', () => {
    writeWorkspace('a.txt', 'base')
    writeWorkspace('b.txt', 'base')
    const gap: CheckpointManifest = {
      sessionId,
      messageId: 'gap_msg',
      workspaceRoot,
      modifiedFiles: ['a.txt'],
      createdFiles: [],
      deletedFiles: [],
      status: 'active',
      createdAt: 10
    }
    writeManifest(checkpointRoot, gap)
    const later = createManifestWithSnapshots('later_msg', {
      before: { 'b.txt': 'base' },
      after: { 'b.txt': 'later' },
      modifiedFiles: ['b.txt']
    })
    later.createdAt = 20

    const result = applyForwardForMessageIds(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      ['gap_msg', 'later_msg'],
      [gap, later]
    )

    expect(result.incompleteMessageIds).toEqual(['gap_msg', 'later_msg'])
    expect(readWorkspace('a.txt')).toBe('base')
    expect(readWorkspace('b.txt')).toBe('base')
  })
})
