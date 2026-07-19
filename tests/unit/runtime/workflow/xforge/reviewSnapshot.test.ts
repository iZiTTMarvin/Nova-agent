import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  buildFileEffectReceipt,
  hashContent,
  recordFileEffect
} from '../../../../../src/runtime/workflow/v2/EffectReceipt'
import {
  buildXForgeReviewSnapshot,
  captureXForgeWorkspaceBaseline,
  isPathAllowedByChangeScope,
  resolveXForgeReviewTarget
} from '../../../../../src/runtime/workflow/xforge'
import { hashWorkspaceFile } from '../../../../../src/runtime/workflow/xforge/workspaceBaseline'

describe('changeScope matcher', () => {
  it('目录前缀与 /** 通配一致，供写入授权与 Review 共用', () => {
    expect(isPathAllowedByChangeScope('src/a.ts', ['src'])).toBe(true)
    expect(isPathAllowedByChangeScope('src/a.ts', ['src/**'])).toBe(true)
    expect(isPathAllowedByChangeScope('other/a.ts', ['src'])).toBe(false)
    expect(isPathAllowedByChangeScope('package.json', ['package.json'])).toBe(true)
  })
})

describe('XForge Review Snapshot 权威来源', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-review-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"demo"}\n', 'utf8')
    fs.writeFileSync(path.join(workspaceRoot, 'clean.ts'), 'export const clean = true\n', 'utf8')
    git('add', 'package.json', 'clean.ts')
    git('commit', '-qm', 'init')
  })

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('缺少 baseline 时 fail closed', async () => {
    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-1',
      baseline: null,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })
    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/Baseline/)
  })

  it('resolveXForgeReviewTarget：reviewOnly / code-ready 走 existing_worktree', () => {
    expect(resolveXForgeReviewTarget({ reviewOnly: true }).kind).toBe('existing_worktree')
    expect(resolveXForgeReviewTarget({ reviewOnly: false, codeReadyForTest: true }).kind)
      .toBe('existing_worktree')
    expect(resolveXForgeReviewTarget({ reviewOnly: false }).kind).toBe('run_effects')
  })

  it('run_effects：只审查 receipt∩changeScope，用户预脏未触碰文件不进入快照', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'user-dirty.ts'), 'user = 1\n', 'utf8')
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    expect(baseline.entries.some(entry => entry.path === 'user-dirty.ts')).toBe(true)

    commitCreateEffect({
      runId: 'run-effects',
      relativePath: 'src/owned.ts',
      content: 'export const owned = 1\n'
    })

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-effects',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })

    expect(result.blockedReason).toBeUndefined()
    expect(result.snapshot?.targetKind).toBe('run_effects')
    expect(result.snapshot?.changedFiles).toEqual(['src/owned.ts'])
    expect(result.snapshot?.changedFiles).not.toContain('user-dirty.ts')
    expect(result.snapshot?.files[0]?.beforeContent).toBe('')
    expect(result.snapshot?.files[0]?.content).toContain('owned = 1')
  })

  it('run_effects：预脏后被 XForge 修改时，diff 起点是 receipt 备份而非 HEAD', async () => {
    const target = path.join(workspaceRoot, 'tracked.ts')
    fs.writeFileSync(target, 'export const value = 1\n', 'utf8')
    git('add', 'tracked.ts')
    git('commit', '-qm', 'add tracked')
    fs.writeFileSync(target, 'export const value = user\n', 'utf8')
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)

    const before = 'export const value = user\n'
    const after = 'export const value = xforge\n'
    commitModifyEffect({
      runId: 'run-predirty',
      relativePath: 'tracked.ts',
      beforeContent: before,
      afterContent: after
    })

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-predirty',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['tracked.ts']
    })

    expect(result.blockedReason).toBeUndefined()
    expect(result.snapshot?.files[0]?.beforeContent).toContain('user')
    expect(result.snapshot?.files[0]?.content).toContain('xforge')
    expect(result.snapshot?.diff).toContain('user')
    expect(result.snapshot?.diff).not.toMatch(/value = 1/)
  })

  it('run_effects：无 receipt 的并发漂移会阻塞', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    fs.writeFileSync(path.join(workspaceRoot, 'drift.ts'), 'drift\n', 'utf8')

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-drift',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src', 'drift.ts']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/无 EffectReceipt 的工作区漂移/)
  })

  it('run_effects：receipt 越过 changeScope 时安全阻塞', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    commitCreateEffect({
      runId: 'run-scope',
      relativePath: 'outside/secret.ts',
      content: 'nope\n'
    })

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-scope',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/越过 changeScope/)
  })

  it('run_effects：prepared receipt 未收口时阻塞', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    const abs = path.join(workspaceRoot, 'src', 'pending.ts')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'pending\n', 'utf8')
    const receipt = buildFileEffectReceipt({
      workspaceRoot,
      runId: 'run-prepared',
      absPath: abs,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent('pending\n'),
      effectId: 'effect-prepared',
      status: 'prepared'
    })
    recordFileEffect(workspaceRoot, receipt)

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-prepared',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/prepared/)
  })

  it('run_effects：当前哈希与 afterHash 不符时判定并发漂移', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    commitCreateEffect({
      runId: 'run-hash',
      relativePath: 'src/a.ts',
      content: 'v1\n'
    })
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'a.ts'), 'tampered\n', 'utf8')

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-hash',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/并发漂移/)
  })

  it('run_effects：敏感文件在读取前阻塞', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    commitCreateEffect({
      runId: 'run-env',
      relativePath: '.env',
      content: 'SECRET=1\n'
    })

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-env',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['.env', '*']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/敏感文件/)
  })

  it('existing_worktree：只审查冻结脏集，冻结后漂移会阻塞', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'pre.ts'), 'before\n', 'utf8')
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)

    const ok = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-existing',
      baseline,
      reviewTarget: { kind: 'existing_worktree' },
      changeScope: null
    })
    expect(ok.blockedReason).toBeUndefined()
    expect(ok.snapshot?.targetKind).toBe('existing_worktree')
    expect(ok.snapshot?.changedFiles).toEqual(['pre.ts'])

    fs.writeFileSync(path.join(workspaceRoot, 'pre.ts'), 'changed-after-freeze\n', 'utf8')
    const drifted = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-existing',
      baseline,
      reviewTarget: { kind: 'existing_worktree' },
      changeScope: null
    })
    expect(drifted.snapshot).toBeUndefined()
    expect(drifted.blockedReason).toMatch(/冻结路径已漂移/)
  })

  it('run_effects：baseline 后 HEAD 漂移时拒绝复用旧测试与审查归属', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    fs.writeFileSync(path.join(workspaceRoot, 'concurrent.ts'), 'concurrent\n', 'utf8')
    git('add', 'concurrent.ts')
    git('commit', '-qm', 'concurrent change')
    commitCreateEffect({
      runId: 'run-head-drift',
      relativePath: 'src/owned.ts',
      content: 'owned\n'
    })

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-head-drift',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })

    expect(result.snapshot).toBeUndefined()
    expect(result.blockedReason).toMatch(/HEAD 已漂移/)
  })

  it('二进制和超限正文不能以 omitted 内容自动通过 Review Gate', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    const binaryPath = path.join(workspaceRoot, 'src', 'binary.dat')
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    const binary = Buffer.from([1, 0, 2])
    fs.writeFileSync(binaryPath, binary)
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId: 'run-binary',
      absPath: binaryPath,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent(binary),
      effectId: 'binary',
      sequence: 1,
      status: 'committed'
    }))

    const binaryResult = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-binary',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })
    expect(binaryResult.blockedReason).toMatch(/二进制/)

    fs.rmSync(binaryPath)
    const oversizedPath = path.join(workspaceRoot, 'src', 'oversized.txt')
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 97)
    fs.writeFileSync(oversizedPath, oversized)
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId: 'run-oversized',
      absPath: oversizedPath,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent(oversized),
      effectId: 'oversized',
      sequence: 1,
      status: 'committed'
    }))
    const oversizedResult = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: 'run-oversized',
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })
    expect(oversizedResult.blockedReason).toMatch(/安全上限|字节上限/)
  })

  it('预脏敏感文件在 baseline 哈希前即 fail closed', async () => {
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'SECRET=never-hash\n', 'utf8')
    await expect(captureXForgeWorkspaceBaseline(workspaceRoot)).rejects.toThrow(/敏感文件.*拒绝读取/)
  })

  it('canonical path 校验拒绝父目录 junction 逃逸工作区', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n', 'utf8')
      fs.symlinkSync(outside, path.join(workspaceRoot, 'linked'), 'junction')
      await expect(hashWorkspaceFile(workspaceRoot, 'linked/secret.txt')).rejects.toThrow(/junction 越界/)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('同毫秒多次写入按持久化 sequence 还原 Receipt 因果顺序', async () => {
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    const runId = 'run-sequence'
    const target = path.join(workspaceRoot, 'src', 'multi.ts')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'v1\n', 'utf8')
    const created = buildFileEffectReceipt({
      workspaceRoot,
      runId,
      absPath: target,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent('v1\n'),
      effectId: 'z-created',
      sequence: 1,
      status: 'committed'
    })
    created.at = 100
    recordFileEffect(workspaceRoot, created)

    const backupRef = 'effect-backups/multi.bak'
    const backup = path.join(workspaceRoot, '.nova', 'compose', 'runs', runId, backupRef)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.writeFileSync(backup, 'v1\n', 'utf8')
    fs.writeFileSync(target, 'v2\n', 'utf8')
    const modified = buildFileEffectReceipt({
      workspaceRoot,
      runId,
      absPath: target,
      action: 'modify',
      beforeHash: hashContent('v1\n'),
      beforeCheckpointRef: backupRef,
      afterHash: hashContent('v2\n'),
      effectId: 'a-modified',
      sequence: 2,
      status: 'committed'
    })
    modified.at = 100
    recordFileEffect(workspaceRoot, modified)

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId,
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['src']
    })
    expect(result.blockedReason).toBeUndefined()
    expect(result.snapshot?.files[0]).toMatchObject({ beforeContent: '', content: 'v2\n' })
  })

  it('删除 Receipt 使用写前备份生成可审查快照，缺失备份则阻塞', async () => {
    const target = path.join(workspaceRoot, 'delete-me.ts')
    fs.writeFileSync(target, 'before delete\n', 'utf8')
    git('add', 'delete-me.ts')
    git('commit', '-qm', 'add delete target')
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    const runId = 'run-delete'
    const backupRef = 'effect-backups/delete-me.bak'
    const backup = path.join(workspaceRoot, '.nova', 'compose', 'runs', runId, backupRef)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.writeFileSync(backup, 'before delete\n', 'utf8')
    fs.rmSync(target)
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId,
      absPath: target,
      action: 'delete',
      beforeHash: hashContent('before delete\n'),
      beforeCheckpointRef: backupRef,
      afterHash: null,
      effectId: 'delete',
      sequence: 1,
      status: 'committed'
    }))

    const result = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId,
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['delete-me.ts']
    })
    expect(result.blockedReason).toBeUndefined()
    expect(result.snapshot?.files[0]).toMatchObject({
      beforeContent: 'before delete\n',
      content: ''
    })

    fs.writeFileSync(target, 'modified\n', 'utf8')
    const missingRun = 'run-missing-backup'
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId: missingRun,
      absPath: target,
      action: 'modify',
      beforeHash: hashContent('before delete\n'),
      beforeCheckpointRef: 'effect-backups/missing.bak',
      afterHash: hashContent('modified\n'),
      effectId: 'missing',
      sequence: 1,
      status: 'committed'
    }))
    const missing = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: missingRun,
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['delete-me.ts']
    })
    expect(missing.blockedReason).toMatch(/备份缺失|备份缺失或越界/)

    const corruptRun = 'run-corrupt-backup'
    const corruptBackupRef = 'effect-backups/corrupt.bak'
    const corruptBackup = path.join(
      workspaceRoot,
      '.nova',
      'compose',
      'runs',
      corruptRun,
      corruptBackupRef
    )
    fs.mkdirSync(path.dirname(corruptBackup), { recursive: true })
    fs.writeFileSync(corruptBackup, 'wrong before content\n', 'utf8')
    recordFileEffect(workspaceRoot, buildFileEffectReceipt({
      workspaceRoot,
      runId: corruptRun,
      absPath: target,
      action: 'modify',
      beforeHash: hashContent('before delete\n'),
      beforeCheckpointRef: corruptBackupRef,
      afterHash: hashContent('modified\n'),
      effectId: 'corrupt',
      sequence: 1,
      status: 'committed'
    }))
    const corrupt = await buildXForgeReviewSnapshot({
      workspaceRoot,
      runId: corruptRun,
      baseline,
      reviewTarget: { kind: 'run_effects' },
      changeScope: ['delete-me.ts']
    })
    expect(corrupt.blockedReason).toMatch(/备份哈希不符/)
  })

  it('无 HEAD 仓库仍使用冻结脏集，不回退到 git diff HEAD', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-no-head-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
      fs.writeFileSync(path.join(root, 'draft.ts'), 'draft\n', 'utf8')
      const baseline = await captureXForgeWorkspaceBaseline(root)
      expect(baseline.headOid).toBeNull()
      const result = await buildXForgeReviewSnapshot({
        workspaceRoot: root,
        runId: 'run-no-head',
        baseline,
        reviewTarget: { kind: 'existing_worktree' },
        changeScope: null
      })
      expect(result.blockedReason).toBeUndefined()
      expect(result.snapshot?.changedFiles).toEqual(['draft.ts'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('baseline 一经捕获后字段完整，且不含 runtime 产物路径', async () => {
    fs.mkdirSync(path.join(workspaceRoot, '.nova', 'compose', 'runs', 'x'), { recursive: true })
    fs.writeFileSync(
      path.join(workspaceRoot, '.nova', 'compose', 'runs', 'x', 'note.md'),
      'runtime\n',
      'utf8'
    )
    fs.writeFileSync(path.join(workspaceRoot, 'dirty.ts'), 'x\n', 'utf8')
    const baseline = await captureXForgeWorkspaceBaseline(workspaceRoot)
    expect(baseline.schemaVersion).toBe(1)
    expect(baseline.headOid).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline.entries.map(entry => entry.path)).toEqual(['dirty.ts'])
  })

  function commitCreateEffect(params: {
    runId: string
    relativePath: string
    content: string
  }): void {
    const abs = path.join(workspaceRoot, ...params.relativePath.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, params.content, 'utf8')
    const receipt = buildFileEffectReceipt({
      workspaceRoot,
      runId: params.runId,
      absPath: abs,
      action: 'create',
      beforeHash: null,
      beforeCheckpointRef: null,
      afterHash: hashContent(params.content),
      effectId: `create-${params.relativePath.replace(/[\\/]/g, '-')}`,
      status: 'committed'
    })
    recordFileEffect(workspaceRoot, receipt)
  }

  function commitModifyEffect(params: {
    runId: string
    relativePath: string
    beforeContent: string
    afterContent: string
  }): void {
    const abs = path.join(workspaceRoot, ...params.relativePath.split('/'))
    const runRoot = path.join(workspaceRoot, '.nova', 'compose', 'runs', params.runId)
    const backupRel = `effect-backups/${params.relativePath.replace(/[\\/]/g, '_')}.bak`
    fs.mkdirSync(path.join(runRoot, 'effect-backups'), { recursive: true })
    fs.writeFileSync(path.join(runRoot, backupRel), params.beforeContent, 'utf8')
    fs.writeFileSync(abs, params.afterContent, 'utf8')
    const receipt = buildFileEffectReceipt({
      workspaceRoot,
      runId: params.runId,
      absPath: abs,
      action: 'modify',
      beforeHash: hashContent(params.beforeContent),
      beforeCheckpointRef: backupRel,
      afterHash: hashContent(params.afterContent),
      effectId: `modify-${params.relativePath.replace(/[\\/]/g, '-')}`,
      status: 'committed'
    })
    recordFileEffect(workspaceRoot, receipt)
  }

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: workspaceRoot, windowsHide: true })
  }
})
