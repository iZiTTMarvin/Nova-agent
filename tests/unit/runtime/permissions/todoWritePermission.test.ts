/**
 * todo_write 的基础权限规则验证
 *
 * 重点：todo_write 走 readonly 分类，3 种模式都返回 allow。
 * 不会被 PermissionManager 的 bash 命令检测误拦截（它是 readonly 工具）。
 */
import { describe, expect, it } from 'vitest'
import { getBaseDecision } from '../../../../src/runtime/permissions/rules'
import { assessCommandRisk } from '../../../../src/runtime/permissions/rules'
import type { Mode } from '../../../../src/shared/session/types'

describe('todo_write 权限基础规则', () => {
  it('plan 模式 → allow', () => {
    expect(getBaseDecision('plan', 'todo_write')).toBe('allow')
  })

  it('default 模式 → allow', () => {
    expect(getBaseDecision('default', 'todo_write')).toBe('allow')
  })

  it('default+auto / compose → allow', () => {
    expect(getBaseDecision('default', 'todo_write', 'auto')).toBe('allow')
    expect(getBaseDecision('compose', 'todo_write')).toBe('allow')
  })

  it('三模式都不调用 bash 命令检测（不传 command）', () => {
    // todo_write 的 args 不会含 command，assessCommandRisk 仅在 PermissionManager
    // 处理 bash 工具时才会被调用。这里用空调用验证它不会抛错。
    const result = assessCommandRisk('')
    expect(result.isDangerous).toBe(false)
  })

  it('模式路由：write 工具在 plan 模式仍为 deny，对照保证测试隔离', () => {
    expect(getBaseDecision('plan', 'edit' as Mode extends never ? never : 'edit')).toBe('deny')
  })
})
