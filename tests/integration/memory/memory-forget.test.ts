import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BetterSqliteMemoryDb, openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { LegacyMemoryMigrator } from '@runtime/memory/migration/LegacyMemoryMigrator'
import { MemoryEntryStore } from '@runtime/memory/markdown/MemoryEntryStore'
import { MemoryIndex } from '@runtime/memory/index/MemoryIndex'
import { MemoryForgetter } from '@runtime/memory/forget/MemoryForgetter'
import { memoryFileFingerprint } from '@runtime/memory/markdown/atomicFile'
import { computeLegacyWorkspaceHashes, getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { renderMemorySnapshot } from '@runtime/memory/snapshot/renderMemorySnapshot'
import { SystemPromptBuilder } from '@runtime/agent/promptBuilder/SystemPromptBuilder'
import { SessionStore } from '@runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '@runtime/sessions/SessionIndexHost'
import { createSessionSnapshotForgetCopy } from '@main/services/SessionMemorySnapshot'
import type { MemorySnapshotRecord } from '@runtime/sessions/types'

const TARGET = 'FORGET-ME 机密偏好 7f3a'
const OLD = 'FORGET-ME 旧版本 9c1e'
const UNRELATED = 'KEEP-ME 无关偏好 5x2'
const NOW = new Date(2026, 9, 8, 12).getTime()

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : []
})

describe('complete memory forgetting', () => {
  let root = ''
  let db: BetterSqliteMemoryDb | null = null
  afterEach(() => {
    db?.close(); db = null
    resetSessionIndexHostForTests()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('遗忘清除事实源、索引残留、整理备份、迁移备份与全部会话快照副本', () => {
    root = mkdtempSync(join(tmpdir(), 'nova-forget-'))
    const memoryRoot = join(root, 'memory')
    const workspace = join(root, 'workspace')
    mkdirSync(memoryRoot, { recursive: true })

    // 旧库：目标记录、无关记录、被目标取代的旧版本
    db = new BetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    db.exec(readFileSync(join(process.cwd(), 'tests/fixtures/memory/legacy-v2.sql'), 'utf8'))
    const legacyScope = computeLegacyWorkspaceHashes(workspace)[0]
    const addLegacy = (id: string, content: string, status: string, supersedes: string | null = null): void => {
      db!.prepare(`INSERT INTO memory_records (id,scope_kind,scope_id,kind,memory_key,content,status,confidence,explicitness,source_type,valid_from,valid_to,supersedes_id,created_at,updated_at,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 'project', legacyScope, 'preference', `key.${id}`, content, status, .9, 'user_explicit', 'user_message', 1000, status === 'superseded' ? 2000 : null, supersedes, 1000, 2000, 3000)
      db!.prepare('INSERT INTO memory_evidence VALUES (?,?,?,?,?,?,?,?)').run(`e-${id}`, id, 's1', 'm1', legacyScope, 'user_message', '证据摘录', 3000)
    }
    addLegacy('leg_old', OLD, 'superseded')
    addLegacy('leg_target', TARGET, 'active', 'leg_old')
    addLegacy('leg_unrelated', UNRELATED, 'active')
    db.close()
    db = null

    const migrator = new LegacyMemoryMigrator(memoryRoot, () => NOW)
    migrator.backup()
    db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    migrator.migrate(db)
    const index = new MemoryIndex(db)
    const store = new MemoryEntryStore(memoryRoot, {
      now: () => NOW,
      onIndexChanged: (scope, entries) => index.rebuild(scope, entries),
      readPreviousEntries: scope => index.readPreviousEntries(scope)
    })
    expect(migrator.claim(workspace, store)).toBe(3)
    const scope = { scopeKind: 'project' as const, scopeId: store.registerWorkspace(workspace) }
    const projectDir = getProjectMemoryDir(memoryRoot, scope.scopeId, workspace)
    const target = store.list(scope).find(entry => entry.record.content === TARGET)!
    const unrelated = store.list(scope).find(entry => entry.record.content === UNRELATED)!
    const old = store.list(scope, 'archive').find(entry => entry.record.content === OLD)!

    // 一条 observed 冗余条目用于触发 organize 备份
    const extra = store.insert({ id: 'm_aabbccddee', scope, kind: 'preference', memoryKey: 'extra', content: 'KEEP-ME 冗余条目 e4f1',
      status: 'active', confidence: .6, explicitness: 'observed', sourceType: 'tool_call' })
    store.organize(scope, 'preferences.md', { merge: [], retire: [extra.id] }, memoryFileFingerprint(join(projectDir, 'preferences.md')))

    // 两个已保存会话 + 一个草稿：快照与冻结 prompt 都含目标
    const sessions = new SessionStore(root)
    const rendered = renderMemorySnapshot({ capturedAt: NOW, project: store.snapshotScope(scope) })
    expect(rendered.text).toContain(TARGET)
    const snapshot: MemorySnapshotRecord = { formatVersion: 1, capturedAt: NOW, text: rendered.text, reason: 'captured',
      globalCoreCount: rendered.globalCoreCount, projectCoreCount: rendered.projectCoreCount, omittedCoreCount: rendered.omittedCoreCount }
    const frozen = SystemPromptBuilder.build({ agentRole: 'Nova', toolSummary: 'tools', memorySnapshot: rendered.text })
    const s1 = sessions.create(workspace)
    s1.memorySnapshot = snapshot
    s1.frozenSystemPrompt = frozen
    sessions.save(s1)
    sessions.appendMessage(s1.id, { id: 'u1', role: 'user', content: '普通问题', timestamp: NOW })
    sessions.appendMessage(s1.id, { id: 'a1', role: 'assistant', content: '普通回答', timestamp: NOW + 1 })
    sessions.recoverAssistantMessage(s1.id, { id: 'a2', role: 'assistant', content: '恢复草稿', timestamp: NOW + 2 }, 'u1')
    const s2 = sessions.create(workspace)
    s2.memorySnapshot = snapshot
    s2.frozenSystemPrompt = frozen
    sessions.save(s2)
    sessions.appendMessage(s2.id, { id: 'u2', role: 'user', content: '另一个问题', timestamp: NOW })
    const draft = sessions.create(workspace, 'default', { deferPersistence: true })
    draft.memorySnapshot = snapshot
    draft.frozenSystemPrompt = frozen
    sessions.save(draft)
    const stale = sessions.load(s2.id)!

    // 无快照旧会话：title 恰好等于被遗忘正文；s2 的备份文件 title 也含正文。
    // title 是普通字段而非快照行，遗忘不应失败，且两者原样保留。
    const legacy = sessions.create(workspace)
    legacy.title = TARGET
    sessions.save(legacy)
    const legacyBackupPath = join(root, 'sessions', s2.id, 'session.json.backup')
    writeFileSync(legacyBackupPath, JSON.stringify({ id: s2.id, title: `用户曾提到 ${TARGET}` }))
    const titleCarryingFiles = new Set([join(root, 'sessions', legacy.id, 'session.json'), legacyBackupPath])

    const forgetter = new MemoryForgetter({
      store,
      copies: [
        createSessionSnapshotForgetCopy(() => sessions),
        { label: '迁移备份', redact: f => migrator.redactBackups(f, path => new BetterSqliteMemoryDb(path)) }
      ],
      index
    })
    expect(forgetter.forget(scope, target.record.id)).toBe(true)

    // 原始字节核查：除合法保留正文 title 的文件外，临时 userData 下都不含目标与旧版本正文
    for (const file of walk(root)) {
      if (titleCarryingFiles.has(file)) continue
      const bytes = readFileSync(file)
      expect(bytes.includes(Buffer.from(TARGET, 'utf8')), file).toBe(false)
      expect(bytes.includes(Buffer.from(OLD, 'utf8')), file).toBe(false)
    }

    // 整理备份解码后也不含被遗忘内容，但无关字节保留
    const backupsDir = join(projectDir, '.backups')
    const backups = existsSync(backupsDir) ? readdirSync(backupsDir) : []
    expect(backups.length).toBeGreaterThan(0)
    let backupKeptUnrelated = false
    for (const name of backups) {
      const data = JSON.parse(readFileSync(join(backupsDir, name), 'utf8')) as { files: Record<string, string | null> }
      for (const encoded of Object.values(data.files)) {
        if (typeof encoded !== 'string') continue
        const decoded = Buffer.from(encoded, 'base64')
        expect(decoded.includes(Buffer.from(TARGET, 'utf8'))).toBe(false)
        expect(decoded.includes(Buffer.from(OLD, 'utf8'))).toBe(false)
        if (decoded.includes(Buffer.from(UNRELATED, 'utf8'))) backupKeptUnrelated = true
      }
    }
    expect(backupKeptUnrelated).toBe(true)

    // 事实源与迁移备份：无关记录仍在，目标已删
    const topics = readFileSync(join(projectDir, 'preferences.md'), 'utf8')
    expect(topics).toContain(UNRELATED)
    expect(topics).not.toContain(TARGET)
    expect(readFileSync(join(projectDir, 'archive.md'), 'utf8')).not.toContain(OLD)
    const bak = readFileSync(join(memoryRoot, 'memory.db.pre-markdown.bak'))
    expect(bak.includes(Buffer.from(UNRELATED, 'utf8'))).toBe(true)

    // 会话：快照与冻结 prompt 只剩无关内容，其他 prompt 层保留；recovery 副本同样被清理
    const restored = sessions.load(s1.id)!
    expect(restored.memorySnapshot?.text).toContain(UNRELATED)
    expect(restored.memorySnapshot?.text).not.toContain(TARGET)
    expect(restored.memorySnapshot?.projectCoreCount).toBe(1)
    expect(restored.frozenSystemPrompt).toContain('=== Agent Role ===')
    expect(restored.frozenSystemPrompt).toContain('=== Available Tools ===')
    expect(restored.frozenSystemPrompt).not.toContain(TARGET)
    const recoveryDir = join(root, 'sessions', s1.id, 'recovery')
    expect(readdirSync(recoveryDir).length).toBe(1)
    const recovered = JSON.parse(readFileSync(join(recoveryDir, readdirSync(recoveryDir)[0], 'session.json'), 'utf8')) as { memorySnapshot: { text: string | null } }
    expect(recovered.memorySnapshot.text).toContain(UNRELATED)
    expect(recovered.memorySnapshot.text).not.toContain(TARGET)
    // 草稿内存中的快照也被改写
    const draftReloaded = sessions.load(draft.id)!
    expect(draftReloaded.memorySnapshot?.text).not.toContain(TARGET)

    // 索引无残留命中：'机密' 只出现在目标正文里；'FORGET-ME' 因 OR 分词仍会命中无关记录
    expect(index.search(scope, '机密')).toEqual([])
    expect(index.search(scope, 'FORGET-ME').map(hit => hit.id)).toEqual([unrelated.record.id])
    expect(store.find(target.record.id)).toBeNull()
    expect(store.find(old.record.id)).toBeNull()
    expect(store.find(unrelated.record.id)).not.toBeNull()

    // 旧会话 title 恰好是被遗忘正文：不是快照行，不被改写
    expect(sessions.load(legacy.id)!.title).toBe(TARGET)
    const legacyBackup = JSON.parse(readFileSync(legacyBackupPath, 'utf8')) as { title: string }
    expect(legacyBackup.title).toContain(TARGET)

    // 遗忘前加载的旧会话对象再保存，不能把已遗忘内容写回
    sessions.save(stale)
    const reloaded = sessions.load(s2.id)!
    expect(reloaded.memorySnapshot?.text).toContain(UNRELATED)
    expect(reloaded.memorySnapshot?.text).not.toContain(TARGET)
    expect(reloaded.frozenSystemPrompt).not.toContain(TARGET)

    // 再次遗忘返回 false
    expect(forgetter.forget(scope, target.record.id)).toBe(false)
  })
})
