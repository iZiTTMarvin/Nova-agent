/**
 * rulesDiscovery 路径安全校验
 */
import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { isPathInsideRoot } from '../../../../src/runtime/agent/rulesDiscovery'

describe('isPathInsideRoot', () => {
  const root = join('C:', 'workspace', 'proj')

  it('允许根目录内的子路径', () => {
    expect(isPathInsideRoot(join(root, '.nova', 'rules', 'a.md'), root)).toBe(true)
  })

  it('拒绝 .. 路径穿越', () => {
    expect(isPathInsideRoot(join(root, '..', 'etc', 'passwd'), root)).toBe(false)
  })

  it('拒绝与根目录无关的绝对路径', () => {
    expect(isPathInsideRoot(join('C:', 'other', 'secret.md'), root)).toBe(false)
  })
})
