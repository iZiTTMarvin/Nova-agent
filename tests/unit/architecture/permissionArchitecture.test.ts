/**
 * 权限体系的静态结构门禁：机械扫描 src/ 保证权限判定与路径边界不被复制。
 * 这些是源码内容检查而非 import 边界，规则真源在本文件；allowlist 冻结精确历史债务。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../../')

function toRepoPosix(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/')
}

function listSourceFiles(dir: string): string[] {
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      result.push(full)
    }
  }
  return result
}

const srcFiles = listSourceFiles(path.join(repoRoot, 'src')).map(toRepoPosix)

function readSource(repoPosix: string): string {
  return fs.readFileSync(path.join(repoRoot, repoPosix), 'utf8')
}

describe('权限体系静态门禁', () => {
  it('permission_request 事件发射与 pending resolver 只属于 PermissionCoordinator', () => {
    // types.ts 是 AgentEvent 契约声明（事件 union 的判别字段），不是交互方
    const contractDeclarations = new Set(['src/runtime/agent/types.ts'])
    const offenders = srcFiles.filter((file) => {
      if (file === 'src/runtime/permissions/PermissionCoordinator.ts') return false
      if (contractDeclarations.has(file)) return false
      const text = readSource(file)
      return text.includes('pendingPermissions') || text.includes(`type: 'permission_request'`)
    })
    expect(offenders).toEqual([])
  })

  it('PermissionCoordinator 只能由 AgentLoop 装配，运行路径不得另建权限交互入口', () => {
    const offenders = srcFiles.filter((file) => {
      if (file === 'src/runtime/agent/AgentLoop.ts') return false
      return readSource(file).includes('new PermissionCoordinator(')
    })
    expect(offenders).toEqual([])
  })

  it('工具批执行不得复制权限规则判定', () => {
    const offenders = srcFiles
      .filter((file) => file.startsWith('src/runtime/agent/execution/'))
      .filter((file) => {
        const text = readSource(file)
        return [
          'matchPermission',
          'resolveModeBaseline',
          'resolvePermissionEffects',
          'assessCommandRisk',
          'DANGEROUS_PATTERNS'
        ].some((marker) => text.includes(marker))
      })
    expect(offenders).toEqual([])
  })

  it('compose 相关文件不得硬编码权限模式判断', () => {
    const composeFiles = srcFiles.filter(
      (file) =>
        file === 'src/main/agent/runtime/composeStageWiring.ts' ||
        file.startsWith('src/shared/composeLifecycle/')
    )
    expect(composeFiles.length).toBeGreaterThan(0)
    const offenders = composeFiles.filter((file) => {
      const text = readSource(file)
      return (
        text.includes('permissionMode') ||
        text.includes('full_access') ||
        text.includes('request_approval')
      )
    })
    expect(offenders).toEqual([])
  })

  it('path.relative 越界判断组合只允许出现在 pathAccess', () => {
    const allowed = new Set(['src/runtime/permissions/pathAccess/canonicalPath.ts'])
    /** 历史债务：既有手写边界判断，迁移到 pathAccess 前冻结在 allowlist。
     * 删除条件：各自改用 pathAccess 的 isPathWithinRoot / toWorkspaceRelativePath。 */
    const allowlist = new Set([
      'src/runtime/plans/index.ts',
      'src/runtime/tools/lsTool.ts',
      'src/runtime/tools/savePlan/index.ts',
      'src/main/services/CodeGraphWorkspaceWatcher.ts'
    ])
    const offenders = srcFiles.filter((file) => {
      if (allowed.has(file) || allowlist.has(file)) return false
      const text = readSource(file)
      const usesRelative =
        text.includes('relative(') &&
        (text.includes("path.relative") || text.includes(' relative,'))
      const boundaryPredicate =
        text.includes("startsWith('..')") || text.includes('startsWith(`..')
      return usesRelative && boundaryPredicate
    })
    expect(offenders).toEqual([])
  })
})
