import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { assertMemoryFilePath, cleanStaleMemoryTemps } from '../markdown/atomicFile'
import { MEMORY_EPISODIC_RETENTION_DAYS } from '../memoryConfig'

/** Removes only owned episodic files and atomic-write temporary files. */
export function maintainMemoryFiles(scopeDir: string, memoryRoot: string, now: number): number {
  let removed = 0
  if (!existsSync(scopeDir)) return removed
  // Validate the scope's parent chain before enumerating it.
  assertMemoryFilePath(join(scopeDir, '.ledger.jsonl'), memoryRoot)
  cleanStaleMemoryTemps(scopeDir, memoryRoot, now)
  const episodic = join(scopeDir, 'episodic')
  if (!existsSync(episodic)) return removed
  assertMemoryFilePath(join(episodic, 'legacy.md'), memoryRoot)
  for (const name of readdirSync(episodic)) {
    const month = /^(\d{4})-(0[1-9]|1[0-2])\.md$/.exec(name)
    if (!month && name !== 'legacy.md') continue
    const path = join(episodic, name)
    assertMemoryFilePath(path, memoryRoot)
    const end = month ? new Date(Number(month[1]), Number(month[2]), 0, 23, 59, 59, 999).getTime() : lstatSync(path).mtimeMs
    if (now - end > MEMORY_EPISODIC_RETENTION_DAYS * 86_400_000) { unlinkSync(path); removed++ }
  }
  cleanStaleMemoryTemps(episodic, memoryRoot, now)
  return removed
}
