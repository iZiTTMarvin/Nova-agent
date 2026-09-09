import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSkillFork } from '../../../../src/runtime/skills/runSkillFork'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import type { SpawnSubagentPort } from '../../../../src/runtime/subagents'

describe('runSkillFork durable child consumer', () => {
  it.each(['completed', 'failed', 'cancelled', 'interrupted', 'incomplete'] as const)('slash fork 保留子任务 %s 终态与父 message 身份', async status => {
    const skillsDir = join(tmpdir(), `fork-skill-${Date.now()}`)
    const skillDir = join(skillsDir, 'fork-ref')
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: fork-ref\ndescription: fork ref\ncontext: fork\nallowed-tools: read\n---\n读 <%= skillDirectory %>/references`
    )
    const skill = SkillRegistry.load({ globalDir: skillsDir }).get('fork-ref')!
    const spawn = vi.fn<SpawnSubagentPort['spawn']>(async () => ({
      childSessionId: 'child-skill',
      childRunId: 'run-skill',
      status,
      ...(status === 'incomplete' ? { incompleteReason: 'max_rounds' as const } : {}),
      summary: 'FORK-REF-XYZ',
      artifactIds: [],
      startedAt: 1,
      completedAt: 2
    }))

    const result = await runSkillFork({
      getSpawnSubagentPort: () => ({ spawn })
    }, {
      skill,
      args: 'read the rule',
      parentSessionId: 'session-parent',
      parentRunId: 'run-parent',
      parentMessageId: 'message-parent',
      workingDirectory: process.cwd(),
      templateContext: { workspacePath: process.cwd() }
    })

    expect(result).toEqual({ status, success: status === 'completed', summary: 'FORK-REF-XYZ',
      ...(status === 'incomplete' ? { incompleteReason: 'max_rounds' } : {}) })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'fork-ref',
        invocation: {
          kind: 'skill_fork',
          parentMessageId: 'message-parent',
          skillName: 'fork-ref'
        },
        isolation: 'readonly'
      }),
      expect.objectContaining({
        profile: expect.objectContaining({
          id: 'fork-ref',
          name: 'fork-ref',
          prompt: expect.stringContaining(`${skillDir}/references`),
          skillRoots: [skillDir]
        })
      })
    )

    rmSync(skillsDir, { recursive: true, force: true })
  })
})
