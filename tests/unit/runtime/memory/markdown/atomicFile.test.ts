import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectMemoryFilePaths, cleanStaleMemoryTemps, memoryFileFingerprint, MemoryFileConflictError, writeFileAtomic } from '@runtime/memory/markdown/atomicFile'
import { MEMORY_FILE_WRITE_RETRIES, MEMORY_FILE_WRITE_RETRY_DELAY_MS } from '@runtime/memory/memoryConfig'

describe('atomic memory files', () => {
  let root: string
  let target: string
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'nova-atomic-'))
    target = join(root, 'projects', 'example', 'facts.md')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('fsyncs before rename and atomically replaces the file', () => {
    writeFileAtomic(target, 'before', { memoryRoot: root, expectedFingerprint: null })
    const fingerprint = memoryFileFingerprint(target)
    const calls: string[] = []
    writeFileAtomic(target, 'after', {
      memoryRoot: root, expectedFingerprint: fingerprint,
      fs: {
        fsyncSync: fd => { calls.push('sync'); fs.fsyncSync(fd) },
        renameSync: (from, to) => { calls.push('rename'); expect(from).not.toBe(to); fs.renameSync(from, to) }
      }
    })
    expect(calls).toEqual(['sync', 'rename'])
    expect(fs.readFileSync(target, 'utf8')).toBe('after')
    expect(fs.readdirSync(join(root, 'projects', 'example'))).toEqual(['facts.md'])
  })

  it('detects changes before writing and again before replacing', () => {
    writeFileAtomic(target, 'before', { memoryRoot: root })
    expect(() => writeFileAtomic(target, 'bad', { memoryRoot: root, expectedFingerprint: null })).toThrow(MemoryFileConflictError)
    const fingerprint = memoryFileFingerprint(target)
    expect(() => writeFileAtomic(target, 'bad', {
      memoryRoot: root, expectedFingerprint: fingerprint,
      fs: { fsyncSync: fd => { fs.fsyncSync(fd); fs.writeFileSync(target, 'external edited content') } }
    })).toThrow(MemoryFileConflictError)
    expect(fs.readFileSync(target, 'utf8')).toBe('external edited content')
    expect(fs.readdirSync(join(root, 'projects', 'example'))).toEqual(['facts.md'])
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries bounded Windows contention: %s', code => {
    const wait = vi.fn()
    let attempts = 0
    writeFileAtomic(target, 'saved', {
      memoryRoot: root, wait,
      fs: { renameSync: (from, to) => {
        attempts++
        if (attempts <= MEMORY_FILE_WRITE_RETRIES) throw Object.assign(new Error('busy'), { code })
        fs.renameSync(from, to)
      } }
    })
    expect(attempts).toBe(MEMORY_FILE_WRITE_RETRIES + 1)
    expect(wait.mock.calls).toEqual(Array.from({ length: MEMORY_FILE_WRITE_RETRIES }, () => [MEMORY_FILE_WRITE_RETRY_DELAY_MS]))
    expect(fs.readFileSync(target, 'utf8')).toBe('saved')
  })

  it('never directly overwrites after all rename retries fail', () => {
    writeFileAtomic(target, 'before', { memoryRoot: root })
    const rename = vi.fn(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })
    expect(() => writeFileAtomic(target, 'bad', { memoryRoot: root, wait: () => {}, fs: { renameSync: rename } })).toThrow('busy')
    expect(rename).toHaveBeenCalledTimes(MEMORY_FILE_WRITE_RETRIES + 1)
    expect(fs.readFileSync(target, 'utf8')).toBe('before')
    expect(fs.readdirSync(join(root, 'projects', 'example'))).toEqual(['facts.md'])
  })

  it('cleans up and leaves the target unchanged after fsync failure', () => {
    writeFileAtomic(target, 'before', { memoryRoot: root })
    expect(() => writeFileAtomic(target, 'bad', { memoryRoot: root, fs: { fsyncSync: () => { throw new Error('disk failed') } } })).toThrow('disk failed')
    expect(fs.readFileSync(target, 'utf8')).toBe('before')
    expect(fs.readdirSync(join(root, 'projects', 'example'))).toEqual(['facts.md'])
  })

  it('does not retry unrelated errors', () => {
    const wait = vi.fn()
    expect(() => writeFileAtomic(target, 'bad', { memoryRoot: root, wait, fs: { renameSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } } })).toThrow('disk full')
    expect(wait).not.toHaveBeenCalled()
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readdirSync(join(root, 'projects', 'example'))).toEqual([])
  })

  it('rejects paths outside the root and parent junctions', () => {
    expect(() => writeFileAtomic(join(root, '..', 'escaped.md'), 'bad', { memoryRoot: root })).toThrow('escapes')
    if (process.platform === 'win32') expect(() => writeFileAtomic('Z:\\escaped.md', 'bad', { memoryRoot: root })).toThrow('escapes')
    const external = fs.mkdtempSync(join(tmpdir(), 'nova-external-'))
    try {
      fs.symlinkSync(external, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => writeFileAtomic(join(root, 'linked', 'facts.md'), 'bad', { memoryRoot: root })).toThrow('Unsafe')
      expect(fs.readdirSync(external)).toEqual([])
    } finally { fs.rmSync(external, { recursive: true, force: true }) }
  })

  it('batch validation checks every target and rechecks parents on each call', () => {
    fs.mkdirSync(join(root, 'scope'))
    const paths = [join(root, 'scope', 'one.md'), join(root, 'scope', 'two.md')]
    fs.writeFileSync(paths[0], 'one')
    fs.mkdirSync(paths[1])
    expect(() => inspectMemoryFilePaths(paths, root)).toThrow('Unsafe memory file')
    fs.rmdirSync(paths[1])
    const before = inspectMemoryFilePaths(paths, root)
    expect(before.get(paths[0])).toBe(memoryFileFingerprint(paths[0]))
    expect(before.get(paths[1])).toBeNull()
    fs.writeFileSync(paths[0], 'changed')
    expect(inspectMemoryFilePaths(paths, root).get(paths[0])).not.toBe(before.get(paths[0]))
    fs.unlinkSync(paths[0])
    fs.rmdirSync(join(root, 'scope'))
    const external = fs.mkdtempSync(join(tmpdir(), 'nova-batch-external-'))
    try {
      fs.symlinkSync(external, join(root, 'scope'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => inspectMemoryFilePaths(paths, root)).toThrow('Unsafe memory path')
      expect(() => inspectMemoryFilePaths([join(root, '..', 'escape.md')], root)).toThrow('escapes')
      expect(fs.readdirSync(external)).toEqual([])
    } finally { fs.rmSync(external, { recursive: true, force: true }) }
  })

  it('rejects symlink targets using injected lstat without requiring Windows symlink privileges', () => {
    writeFileAtomic(target, 'before', { memoryRoot: root })
    const stat = fs.lstatSync(target)
    const lstat = vi.fn(fs.lstatSync)
    lstat.mockReturnValueOnce(Object.assign(stat, { isSymbolicLink: () => true }))
    expect(() => writeFileAtomic(target, 'bad', { memoryRoot: root, fs: { lstatSync: lstat } })).toThrow('Unsafe')
    expect(fs.readFileSync(target, 'utf8')).toBe('before')
  })

  it('removes only stale Nova temporary files', () => {
    const stale = join(root, '.facts.md.123.0123456789abcdef.tmp')
    const fresh = join(root, '.facts.md.123.fedcba9876543210.tmp')
    fs.writeFileSync(stale, 'stale')
    fs.writeFileSync(fresh, 'fresh')
    fs.writeFileSync(join(root, 'user.tmp'), 'user data')
    fs.utimesSync(stale, new Date(0), new Date(0))
    expect(cleanStaleMemoryTemps(root, root, Date.now())).toBe(1)
    expect(fs.readdirSync(root).sort()).toEqual(['.facts.md.123.fedcba9876543210.tmp', 'user.tmp'])
  })
})
