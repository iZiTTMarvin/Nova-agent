import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendJournalSync,
  journalKeyBase,
  loadJournal
} from '../../../../src/runtime/workflow/state/journal'
import { ensureRunDir, runJournalPath } from '../../../../src/runtime/workflow/state/paths'

describe('workflow journal', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'nova-wf-journal-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('内容哈希与对象字段顺序、工具顺序无关', () => {
    const a = journalKeyBase('prompt', {
      agentType: 'review',
      model: 'm',
      schema: { b: 2, a: 1 },
      phase: 'review',
      tools: ['read', 'grep']
    })
    const b = journalKeyBase('prompt', {
      tools: ['grep', 'read'],
      phase: 'review',
      schema: { a: 1, b: 2 },
      model: 'm',
      agentType: 'review'
    })
    expect(a).toBe(b)
  })

  it('会影响执行的 tools、isolation、timeoutMs 都参与哈希', () => {
    const base = journalKeyBase('prompt', { agentType: 'general' })
    expect(journalKeyBase('prompt', { agentType: 'general', tools: ['read'] })).not.toBe(base)
    expect(journalKeyBase('prompt', { agentType: 'general', isolation: 'readonly' })).not.toBe(base)
    expect(journalKeyBase('prompt', { agentType: 'general', timeoutMs: 60_000 })).not.toBe(base)
  })

  it('只加载成功 agent 结果，并把下一次 pass 单调递增', () => {
    appendJournalSync(workspaceRoot, 'run-1', [
      { t: 'agent', key: 'a:0', result: { ok: true }, pass: 1 },
      { t: 'agent', key: 'b:0', result: 'done', pass: 2 }
    ])

    const loaded = loadJournal(workspaceRoot, 'run-1')
    expect(loaded.results.get('a:0')).toEqual({ ok: true })
    expect(loaded.results.get('b:0')).toBe('done')
    expect(loaded.pass).toBe(3)
    expect(runJournalPath(workspaceRoot, 'run-1')).toContain(
      join('.nova', 'workflow', 'runs', 'run-1')
    )
  })

  it('崩溃留下的半截尾行被跳过，已提交结果仍可恢复', () => {
    ensureRunDir(workspaceRoot, 'corrupt')
    appendJournalSync(workspaceRoot, 'corrupt', [
      { t: 'agent', key: 'safe:0', result: 'persisted', pass: 1 }
    ])
    appendFileSync(runJournalPath(workspaceRoot, 'corrupt'), '{"t":"agent",broken', 'utf-8')

    const loaded = loadJournal(workspaceRoot, 'corrupt')
    expect(loaded.results).toEqual(new Map([['safe:0', 'persisted']]))
  })

  it('runId 路径逃逸被拒绝', () => {
    expect(() => loadJournal(workspaceRoot, '../outside')).toThrow(/invalid workflow runId/)
  })
})
