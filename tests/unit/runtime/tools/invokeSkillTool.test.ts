import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createInvokeSkillTool } from '../../../../src/runtime/tools/invokeSkillTool'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import type { SpawnSubagentPort } from '../../../../src/runtime/subagents'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const unavailablePort = (): undefined => undefined
const ctx: ToolContext = { workingDir: process.cwd() }

describe('invokeSkillTool', () => {
  it('找不到技能返回明确错误', async () => {
    const reg = SkillRegistry.load({ globalDir: join(tmpdir(), `empty-skills-${Date.now()}`) })
    const tool = createInvokeSkillTool({ skillRegistry: reg, getSpawnSubagentPort: unavailablePort })
    const result = await tool.execute({ skill_name: 'missing', task: 't' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
  })

  it('非 fork 技能返回展开后的 body，不独立执行模型', async () => {
    const dir = join(tmpdir(), `skill-invoke-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\n---\nYou are demo.`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const tool = createInvokeSkillTool({ skillRegistry: reg, getSpawnSubagentPort: unavailablePort })
    const result = await tool.execute({ skill_name: 'demo', task: 'do it' }, ctx)
    rmSync(dir, { recursive: true, force: true })
    expect(result.success).toBe(true)
    expect(result.output).toContain('You are demo.')
    expect(result.output).toContain('do it')
  })

  it('展开成功后登记 skill 可读根', async () => {
    const dir = join(tmpdir(), `skill-oninvoked-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\n---\nbody <%= skillDirectory %>`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const invoked: string[] = []
    const tool = createInvokeSkillTool({
      skillRegistry: reg,
      getSpawnSubagentPort: unavailablePort,
      onSkillInvoked: (skill) => invoked.push(skill.directory)
    })
    const result = await tool.execute({ skill_name: 'demo', task: 't' }, ctx)
    rmSync(dir, { recursive: true, force: true })
    expect(result.success).toBe(true)
    expect(invoked).toHaveLength(1)
  })

  it('fork 技能以完整工具调用身份委托统一子代理端口', async () => {
    const dir = join(tmpdir(), `skill-fork-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\ncontext: fork\n---\nfork body`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const spawn = vi.fn<SpawnSubagentPort['spawn']>(async () => ({
      childSessionId: 'child-skill',
      childRunId: 'run-skill',
      status: 'completed',
      summary: 'fork done',
      artifactIds: [],
      startedAt: 1,
      completedAt: 2
    }))
    const onSkillInvoked = vi.fn()
    const tool = createInvokeSkillTool({
      skillRegistry: reg,
      getSpawnSubagentPort: () => ({ spawn }),
      onSkillInvoked
    })
    const invocationRef = {
      sessionId: 'session-parent',
      runId: 'run-parent',
      messageId: 'message-parent',
      toolCallId: 'tool-skill'
    }
    const result = await tool.execute({ skill_name: 'demo', task: 'do fork' }, {
      workingDir: process.cwd(),
      sessionId: invocationRef.sessionId,
      runId: invocationRef.runId,
      invocationRef
    })

    expect(result).toEqual({ success: true, output: 'fork done' })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-parent',
        parentRunId: 'run-parent',
        profileId: 'demo',
        invocation: {
          kind: 'skill_fork',
          parentMessageId: 'message-parent',
          parentToolCallId: 'tool-skill',
          skillName: 'demo'
        }
      }),
      expect.objectContaining({
        invocationRef,
        profile: expect.objectContaining({ skillRoots: [join(dir, 'demo')] })
      })
    )
    expect(onSkillInvoked).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['failed', 'skill failed'],
    ['cancelled', '技能子代理已cancelled'],
    ['interrupted', '技能子代理已interrupted']
  ] as const)('fork 技能的 %s 终态写入 ToolResult.error', async (status, expectedError) => {
    const dir = join(tmpdir(), `skill-fork-${status}-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\ncontext: fork\n---\nfork body`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const spawn = vi.fn<SpawnSubagentPort['spawn']>(async () => ({
      childSessionId: 'child-skill',
      childRunId: 'run-skill',
      status,
      summary: '',
      artifactIds: [],
      startedAt: 1,
      completedAt: 2,
      ...(status === 'failed' ? { failure: { code: 'model' as const, message: 'skill failed' } } : {})
    }))
    const tool = createInvokeSkillTool({
      skillRegistry: reg,
      getSpawnSubagentPort: () => ({ spawn })
    })
    const invocationRef = {
      sessionId: 'session-parent',
      runId: 'run-parent',
      messageId: 'message-parent',
      toolCallId: `tool-${status}`
    }

    const result = await tool.execute({ skill_name: 'demo', task: 'do fork' }, {
      workingDir: process.cwd(),
      sessionId: invocationRef.sessionId,
      runId: invocationRef.runId,
      invocationRef
    })

    expect(result).toEqual({ success: false, output: '', error: expectedError })
    rmSync(dir, { recursive: true, force: true })
  })

  it('fork 技能执行异常写入 ToolResult.error', async () => {
    const dir = join(tmpdir(), `skill-fork-throw-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\ncontext: fork\n---\nfork body`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const spawn = vi.fn<SpawnSubagentPort['spawn']>(async () => {
      throw new Error('spawn exploded')
    })
    const tool = createInvokeSkillTool({
      skillRegistry: reg,
      getSpawnSubagentPort: () => ({ spawn })
    })
    const invocationRef = {
      sessionId: 'session-parent',
      runId: 'run-parent',
      messageId: 'message-parent',
      toolCallId: 'tool-throw'
    }

    const result = await tool.execute({ skill_name: 'demo', task: 'do fork' }, {
      workingDir: process.cwd(),
      sessionId: invocationRef.sessionId,
      runId: invocationRef.runId,
      invocationRef
    })

    expect(result).toEqual({ success: false, output: '', error: 'spawn exploded' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具名称为 invoke_skill', () => {
    const tool = createInvokeSkillTool({
      skillRegistry: SkillRegistry.load({ globalDir: join(tmpdir(), `x-${Date.now()}`) }),
      getSpawnSubagentPort: unavailablePort
    })
    expect(tool.name).toBe('invoke_skill')
  })
})
