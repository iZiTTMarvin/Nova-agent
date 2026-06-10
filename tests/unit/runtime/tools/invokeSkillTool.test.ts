import { describe, it, expect } from 'vitest'
import { createInvokeSkillTool } from '../../../../src/runtime/tools/invokeSkillTool'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const ctx: ToolContext = { workingDir: process.cwd() }

describe('invokeSkillTool', () => {
  it('找不到技能返回明确错误', async () => {
    const reg = SkillRegistry.load({ globalDir: join(tmpdir(), `empty-skills-${Date.now()}`) })
    const tool = createInvokeSkillTool({ modelClient: new MockModelClient(), skillRegistry: reg })
    const result = await tool.execute({ skill_name: 'missing', task: 't' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
  })

  it('成功调用返回模型输出', async () => {
    const dir = join(tmpdir(), `skill-invoke-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\n---\nYou are demo.`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'skill result' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createInvokeSkillTool({ modelClient: client, skillRegistry: reg })
    const result = await tool.execute({ skill_name: 'demo', task: 'do it' }, ctx)
    rmSync(dir, { recursive: true, force: true })
    expect(result.success).toBe(true)
    expect(result.output).toBe('skill result')
  })

  it('模型 error 事件返回失败', async () => {
    const dir = join(tmpdir(), `skill-err-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\n---\nbody`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'error', error: 'model down' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createInvokeSkillTool({ modelClient: client, skillRegistry: reg })
    const result = await tool.execute({ skill_name: 'demo', task: 't' }, ctx)
    rmSync(dir, { recursive: true, force: true })
    expect(result.success).toBe(false)
  })

  it('空输出返回失败', async () => {
    const dir = join(tmpdir(), `skill-empty-${Date.now()}`)
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: d\n---\nbody`)
    const reg = SkillRegistry.load({ globalDir: dir })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const tool = createInvokeSkillTool({ modelClient: client, skillRegistry: reg })
    const result = await tool.execute({ skill_name: 'demo', task: 't' }, ctx)
    rmSync(dir, { recursive: true, force: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未返回内容')
  })

  it('工具名称为 invoke_skill', () => {
    const tool = createInvokeSkillTool({
      modelClient: new MockModelClient(),
      skillRegistry: SkillRegistry.load({ globalDir: join(tmpdir(), `x-${Date.now()}`) })
    })
    expect(tool.name).toBe('invoke_skill')
  })
})
