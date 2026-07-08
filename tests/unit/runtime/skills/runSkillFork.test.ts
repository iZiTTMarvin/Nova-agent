/**
 * runSkillFork — 验证 fork 子代理能读取本 skill 目录下的 reference
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { runSkillFork } from '../../../../src/runtime/skills/runSkillFork'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { createReadState } from '../../../../src/runtime/tools/editTool'

describe('runSkillFork skillRoots', () => {
  it('fork 子代理能用 read 读取本 skill 目录的 reference', async () => {
    const skillsDir = join(tmpdir(), `fork-skill-${Date.now()}`)
    const skillName = 'fork-ref'
    const skillDir = join(skillsDir, skillName)
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: fork ref\ncontext: fork\n---\n读 references`
    )
    writeFileSync(join(skillDir, 'references', 'rule.md'), 'FORK-REF-XYZ\n')
    const registry = SkillRegistry.load({ globalDir: skillsDir })
    const skill = registry.get(skillName)!
    expect(skill).toBeDefined()

    const refPath = join(skillDir, 'references', 'rule.md')
    const workDir = join(tmpdir(), `fork-ws-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })

    const client = new MockModelClient()
    // 子循环：先 tool_call read，再结束
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call',
          toolCall: {
            id: 'fork_read',
            name: 'read',
            arguments: JSON.stringify({ path: refPath })
          }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'FORK-REF-XYZ' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const parentBus = new EventBus()
    const result = await runSkillFork(
      {
        modelClient: client,
        parentEventBus: parentBus,
        resolveTool: (name) => (name === 'read' ? readTool : undefined)
      },
      {
        skill,
        args: 'read the rule',
        ctx: {
          workingDir: workDir,
          readState: createReadState()
        }
      }
    )

    expect(result.success).toBe(true)
    expect(result.summary).toContain('FORK-REF-XYZ')

    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  })
})
