import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { MEMORY_FILE_WRITE_RETRIES, MEMORY_FILE_WRITE_RETRY_DELAY_MS } from '../memoryConfig'

export type MemoryFileFs = Pick<typeof fs,
  'lstatSync' | 'mkdirSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' |
  'closeSync' | 'renameSync' | 'unlinkSync' | 'readdirSync'>

export class MemoryFileConflictError extends Error {
  constructor(path: string) { super(`Memory file changed: ${path}`); this.name = 'MemoryFileConflictError' }
}

export interface AtomicMemoryFileOptions {
  memoryRoot: string
  expectedFingerprint?: string | null
  fs?: Partial<MemoryFileFs>
  wait?: (ms: number) => void
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

export function memoryFileFingerprint(path: string, io: Pick<MemoryFileFs, 'lstatSync'> = fs): string | null {
  try {
    const stat = io.lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe memory file: ${path}`)
    return `${stat.size}-${stat.mtimeMs}`
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

export function assertMemoryFilePath(path: string, memoryRoot: string, io: Pick<MemoryFileFs, 'lstatSync'> = fs): void {
  assertFilePath(path, memoryRoot, io, new Set())
}

export function inspectMemoryFilePaths(paths: readonly string[], memoryRoot: string): ReadonlyMap<string, string | null> {
  const checkedDirectories = new Set<string>()
  return new Map(paths.map(path => [path, assertFilePath(path, memoryRoot, fs, checkedDirectories)]))
}

function assertFilePath(path: string, memoryRoot: string, io: Pick<MemoryFileFs, 'lstatSync'>, checkedDirectories: Set<string>): string | null {
  const root = resolve(memoryRoot)
  const target = resolve(path)
  const rel = relative(root, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || resolve(root, rel) !== target) throw new Error('Memory path escapes its root')
  let current = target
  let fingerprint: string | null = null
  while (true) {
    if (current !== target && checkedDirectories.has(current)) break
    try {
      const stat = io.lstatSync(current)
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new Error(`Unsafe memory path: ${current}`)
      if (current === target && !stat.isFile()) throw new Error(`Unsafe memory file: ${current}`)
      if (current === target) fingerprint = `${stat.size}-${stat.mtimeMs}`
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    if (current !== target) checkedDirectories.add(current)
    if (current === root) break
    current = dirname(current)
  }
  return fingerprint
}

export function writeFileAtomic(path: string, content: string | Uint8Array, options: AtomicMemoryFileOptions): void {
  const io: MemoryFileFs = { ...fs, ...options.fs }
  const target = resolve(path)
  assertMemoryFilePath(target, options.memoryRoot, io)
  const checkFingerprint = (): void => {
    if (options.expectedFingerprint !== undefined && memoryFileFingerprint(target, io) !== options.expectedFingerprint) {
      throw new MemoryFileConflictError(target)
    }
  }
  checkFingerprint()
  io.mkdirSync(dirname(target), { recursive: true })
  assertMemoryFilePath(target, options.memoryRoot, io)
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  const wait = options.wait ?? (ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) })
  let fd: number | undefined
  let tempCreated = false
  try {
    fd = io.openSync(temp, 'wx', 0o600)
    tempCreated = true
    io.writeFileSync(fd, content)
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = undefined
    assertMemoryFilePath(target, options.memoryRoot, io)
    checkFingerprint()
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(temp, target); tempCreated = false; return }
      catch (error) {
        if (attempt >= MEMORY_FILE_WRITE_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error) ?? '')) throw error
        wait(MEMORY_FILE_WRITE_RETRY_DELAY_MS)
        assertMemoryFilePath(target, options.memoryRoot, io)
        checkFingerprint()
      }
    }
  } finally {
    try { if (fd !== undefined) io.closeSync(fd) }
    finally { if (tempCreated) io.unlinkSync(temp) }
  }
}

export function cleanStaleMemoryTemps(directory: string, memoryRoot: string, now: number): number {
  const root = resolve(memoryRoot)
  const rel = relative(root, resolve(directory))
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || resolve(root, rel) !== resolve(directory)) throw new Error('Memory directory escapes its root')
  let removed = 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) }
  catch (error) { if (errorCode(error) === 'ENOENT') return 0; throw error }
  for (const entry of entries) {
    if (!entry.isFile() || !/^\..+\.\d+\.[0-9a-f]{16}\.tmp$/.test(entry.name)) continue
    const path = join(directory, entry.name)
    assertMemoryFilePath(path, memoryRoot)
    if (now - fs.lstatSync(path).mtimeMs > 60 * 60 * 1000) { fs.unlinkSync(path); removed++ }
  }
  return removed
}
