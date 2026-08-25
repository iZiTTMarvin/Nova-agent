/**
 * todo_write 走 session.write，不写文件系统，各模式与权限档位都应放行。
 * 对照：plan 下真实写文件工具仍拒绝。
 */
import { describe, expect, it } from 'vitest'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import type { PermissionQuery } from '../../../../src/runtime/permissions/types'
import type { Mode, PermissionMode } from '../../../../src/shared/session/types'

function query(
  toolName: string,
  args: Record<string, unknown>,
  permissionMode: PermissionMode = 'auto'
): PermissionQuery {
  return {
    toolName,
    args,
    sessionId: 'todo-write-session',
    workspaceRoot: '/workspace',
    permissionMode
  }
}

describe('todo_write 权限', () => {
  const manager = new PermissionManager()

  it.each(['plan', 'default', 'compose'] as const)('%s 模式下允许 todo_write', mode => {
    expect(manager.check(query('todo_write', { todos: [] }), mode).decision).toBe('allow')
  })

  it.each(['request_approval', 'auto', 'full_access'] as const)(
    '%s 档位下允许 todo_write',
    permissionMode => {
      expect(
        manager.check(query('todo_write', { todos: [] }, permissionMode), 'default').decision
      ).toBe('allow')
    }
  )

  it('plan 模式下写文件工具仍拒绝', () => {
    expect(manager.check(query('write', { path: 'a.ts' }), 'plan' as Mode).decision).toBe('deny')
  })
})
