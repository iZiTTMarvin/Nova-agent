import type { PathAccessKind, SessionPathGrant, ToolEffect } from '../../shared/permissions/types'
import { getToolPermissionDescriptor } from '../../shared/permissions/toolEffects'
import { resolveToolArg } from '../tools/toolArgResolver'
import { resolvePathAccess } from './pathAccess/pathAccessPolicy'
import { listPathGrantsForAccess } from './pathAccess/sessionPathGrants'
import { assessCommandRisk } from './risk/bashRisk'
import type { PermissionQuery, RiskLevel } from './types'

export type EffectResolution =
  | {
      ok: true
      effects: ToolEffect[]
      externalPaths: string[]
      pathAccess?: PathAccessKind
      riskLevel: RiskLevel
      reasons: string[]
    }
  | { ok: false; reason: string; kind?: 'unknown_action' }

const PATH_DEFAULT_DOT_TOOLS = new Set(['ls', 'grep', 'find'])

function filesystemAccess(effects: readonly ToolEffect[]): PathAccessKind {
  return effects.includes('filesystem.write') ? 'write' : 'read'
}

function resolveShellSession(query: PermissionQuery): EffectResolution {
  const action = query.args.action
  if (action === 'read') {
    return { ok: true, effects: [], externalPaths: [], riskLevel: 'low', reasons: [] }
  }
  if (action === 'interrupt' || action === 'stop') {
    return {
      ok: true,
      effects: ['process.control'],
      externalPaths: [],
      riskLevel: 'low',
      reasons: []
    }
  }
  if (action === 'write') {
    const input = typeof query.args.input === 'string' ? query.args.input : ''
    const risk = assessCommandRisk(input)
    return {
      ok: true,
      effects: ['shell.execute'],
      externalPaths: [],
      riskLevel: risk.riskLevel,
      reasons: risk.isDangerous ? [risk.reason] : []
    }
  }
  return { ok: false, reason: '未知的 shell_session action', kind: 'unknown_action' }
}

export function resolvePermissionEffects(query: PermissionQuery): EffectResolution {
  const descriptor = getToolPermissionDescriptor(query.toolName)
  if (!descriptor) {
    return { ok: false, reason: `工具 "${query.toolName}" 没有权限描述` }
  }

  if (query.toolName === 'shell_session') {
    return resolveShellSession(query)
  }

  let riskLevel: RiskLevel = 'low'
  const reasons: string[] = []
  if (descriptor.risk === 'dynamic' && query.toolName === 'bash') {
    const command = resolveToolArg(query.args, 'command') ?? ''
    const risk = assessCommandRisk(command)
    riskLevel = risk.riskLevel
    if (risk.isDangerous) reasons.push(risk.reason)
  }

  const effects = [...descriptor.effects]
  const externalPaths: string[] = []
  let pathAccess: PathAccessKind | undefined

  if (descriptor.pathScope === 'dynamic') {
    pathAccess = filesystemAccess(effects)
    const rawPath = resolveToolArg(query.args, 'path')
    const inputPath =
      rawPath ?? (PATH_DEFAULT_DOT_TOOLS.has(query.toolName) ? '.' : undefined)
    if (inputPath) {
      const grants: SessionPathGrant[] = listPathGrantsForAccess(query.sessionId, undefined)
      const access = resolvePathAccess({
        workingDir: query.workspaceRoot,
        inputPath,
        access: pathAccess,
        grants
      })
      if (!access.ok) {
        return { ok: false, reason: access.reason }
      }
      if (access.scope === 'external') {
        externalPaths.push(access.canonical)
      }
    }
  }

  return { ok: true, effects, externalPaths, pathAccess, riskLevel, reasons }
}
