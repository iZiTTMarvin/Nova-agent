import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { savePlanTool, toReadablePlanFilenamePart } from '../../../../src/runtime/tools/savePlan'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { writerLeaseRegistry } from '../../../../src/runtime/workspace'
import type { ToolContext } from '../../../../src/runtime/tools/types'

let tempRoot: string
let workspace: string
let appData: string
let store: SessionStore
let sessionId: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  writerLeaseRegistry.resetForTests()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-save-plan-'))
  workspace = path.join(tempRoot, 'workspace')
  appData = path.join(tempRoot, 'app-data')
  fs.mkdirSync(workspace, { recursive: true })
  store = new SessionStore(appData)
  sessionId = store.create(workspace, 'plan').id
})

afterEach(() => {
  resetSessionIndexHostForTests()
  writerLeaseRegistry.resetForTests()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function context(): ToolContext {
  return {
    workingDir: workspace,
    workspaceRoot: workspace,
    runId: 'run-save-plan',
    readState: createReadState(),
    sessionStore: store,
    sessionId
  }
}

describe('save_plan', () => {
  it('生成当前工作区 .nova/plans 下的可读文件名，并只在会话元数据保存引用', async () => {
    const marker = 'PLAN_BODY_MUST_STAY_IN_WORKSPACE'
    const result = await savePlanTool.execute({
      title: '认证系统：OAuth / 回退策略?',
      content: `# 认证系统计划\n\n${marker}`
    }, context())

    expect(result.success).toBe(true)
    const active = store.load(sessionId)?.activePlan
    expect(active?.path).toMatch(
      /^\.nova\/plans\/\d{4}-\d{2}-\d{2}-认证系统-OAuth-回退策略\.md$/u
    )
    const absolutePath = path.join(workspace, active!.path)
    expect(fs.readFileSync(absolutePath, 'utf8')).toContain(marker)

    const sessionJson = fs.readFileSync(
      path.join(appData, 'sessions', sessionId, 'session.json'),
      'utf8'
    )
    expect(sessionJson).toContain(active!.path)
    expect(sessionJson).not.toContain(marker)
  })

  it('同一会话同标题修订原文件，新标题创建新的可读文件', async () => {
    await savePlanTool.execute({ title: 'Plan Mode', content: '# v1' }, context())
    const firstPath = store.load(sessionId)!.activePlan!.path

    await savePlanTool.execute({ title: 'Plan Mode', content: '# v2' }, context())
    expect(store.load(sessionId)!.activePlan!.path).toBe(firstPath)
    expect(fs.readFileSync(path.join(workspace, firstPath), 'utf8')).toBe('# v2\n')

    await savePlanTool.execute({ title: 'Default Handoff', content: '# next' }, context())
    const nextPath = store.load(sessionId)!.activePlan!.path
    expect(nextPath).not.toBe(firstPath)
    expect(nextPath).toContain('Default-Handoff')
    expect(fs.existsSync(path.join(workspace, firstPath))).toBe(true)
  })

  it('相同日期和标题的其他会话不会静默覆盖已有计划', async () => {
    await savePlanTool.execute({ title: '共享标题', content: '# first' }, context())
    const firstPath = store.load(sessionId)!.activePlan!.path

    const secondSession = store.create(workspace, 'plan')
    const secondContext = { ...context(), sessionId: secondSession.id }
    await savePlanTool.execute({ title: '共享标题', content: '# second' }, secondContext)
    const secondPath = store.load(secondSession.id)!.activePlan!.path

    expect(secondPath).not.toBe(firstPath)
    expect(secondPath).toMatch(/-2\.md$/u)
    expect(fs.readFileSync(path.join(workspace, firstPath), 'utf8')).toBe('# first\n')
  })

  it('拒绝被符号链接或 junction 重定向到工作区外的 .nova', async () => {
    const outside = path.join(tempRoot, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(workspace, '.nova'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await savePlanTool.execute({
      title: '越界计划',
      content: '# should not be written'
    }, context())

    expect(result.success).toBe(false)
    expect(result.error).toContain('符号链接')
    expect(fs.existsSync(path.join(outside, 'plans'))).toBe(false)
  })

  it('拒绝修订被外部硬链接共享的 active plan', async () => {
    await savePlanTool.execute({ title: '链接边界', content: '# original' }, context())
    const activePath = store.load(sessionId)!.activePlan!.path
    const absolutePath = path.join(workspace, activePath)
    const outsideLink = path.join(tempRoot, 'outside-plan.md')
    fs.linkSync(absolutePath, outsideLink)

    const result = await savePlanTool.execute({
      title: '链接边界',
      content: '# must not escape'
    }, context())

    expect(result.success).toBe(false)
    expect(result.error).toContain('硬链接')
    expect(fs.readFileSync(outsideLink, 'utf8')).toBe('# original\n')
  })

  it('文件名清理非法字符、控制长度并为纯标点标题提供回退名', () => {
    expect(toReadablePlanFilenamePart('  Plan: Auth / OAuth?  ')).toBe('Plan-Auth-OAuth')
    expect(toReadablePlanFilenamePart('***')).toBe('implementation-plan')
    expect(Array.from(toReadablePlanFilenamePart('测'.repeat(100))).length).toBe(64)
  })
})
