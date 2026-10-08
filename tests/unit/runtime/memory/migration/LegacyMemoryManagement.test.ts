import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LegacyMemoryMigrator } from '@runtime/memory/migration/LegacyMemoryMigrator'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nova-legacy-management-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('unclaimed legacy management', () => {
  it('lists only nonempty hash staging directories and deletes only the explicitly selected tree', () => {
    const hash = '1234567890abcdef', other = 'abcdef1234567890'
    for (const name of [hash, other, 'not-a-hash']) {
      const path = join(root, 'projects/_legacy', name, 'notes'); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'guide.md'), 'handwritten notes')
    }
    const migrator = new LegacyMemoryMigrator(root)
    expect(migrator.listUnclaimed()).toEqual([{ oldHash: hash, fileCount: 1, diskBytes: 17 }, { oldHash: other, fileCount: 1, diskBytes: 17 }])
    expect(() => migrator.deleteUnclaimed('../escape')).toThrow('Invalid legacy hash')
    migrator.deleteUnclaimed(hash)
    expect(existsSync(join(root, 'projects/_legacy', hash))).toBe(false)
    expect(readFileSync(join(root, 'projects/_legacy', other, 'notes/guide.md'), 'utf8')).toBe('handwritten notes')
    expect(readFileSync(join(root, 'projects/_legacy/not-a-hash/notes/guide.md'), 'utf8')).toBe('handwritten notes')
  })
  it('refuses junctions before deleting any source files', () => {
    const hash = '1234567890abcdef', outside = join(root, 'outside'), staging = join(root, 'projects/_legacy', hash)
    mkdirSync(outside); writeFileSync(join(outside, 'notes.md'), 'external notes'); mkdirSync(staging, { recursive: true })
    symlinkSync(outside, join(staging, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const migrator = new LegacyMemoryMigrator(root)
    expect(() => migrator.deleteUnclaimed(hash)).toThrow('symbolic link')
    expect(readFileSync(join(outside, 'notes.md'), 'utf8')).toBe('external notes')
  })
})
