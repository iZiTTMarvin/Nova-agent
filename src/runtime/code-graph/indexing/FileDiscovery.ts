import { spawn } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { isPathSkipped, loadIgnoreMatcher } from '../../workspace'
import type { CodeGraphLanguage } from '../types'

export const CODE_INDEX_MAX_SOURCE_BYTES = 2 * 1024 * 1024
export const CODE_INDEX_GIT_TIMEOUT_MS = 15_000

const GIT_STDOUT_MAX_BYTES = 64 * 1024 * 1024

const SUPPORTED_EXTENSIONS: ReadonlyMap<string, CodeGraphLanguage> = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'mjs'],
  ['.cjs', 'cjs'],
  ['.py', 'python']
])

// 只识别明确的源码扩展，避免把文档、数据和媒体文件污染 coverage。
const KNOWN_UNSUPPORTED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.astro', '.bash', '.c', '.cc', '.clj', '.cljs', '.cljc', '.coffee', '.cpp',
  '.cs', '.cu', '.cuh', '.cxx', '.dart', '.elm', '.erl', '.ex', '.exs', '.fs',
  '.fsx', '.gd', '.gemspec', '.go', '.groovy', '.h', '.hpp', '.hrl', '.hs',
  '.java', '.jl', '.kt', '.kts', '.lua', '.m', '.mm', '.nim', '.php', '.pl',
  '.pm', '.ps1', '.psm1', '.r', '.rake', '.rb', '.rs', '.scala', '.sh', '.sol',
  '.sql', '.svelte', '.swift', '.vb', '.vbs', '.vue', '.zig'
])

const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'package.json'
])

export type CodeFileDiscoveryStatus =
  | 'eligible'
  | 'unsupported'
  | 'skipped_too_large'

export type FileDiscoveryDiagnosticReason =
  | 'git_unavailable'
  | 'outside_workspace'
  | 'invalid_path'
  | 'not_a_file'
  | 'unreadable'
  | 'symlink_directory'

export interface DiscoveredCodeFile {
  readonly path: string
  readonly language: CodeGraphLanguage
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly status: CodeFileDiscoveryStatus
}

export interface FileDiscoveryDiagnostic {
  readonly path: string | null
  readonly reason: FileDiscoveryDiagnosticReason
}

export interface FileDiscoveryResult {
  readonly source: 'git' | 'fallback'
  readonly files: readonly DiscoveredCodeFile[]
  readonly configFiles: readonly string[]
  readonly diagnostics: readonly FileDiscoveryDiagnostic[]
}

export interface GitFileListRequest {
  readonly workspaceRoot: string
  readonly timeoutMs: number
  readonly abortSignal?: AbortSignal
}

export type GitFileLister = (request: GitFileListRequest) => Promise<readonly string[]>

export interface FileDiscoveryOptions {
  readonly workspaceRoot: string
  readonly abortSignal?: AbortSignal
  readonly gitTimeoutMs?: number
  readonly listGitFiles?: GitFileLister
}

export class FileDiscoveryCancelledError extends Error {
  constructor() {
    super('代码文件发现已取消')
    this.name = 'FileDiscoveryCancelledError'
  }
}

/** 优先采用 Git 文件集合，失败时才复用 Nova 的工作区扫描规则。 */
export async function discoverCodeFiles(
  options: FileDiscoveryOptions
): Promise<FileDiscoveryResult> {
  throwIfAborted(options.abortSignal)
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot))
  const diagnostics: FileDiscoveryDiagnostic[] = []
  let candidates: readonly string[]
  let source: FileDiscoveryResult['source'] = 'git'

  try {
    candidates = await (options.listGitFiles ?? listGitWorkspaceFiles)({
      workspaceRoot,
      timeoutMs: options.gitTimeoutMs ?? CODE_INDEX_GIT_TIMEOUT_MS,
      abortSignal: options.abortSignal
    })
  } catch (error) {
    if (isAbort(error) || options.abortSignal?.aborted) {
      throw new FileDiscoveryCancelledError()
    }
    source = 'fallback'
    diagnostics.push({ path: null, reason: 'git_unavailable' })
    candidates = await scanWorkspaceFallback(workspaceRoot, options.abortSignal, diagnostics)
  }

  const files: DiscoveredCodeFile[] = []
  const configFiles: string[] = []
  const seenPaths = new Set<string>()
  for (const candidate of candidates) {
    throwIfAborted(options.abortSignal)
    const normalized = normalizeCandidatePath(candidate)
    if (normalized === null) {
      diagnostics.push({ path: candidate, reason: 'invalid_path' })
      continue
    }
    if (normalized.split('/').some(isPathSkipped)) continue
    if (seenPaths.has(normalized)) continue
    seenPaths.add(normalized)

    const basename = path.posix.basename(normalized).toLowerCase()
    const isConfigFile = CONFIG_FILE_NAMES.has(basename)
    const language = languageForPath(normalized)
    if (!isConfigFile && language === null) continue
    const validated = await validateCandidate(workspaceRoot, normalized)
    if (!validated.ok) {
      diagnostics.push({ path: normalized, reason: validated.reason })
      continue
    }
    if (isConfigFile) configFiles.push(normalized)
    if (language === null) continue

    const status: CodeFileDiscoveryStatus = language === 'unsupported'
      ? 'unsupported'
      : validated.sizeBytes > CODE_INDEX_MAX_SOURCE_BYTES
        ? 'skipped_too_large'
        : 'eligible'
    files.push(Object.freeze({
      path: normalized,
      language,
      sizeBytes: validated.sizeBytes,
      mtimeMs: validated.mtimeMs,
      status
    }))
  }

  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  configFiles.sort((left, right) => left.localeCompare(right, 'en'))
  return Object.freeze({
    source,
    files: Object.freeze(files),
    configFiles: Object.freeze(configFiles),
    diagnostics: Object.freeze(diagnostics.map((item) => Object.freeze(item)))
  })
}

export async function listGitWorkspaceFiles(
  request: GitFileListRequest
): Promise<readonly string[]> {
  throwIfAborted(request.abortSignal)
  return new Promise<readonly string[]>((resolve, reject) => {
    const child = spawn(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      {
        cwd: request.workspaceRoot,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false

    const settle = (work: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.abortSignal?.removeEventListener('abort', onAbort)
      work()
    }
    const fail = (error: Error): void => settle(() => reject(error))
    const onAbort = (): void => {
      child.kill()
      fail(new FileDiscoveryCancelledError())
    }
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`git ls-files 超时（${request.timeoutMs}ms）`))
    }, request.timeoutMs)

    request.abortSignal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > GIT_STDOUT_MAX_BYTES) {
        child.kill()
        fail(new Error('git ls-files 输出超过资源上限'))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.once('error', fail)
    child.once('close', (code) => {
      if (code !== 0) {
        fail(new Error(`git ls-files 失败（exit ${code ?? 'unknown'}）：${stderr.trim()}`))
        return
      }
      settle(() => {
        const output = Buffer.concat(chunks).toString('utf8')
        resolve(Object.freeze(output.split('\0').filter(Boolean)))
      })
    })
  })
}

async function scanWorkspaceFallback(
  workspaceRoot: string,
  abortSignal: AbortSignal | undefined,
  diagnostics: FileDiscoveryDiagnostic[]
): Promise<readonly string[]> {
  const ignore = await loadIgnoreMatcher(workspaceRoot)
  const files: string[] = []
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: workspaceRoot, relativePath: '' }
  ]

  while (pending.length > 0) {
    throwIfAborted(abortSignal)
    const current = pending.pop()
    if (!current) break
    let entries
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true })
    } catch {
      diagnostics.push({ path: current.relativePath || null, reason: 'unreadable' })
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))

    for (const entry of entries) {
      throwIfAborted(abortSignal)
      if (isPathSkipped(entry.name)) continue
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name
      if (entry.isDirectory()) {
        if (!ignore(relativePath, true)) {
          pending.push({
            absolutePath: path.join(current.absolutePath, entry.name),
            relativePath
          })
        }
        continue
      }
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(path.join(current.absolutePath, entry.name))
          if (targetStat.isFile() && !ignore(relativePath, false)) {
            files.push(relativePath)
          } else {
            diagnostics.push({ path: relativePath, reason: 'symlink_directory' })
          }
        } catch {
          diagnostics.push({ path: relativePath, reason: 'unreadable' })
        }
        continue
      }
      if (!ignore(relativePath, false)) files.push(relativePath)
    }
  }
  return files
}

async function validateCandidate(
  workspaceRoot: string,
  relativePath: string
): Promise<
  | { readonly ok: true; readonly sizeBytes: number; readonly mtimeMs: number }
  | { readonly ok: false; readonly reason: FileDiscoveryDiagnosticReason }
> {
  const absolutePath = path.resolve(workspaceRoot, ...relativePath.split('/'))
  try {
    const actualPath = await realpath(absolutePath)
    const relativeActual = path.relative(workspaceRoot, actualPath)
    if (
      relativeActual === '..' ||
      relativeActual.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeActual)
    ) {
      return { ok: false, reason: 'outside_workspace' }
    }
    const fileStat = await stat(actualPath)
    if (!fileStat.isFile()) return { ok: false, reason: 'not_a_file' }
    return {
      ok: true,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

function normalizeCandidatePath(candidate: string): string | null {
  if (!candidate || candidate.includes('\0')) return null
  const slashPath = candidate.replace(/\\/g, '/')
  const normalized = path.posix.normalize(slashPath)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized !== slashPath
  ) {
    return null
  }
  return normalized
}

function languageForPath(filePath: string): CodeGraphLanguage | null {
  const extension = path.posix.extname(filePath).toLowerCase()
  const supported = SUPPORTED_EXTENSIONS.get(extension)
  if (supported) return supported
  return KNOWN_UNSUPPORTED_SOURCE_EXTENSIONS.has(extension) ? 'unsupported' : null
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) throw new FileDiscoveryCancelledError()
}

function isAbort(error: unknown): boolean {
  return error instanceof FileDiscoveryCancelledError ||
    (error instanceof Error && error.name === 'AbortError')
}
