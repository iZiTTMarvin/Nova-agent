import { expect, test } from '../fixtures/nova'

test('思考强度点击和拖动松手后不闪回旧档位', async ({ nova }) => {
  await nova.invoke('save-llm-registry', {
    version: 2,
    providers: [{
      id: 'effort-provider', name: 'Effort', baseUrl: nova.provider.baseUrl,
      apiKey: 'nova-e2e-key', enabled: true,
      models: [{ id: 'minimax', modelId: 'MiniMax-M3', displayName: 'MiniMax-M3' }]
    }],
    activeModel: { providerId: 'effort-provider', modelEntryId: 'minimax' }
  })
  await nova.page.reload()
  await nova.page.getByRole('button', { name: '思考强度：High' }).click()
  const slider = nova.page.getByRole('slider', { name: '思考强度' })
  await slider.evaluate(element => {
    const label = element.parentElement?.querySelector('.effort-panel__value')
    if (!label) throw new Error('Missing effort label')
    new MutationObserver(() => {
      element.setAttribute('data-label-history', `${element.getAttribute('data-label-history') ?? ''}${label.textContent},`)
    }).observe(label, { subtree: true, childList: true, characterData: true })
  })
  const box = await slider.boundingBox()
  if (!box) throw new Error('Missing effort slider bounds')
  for (const gesture of ['click', 'drag']) {
    for (let index = 0; index < 6; index += 1) {
      const target = index % 2 === 0 ? 'Max' : 'High'
      const previousX = index % 2 === 0 ? box.x + 1 : box.x + box.width - 1
      const targetX = index % 2 === 0 ? box.x + box.width - 1 : box.x + 1
      await slider.evaluate(element => element.setAttribute('data-label-history', ''))
      await nova.page.mouse.move(gesture === 'drag' ? previousX : targetX, box.y + box.height / 2)
      await nova.page.mouse.down()
      if (gesture === 'drag') await nova.page.mouse.move(targetX, box.y + box.height / 2, { steps: 5 })
      await expect(slider).toHaveAttribute('aria-valuetext', target)
      await nova.page.mouse.up()
      await expect(slider).toHaveAttribute('aria-busy', 'false')
      expect(await slider.getAttribute('data-label-history')).toBe(`${target},`)
      expect((await nova.getWorkspace()).reasoningEffortOverride).toBe(target === 'Max' ? 'max' : null)
    }
  }
  expect(nova.pageErrors).toEqual([])
})

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
  await expect(nova.page.locator('.effort-slider__stop--default')).toHaveCount(1)
  await slider.press('End')
  await expect(slider).toHaveClass(/effort-slider--stellar/)
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
