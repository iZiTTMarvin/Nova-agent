import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVE_MODEL_CONFIG } from '../../../src/shared/ipc/channels'
import type { NovaSkillApi } from '../../../src/shared/skills/types'
import { expect, launchNova, test } from '../fixtures/nova'

test('干净安装默认领航，经受保护方法读取工作流，删除最后会话后保持默认入口', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, { skipWorkspaceSetup: true })
  try {
    expect((await nova.invoke('settings:get')).defaultMode).toBe('pilot')
    expect(await nova.getWorkspace()).toMatchObject({ currentSessionId: null, currentMode: 'pilot' })
    await nova.invoke(SAVE_MODEL_CONFIG, {
      baseUrl: nova.provider.baseUrl, apiKey: 'nova-e2e-key', modelId: 'nova-e2e-model',
      cacheProfile: 'generic', toolDialect: 'native'
    })
    const counterfeit = path.join(nova.workspacePath, '.nova', 'skills', 'nova-pilot')
    await mkdir(counterfeit, { recursive: true })
    await writeFile(path.join(counterfeit, 'SKILL.md'), '---\nname: nova-pilot\ndescription: project override\n---\nFORGED_PILOT_BODY\n')
    await nova.invoke('workspace:select-project', { path: nova.workspacePath })
    await nova.invoke('skill:reload', nova.workspacePath)
    await nova.page.reload()
    await expect(nova.page.locator('[data-testid="active-mode-chip"]')).toContainText('领航')

    let step = 0
    nova.provider.setTurnFactory(record => {
      if (step++ === 0) {
        expect(JSON.stringify(record.body.messages)).toContain('builtin:nova-pilot')
        return { kind: 'tool', name: 'invoke_skill', arguments: { skill_name: 'builtin:nova-pilot', task: '调查项目入口' }, callId: 'pilot-method' }
      }
      const messages = record.body.messages
      if (!Array.isArray(messages)) throw new Error('Missing wire messages')
      if (step === 2) {
        const method = messages.find(message => message.role === 'tool' && message.tool_call_id === 'pilot-method')
        if (typeof method?.content !== 'string') throw new Error('Missing pilot method result')
        expect(method.content).not.toContain('FORGED_PILOT_BODY')
        const directory = method.content.match(/`([^`]+)\/workflows\/`/)?.[1]
        if (!directory) throw new Error('Missing builtin workflow directory')
        expect(path.relative(counterfeit, directory)).not.toBe('')
        return { kind: 'tool', name: 'read', arguments: { path: path.join(directory, 'workflows', 'general.md') }, callId: 'pilot-workflow' }
      }
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'tool', tool_call_id: 'pilot-workflow', content: expect.stringContaining('# General development method') })
      ]))
      return { kind: 'text', text: 'NOVA_PILOT_ENTRY_VERIFIED' }
    })
    await nova.sendPrompt('调查项目入口并继续')
    await expect(nova.page.getByText('NOVA_PILOT_ENTRY_VERIFIED', { exact: true })).toBeVisible()
    await nova.waitUntilIdle()
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
    await nova.page.screenshot({ path: testInfo.outputPath('pilot-entry.png') })
    const sessionId = (await nova.getWorkspace()).currentSessionId
    if (!sessionId) throw new Error('Missing session')
    expect(await nova.invoke('workspace:delete-session', { sessionId })).toMatchObject({ currentSessionId: null, currentMode: 'pilot' })
    expect((await nova.invoke('workspace:select-project', { path: nova.workspacePath })).currentMode).toBe('pilot')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})

test('已有普通会话重启后优先保留自身模式，新会话沿用当前选择', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  try {
    await nova.page.getByRole('button', { name: '添加工作流、上下文与工具' }).click()
    await nova.page.getByRole('menuitem', { name: '默认模式', exact: false }).click()
    await expect.poll(async () => (await nova.getWorkspace()).currentMode).toBe('default')
    await nova.runTurnToCompletion({ prompt: '保存普通会话', text: 'NOVA_DEFAULT_SESSION_KEPT' })
    const sessionId = (await nova.getWorkspace()).currentSessionId
    await nova.app.close()
    nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
    expect((await nova.invoke('settings:get')).defaultMode).toBe('pilot')
    expect(await nova.getWorkspace()).toMatchObject({ currentSessionId: sessionId, currentMode: 'default' })
    await expect(nova.page.getByText('NOVA_DEFAULT_SESSION_KEPT', { exact: true })).toBeVisible()
    expect((await nova.createSession()).currentMode).toBe('default')
    await nova.page.screenshot({ path: testInfo.outputPath('existing-default-entry.png') })
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})

test('领航的 Skill 许可阻断模型自动调用和未许可 Slash，历史正文在撤销与重启后保留', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  try {
    const sessionId = (await nova.getWorkspace()).currentSessionId
    if (!sessionId) throw new Error('Missing session')
    const skillDir = path.join(nova.workspacePath, '.nova', 'skills', 'pilot-domain')
    const body = 'PILOT_DOMAIN_BODY_PERSISTED'
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: pilot-domain\ndescription: PILOT_DOMAIN_DISCOVERY\n---\n${body}`)
    await nova.invoke('skill:reload', nova.workspacePath)
    const candidates = await nova.invoke('skill:list', { mode: 'default' })
    const selected = candidates.skills.find(skill => skill.name === 'pilot-domain')
    if (!selected) throw new Error('Missing default candidate')
    expect((await nova.invoke('skill:list', { mode: 'pilot' })).skills).toEqual([])
    const before = await nova.invoke('load-session-messages', { sessionId, limit: 100 })
    expect(await nova.invoke('send-message', { sessionId, content: '/pilot-domain' })).toMatchObject({ accepted: false, rejection: { reason: 'not_user_invocable' } })
    expect(await nova.getRunSnapshot()).toBeNull()
    expect(await nova.invoke('load-session-messages', { sessionId, limit: 100 })).toEqual(before)

    const otherWorkspace = path.join(nova.workspacePath, 'catalog-other')
    await mkdir(otherWorkspace)
    const other = await nova.invoke('workspace:create-session', { workspaceRoot: otherWorkspace })
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_BACKGROUND_CATALOG_READY' })
    await nova.invoke('send-message', { sessionId, content: '后台读取原工作区目录' })
    await expect.poll(async () => (await nova.getRunSnapshot(sessionId))?.status).toBe('completed')
    expect((await nova.getWorkspace()).currentSessionId).toBe(other.currentSessionId)
    expect((await nova.invoke('skill:list', { mode: 'default' })).skills.map(skill => skill.name)).not.toContain('pilot-domain')
    await nova.selectSession(sessionId)

    await nova.invoke('settings:set', { pilotSkillIds: [selected.skillId], pilotSkillGuideSeen: true })
    const permitted = await nova.page.evaluate(() => {
      const api = (window as typeof window & { nova?: { skill: NovaSkillApi } }).nova?.skill
      if (!api) throw new Error('Missing skill preload bridge')
      return api.list({ mode: 'pilot' })
    })
    expect(permitted.skills.map(skill => skill.skillId)).toEqual([selected.skillId])
    const modelRequestOffset = nova.provider.requests.length
    nova.provider.enqueue(
      { kind: 'tool', name: 'invoke_skill', arguments: { skill_name: 'pilot-domain', task: 'known name' }, callId: 'blocked-domain' },
      { kind: 'text', text: 'NOVA_MODEL_SKILL_BLOCKED' }
    )
    await nova.sendPrompt('尝试调用已知的领域技能')
    await expect(nova.page.getByText('NOVA_MODEL_SKILL_BLOCKED', { exact: true })).toBeVisible()
    await nova.waitUntilIdle()
    expect(JSON.stringify(nova.provider.requests[modelRequestOffset]?.body.messages)).not.toContain('PILOT_DOMAIN_DISCOVERY')
    expect(nova.provider.requests[modelRequestOffset + 1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'blocked-domain', content: expect.stringContaining('领航模式只允许模型调用') })
    ]))
    expect(JSON.stringify(nova.provider.requests[modelRequestOffset + 1]?.body.messages)).not.toContain(body)

    nova.provider.enqueue({ kind: 'text', text: 'NOVA_MANUAL_SKILL_ALLOWED' })
    await nova.sendPrompt('/pilot-domain 手动执行')
    await expect(nova.page.getByText('NOVA_MANUAL_SKILL_ALLOWED', { exact: true })).toBeVisible()
    await nova.waitUntilIdle()
    expect(JSON.stringify(nova.provider.requests.at(-1)?.body.messages)).toContain(body)
    const history = await nova.invoke('load-session-messages', { sessionId, limit: 100 })
    expect(history.messages.some(message => message.role === 'user' && message.content === '/pilot-domain 手动执行')).toBe(true)

    await rename(skillDir, path.join(nova.workspacePath, '.nova', 'skills', 'replaced-domain'))
    await nova.invoke('skill:reload', nova.workspacePath)
    const replacement = (await nova.invoke('skill:list', { mode: 'default' })).skills.find(skill => skill.name === 'pilot-domain')
    expect(replacement?.skillId).not.toBe(selected.skillId)
    expect((await nova.invoke('skill:list', { mode: 'pilot' })).skills).toEqual([])
    expect(await nova.invoke('send-message', { sessionId, content: '/pilot-domain' })).toMatchObject({ accepted: false })
    expect(await nova.invoke('load-session-messages', { sessionId, limit: 100 })).toEqual(history)
    await nova.invoke('settings:set', { pilotSkillIds: [] })
    await nova.app.close()
    nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
    expect(await nova.invoke('load-session-messages', { sessionId, limit: 100 })).toEqual(history)
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_PILOT_HISTORY_KEPT' })
    await nova.sendPrompt('继续当前任务')
    await expect(nova.page.getByText('NOVA_PILOT_HISTORY_KEPT', { exact: true })).toBeVisible()
    await nova.waitUntilIdle()
    expect(JSON.stringify(nova.provider.requests.at(-1)?.body.messages)).toContain(body)
    expect((await nova.getWorkspace()).currentMode).toBe('pilot')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
