import { expect, test } from '../fixtures/nova'

test('模型与思考强度按会话持久化，新会话继承当前显示值', async ({ nova }, testInfo) => {
  const providerId = 'provider-e2e-reasoning'
  const gptRef = { providerId, modelEntryId: 'gpt' }
  const minimaxRef = { providerId, modelEntryId: 'minimax' }

  await nova.invoke('save-llm-registry', {
    version: 2,
    providers: [{
      id: providerId,
      name: 'E2E Models',
      baseUrl: nova.provider.baseUrl,
      apiKey: 'nova-e2e-key',
      enabled: true,
      models: [
        { id: 'gpt', modelId: 'gpt-5.4', displayName: 'GPT-5.4' },
        { id: 'minimax', modelId: 'MiniMax-M3', displayName: 'MiniMax-M3' }
      ]
    }],
    activeModel: gptRef
  })
  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()

  await expect(nova.page.getByRole('button', { name: '切换模型' })).toContainText('GPT-5.4')
  await expect(nova.page.getByRole('button', { name: '思考强度：Medium' })).toBeVisible()

  await nova.page.getByRole('button', { name: '思考强度：Medium' }).click()
  const slider = nova.page.getByRole('slider', { name: '思考强度' })
  await expect(slider).toHaveAttribute('aria-valuemax', '3')
  await expect(nova.page.locator('.effort-slider__stop')).toHaveCount(4)
  await slider.press('End')
  await expect(nova.page.getByRole('button', { name: '思考强度：XHigh' })).toBeVisible()
  await slider.press('Escape')
  await expect(slider).toBeHidden()

  const original = await nova.getWorkspace()
  expect(original.currentSessionId).not.toBeNull()
  expect(original.activeModelRef).toEqual(gptRef)
  expect(original.reasoningEffortOverride).toBe('xhigh')

  const inherited = await nova.createSession('default')
  expect(inherited.activeModelRef).toEqual(gptRef)
  expect(inherited.reasoningEffortOverride).toBe('xhigh')

  await nova.page.getByRole('button', { name: '切换模型' }).click()
  const providerMenuItem = nova.page.getByRole('menuitem', { name: 'E2E Models', exact: true })
  await providerMenuItem.hover()
  await expect(nova.page.getByRole('menuitem', { name: 'MiniMax-M3', exact: true })).toBeVisible()
  await nova.page.getByRole('menuitem', { name: 'MiniMax-M3', exact: true }).click()
  await expect(nova.page.getByRole('button', { name: '切换模型' })).toContainText('MiniMax-M3')
  await expect(nova.page.getByRole('button', { name: '思考强度：High' })).toBeVisible()
  expect((await nova.getWorkspace()).activeModelRef).toEqual(minimaxRef)

  const requestCountBeforeSwitchProbe = nova.provider.requests.length
  nova.provider.enqueue({ kind: 'text', text: 'MODEL_SWITCH_WIRE_OK' })
  await nova.sendPrompt('验证切换后的模型请求')
  await nova.waitUntilIdle()
  expect(nova.provider.requests).toHaveLength(requestCountBeforeSwitchProbe + 1)
  expect(nova.provider.requests.at(-1)?.body.model).toBe('MiniMax-M3')

  await nova.page.getByRole('button', { name: '切换模型' }).click()
  await nova.page.getByRole('menuitem', { name: 'E2E Models', exact: true }).hover()
  await nova.page.getByRole('menuitem', { name: 'GPT-5.4', exact: true }).click()
  await expect(nova.page.getByRole('button', { name: '切换模型' })).toContainText('GPT-5.4')
  expect((await nova.getWorkspace()).activeModelRef).toEqual(gptRef)

  const requestCountBeforeSwitchBackProbe = nova.provider.requests.length
  nova.provider.enqueue({ kind: 'text', text: 'MODEL_SWITCH_BACK_WIRE_OK' })
  await nova.sendPrompt('验证切回后的模型请求')
  await nova.waitUntilIdle()
  expect(nova.provider.requests).toHaveLength(requestCountBeforeSwitchBackProbe + 1)
  expect(nova.provider.requests.at(-1)?.body.model).toBe('gpt-5.4')

  await nova.page.getByRole('button', { name: '切换模型' }).click()
  await nova.page.getByRole('menuitem', { name: 'E2E Models', exact: true }).hover()
  await nova.page.getByRole('menuitem', { name: 'MiniMax-M3', exact: true }).click()
  await expect(nova.page.getByRole('button', { name: '切换模型' })).toContainText('MiniMax-M3')

  await nova.page.getByRole('button', { name: '思考强度：High' }).click()
  await expect(nova.page.getByRole('slider', { name: '思考强度' }))
    .toHaveAttribute('aria-valuemax', '1')
  await expect(nova.page.locator('.effort-slider__stop')).toHaveCount(2)
  await nova.page.screenshot({ path: testInfo.outputPath('model-reasoning-controls.png') })

  await nova.page.reload()
  await expect(nova.page.getByRole('button', { name: '切换模型' })).toContainText('MiniMax-M3')
  await expect(nova.page.getByRole('button', { name: '思考强度：High' })).toBeVisible()

  await nova.selectSession(original.currentSessionId!)
  await expect(nova.page.getByRole('button', { name: '切换模型' })).toContainText('GPT-5.4')
  await expect(nova.page.getByRole('button', { name: '思考强度：XHigh' })).toBeVisible()

  const requestCountInOriginalSession = nova.provider.requests.length
  nova.provider.enqueue({ kind: 'text', text: 'MODEL_SESSION_ISOLATION_WIRE_OK' })
  await nova.sendPrompt('验证原会话仍使用原模型')
  await nova.waitUntilIdle()
  expect(nova.provider.requests).toHaveLength(requestCountInOriginalSession + 1)
  expect(nova.provider.requests.at(-1)?.body.model).toBe('gpt-5.4')

  expect(nova.pageErrors).toEqual([])
})
