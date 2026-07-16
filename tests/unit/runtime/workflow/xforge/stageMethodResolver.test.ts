import { describe, expect, it } from 'vitest'
import type { SkillManifest } from '../../../../../src/runtime/skills/types'
import { resolveXForgeStageMethod } from '../../../../../src/runtime/workflow/xforge'

function skill(name: string, patch: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name,
    description: name,
    userInvocable: false,
    modelInvocable: true,
    body: '# method',
    source: 'builtin',
    sourcePath: `${name}/SKILL.md`,
    directory: name,
    warnings: [],
    hasSupportingFiles: false,
    enabled: true,
    ...patch
  }
}

describe('XForge Stage Method', () => {
  it('缺失或权限声明自相矛盾的方法明确失败，不静默换 skill', () => {
    const missing = resolveXForgeStageMethod({ get: () => undefined }, 'scope_check')
    expect(missing).toMatchObject({ ok: false, method: 'br-scope-check' })

    const invalid = resolveXForgeStageMethod(
      {
        get: () => skill('br-scope-check', {
          allowedTools: ['write'],
          forbiddenTools: ['write']
        })
      },
      'scope_check'
    )
    expect(invalid).toMatchObject({ ok: false, method: 'br-scope-check' })
  })

  it('阶段方法可以声明任意基础工具，不再由阶段名二次裁剪', () => {
    const manifest = skill('br-scope-check', {
      allowedTools: ['read', 'write', 'bash', 'invoke_skill']
    })
    const resolved = resolveXForgeStageMethod(
      { get: () => manifest },
      'scope_check'
    )
    expect(resolved).toMatchObject({ ok: true, method: 'br-scope-check', skill: manifest })
  })

  it('brainstorm 可按探索路由解析 office-hours', () => {
    const manifest = skill('br-office-hours')
    const resolved = resolveXForgeStageMethod(
      { get: name => name === manifest.name ? manifest : undefined },
      'brainstorm',
      { explorationMethod: 'br-office-hours' }
    )
    expect(resolved).toMatchObject({ ok: true, method: 'br-office-hours', skill: manifest })
  })

})
