import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSkillFork } from '../../../../src/runtime/skills/runSkillFork'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import type { SpawnSubagentPort } from '../../../../src/runtime/subagents'

describe('runSkillFork durable child consumer', () => {
  it('slash fork 用父 message 身份建立 Child Session，并持久化 skill 可读根', async () => {
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
      status: 'completed',
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

    expect(result).toEqual({ success: true, summary: 'FORK-REF-XYZ' })
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
