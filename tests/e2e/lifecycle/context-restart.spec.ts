import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVE_MODEL_CONFIG } from '../../../src/shared/ipc/channels'
import { expect, launchNova, test } from '../fixtures/nova'
import { createLearnSession, sendLearningPrompt, waitLearnTurnSettled } from '../learning/learningFlow'

test('领航拒绝模型发起的模式切换，完成与重载后仍保持领航', async ({ nova }) => {
  const state = await nova.createSession('pilot')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('pilot session id missing')
  nova.provider.enqueue(
    { kind: 'tool', name: 'save_plan', arguments: { title: '项目分析', content: '# 项目分析\n\n- 复核入口' }, callId: 'pilot-plan' },
    { kind: 'tool', name: 'switch_mode', arguments: { mode: 'plan', reason: '先做规划' }, callId: 'switch-from-pilot' },
    { kind: 'text', text: 'NOVA_PILOT_MODE_PRESERVED' }
  )

  await nova.sendPrompt('分析项目并继续工作')
  await expect(nova.page.getByText('NOVA_PILOT_MODE_PRESERVED', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot(sessionId))?.pendingInteractions).toEqual([])
  expect((await nova.getWorkspace()).currentMode).toBe('pilot')

  await nova.page.reload()
  await expect(nova.page.getByText('NOVA_PILOT_MODE_PRESERVED', { exact: false })).toBeVisible()
  expect((await nova.getWorkspace()).currentMode).toBe('pilot')
  expect(nova.pageErrors).toEqual([])
})

test('旧学习会话升级与再次启动后仍恢复学习界面和历史', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  try {
    const sessionId = await createLearnSession(nova)
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_LEARNING_BEFORE_UPGRADE' })
    await sendLearningPrompt(nova, '解释这个项目的入口')
    await expect(nova.page.getByText('NOVA_LEARNING_BEFORE_UPGRADE', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)
    await nova.app.close()

    const sessionPath = path.join(nova.profileRoot, 'userData', 'sessions', sessionId, 'session.json')
    const metadata = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>
    await writeFile(sessionPath, JSON.stringify({ ...metadata, schemaVersion: 22 }), 'utf8')

    for (let attempt = 0; attempt < 2; attempt++) {
      nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
      await expect(nova.page.getByLabel('学习提问')).toBeVisible()
      await expect(nova.page.getByText('NOVA_LEARNING_BEFORE_UPGRADE', { exact: false })).toBeVisible()
      expect(await nova.getWorkspace()).toMatchObject({ currentSessionId: sessionId, currentMode: 'learn' })
      expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toMatchObject({ schemaVersion: 23, mode: 'learn' })
      expect(nova.pageErrors).toEqual([])
      if (attempt === 0) await nova.app.close()
    }
  } finally {
    await nova.cleanup()
  }
})

test('领航会话的图片与失败恢复指令在重启后保持请求前缀，上下文在发送前可见', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  try {
    await nova.invoke(SAVE_MODEL_CONFIG, {
      baseUrl: nova.provider.baseUrl, apiKey: 'nova-e2e-key', modelId: 'MiniMax-M3',
      contextWindow: 200_000, supportsVision: true, cacheProfile: 'minimax', toolDialect: 'native'
    })
    await nova.createSession('pilot')
    await writeFile(path.join(nova.workspacePath, 'context.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWuoAAAAASUVORK5CYII=', 'base64'))
    nova.provider.enqueue({ kind: 'tool', name: 'read', arguments: { path: 'context.png' }, callId: 'image' })
    for (let i = 0; i < 4; i++) {
      nova.provider.enqueue({ kind: 'tool', name: 'read', arguments: { path: 'missing.txt' }, callId: `missing-${i}` })
    }
    await nova.sendPrompt('读取图片和项目文件，继续分析')
    await expect(nova.page.getByText('[已自动中断]', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(5)
    const before = nova.provider.requests.at(-1)!.body
    expect(JSON.stringify(before.messages)).toContain('data:image/png;base64,')
    expect(JSON.stringify(before.messages)).toContain('[Runtime guard]')
    await nova.app.close()
    nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
    await nova.page.locator('.context-indicator').hover()
    await expect(nova.page.locator('.context-popover__total')).not.toContainText('等待 LLM 调用')
    await expect(nova.page.locator('.context-popover__list')).toBeVisible()
    await nova.page.getByLabel('消息输入').hover()
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_CONTEXT_RESTART_OK' })
    await nova.sendPrompt('继续分析')
    await expect(nova.page.getByText('NOVA_CONTEXT_RESTART_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(6)
    const after = nova.provider.requests.at(-1)!.body
    if (!Array.isArray(before.messages) || !Array.isArray(after.messages)) throw new Error('Missing wire messages')
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect({ ...after, messages: null }).toEqual({ ...before, messages: null })
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
