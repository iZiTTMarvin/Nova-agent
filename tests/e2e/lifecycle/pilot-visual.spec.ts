import type { Page } from '@playwright/test'
import { expect, launchNova, test } from '../fixtures/nova'

test('普通模式的领航推荐可关闭，重载后不反复出现', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, { skipWorkspaceSetup: true })
  try {
    await nova.invoke('settings:set', { defaultMode: 'default' })
    await nova.invoke('workspace:select-project', { path: nova.workspacePath })
    await nova.page.reload()

    const bubble = nova.page.getByTestId('welcome-mascot-bubble')
    await expect(bubble).toContainText('想让我多带你一步吗？')
    await bubble.getByRole('button', { name: '关闭建议' }).click()
    await expect(bubble).toHaveCount(0)
    await expect.poll(async () => (await nova.invoke('settings:get')).pilotEntryGuideDismissed).toBe(true)
    await nova.page.reload()
    await expect(bubble).toHaveCount(0)
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})

// 描边层的强度系数随 color-scheme 切换；读不到说明样式查询失效或覆盖层未渲染
const readBeamStrokeGain = (page: Page) =>
  page.evaluate(() => {
    const beam = document.querySelector('.border-beam')
    return beam ? getComputedStyle(beam, '::after').getPropertyValue('--beam-layer-gain').trim() : null
  })

test('领航视觉：空会话气泡、草稿退出、光晕、模式切换与深浅色真实 Electron 检验', async ({ nova }, testInfo) => {
  test.setTimeout(90_000)

  // 1. 初始为领航模式，空会话
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()
  await expect(nova.page.locator('.chat-composer-box--pilot .border-beam')).toHaveCount(1)
  const lightStrokeGain = await readBeamStrokeGain(nova.page)
  const chip = nova.page.locator('[data-testid="active-mode-chip"]')
  await expect(chip).toContainText('领航')
  await expect(chip).toHaveClass(/mode-switch__chip--pilot/)

  const bubble = nova.page.getByTestId('welcome-mascot-bubble')
  await expect(bubble).toBeVisible()
  await expect(bubble).toContainText('把你的 idea 告诉我吧，我将替你完成一切！')

  const shotLightEmpty = testInfo.outputPath('pilot-light-empty.png')
  await nova.page.screenshot({ path: shotLightEmpty })
  await testInfo.attach('pilot-light-empty', { path: shotLightEmpty, contentType: 'image/png' })

  // 2. 有草稿：输入内容，气泡必须退出，光晕保持
  const composerInput = nova.page.getByLabel('消息输入')
  await composerInput.fill('一些临时草稿')
  await expect(bubble).toHaveCount(0)
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()

  const shotDraft = testInfo.outputPath('pilot-draft.png')
  await nova.page.screenshot({ path: shotDraft })
  await testInfo.attach('pilot-draft', { path: shotDraft, contentType: 'image/png' })

  // 3. 清空草稿，气泡恢复；明确退出领航后不再展示推荐，重载也不复发
  await composerInput.fill('')
  await expect(bubble).toBeVisible()
  await nova.page.getByRole('button', { name: '退出 领航' }).click()
  await expect(nova.page.locator('.chat-composer-box--pilot')).toHaveCount(0)
  await expect(nova.page.locator('.border-beam')).toHaveCount(0)
  await expect(bubble).toHaveCount(0)
  await expect.poll(async () => (await nova.invoke('settings:get')).pilotEntryGuideDismissed).toBe(true)

  const shotDefaultEmpty = testInfo.outputPath('default-light-empty.png')
  await nova.page.screenshot({ path: shotDefaultEmpty })
  await testInfo.attach('default-light-empty', { path: shotDefaultEmpty, contentType: 'image/png' })

  await nova.page.reload()
  await expect(nova.page.locator('.chat-composer-box--pilot')).toHaveCount(0)
  await expect(bubble).toHaveCount(0)

  // 4. 仍可从模式菜单主动切回领航
  await nova.page.getByRole('button', { name: '添加工作流、上下文与工具' }).click()
  await nova.page.getByRole('menuitem', { name: '领航模式' }).click()
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()
  await expect(chip).toContainText('领航')
  await expect(bubble).toContainText('把你的 idea 告诉我吧，我将替你完成一切！')

  // 5. 切换到计划模式 (plan)
  await nova.page.getByRole('button', { name: '添加工作流、上下文与工具' }).click()
  await nova.page.getByRole('menuitem', { name: '计划模式' }).click()
  await expect(chip).toContainText('Plan')
  await expect(nova.page.locator('.chat-composer-box--pilot')).toHaveCount(0)

  // 切回领航模式
  await nova.page.getByRole('button', { name: '退出 Plan' }).click()
  await nova.page.getByRole('button', { name: '添加工作流、上下文与工具' }).click()
  await nova.page.getByRole('menuitem', { name: '领航模式' }).click()
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()

  // 6. 切换到深色主题
  await nova.page.evaluate(() => localStorage.setItem('nova-settings-theme', 'dark'))
  await nova.invoke('settings:set', { theme: 'dark' })
  await nova.page.reload()
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()
  await expect(nova.page.getByTestId('welcome-mascot-bubble')).toBeVisible()

  // 流光强度系数随主题切换：浅色（步骤 1）与深色两侧都取到值且互不相同
  const darkStrokeGain = await readBeamStrokeGain(nova.page)
  expect(lightStrokeGain).toBeTruthy()
  expect(darkStrokeGain).toBeTruthy()
  expect(darkStrokeGain).not.toBe(lightStrokeGain)

  const shotDarkEmpty = testInfo.outputPath('pilot-dark-empty.png')
  await nova.page.screenshot({ path: shotDarkEmpty })
  await testInfo.attach('pilot-dark-empty', { path: shotDarkEmpty, contentType: 'image/png' })

  // 7. 运行中状态检验
  nova.provider.enqueue(
    { kind: 'tool', name: 'write', arguments: { path: 'test.txt', content: 'hello' }, callId: 'visual-write' },
    { kind: 'text', text: 'NOVA_VISUAL_OK' }
  )
  await nova.sendPrompt('执行一次运行中检验')
  const shotRunning = testInfo.outputPath('pilot-running.png')
  await nova.page.screenshot({ path: shotRunning })
  await testInfo.attach('pilot-running', { path: shotRunning, contentType: 'image/png' })

  await expect(nova.page.getByText('NOVA_VISUAL_OK', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()

  // 8. prefers-reduced-motion 检验
  await nova.page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()
  expect(nova.pageErrors).toEqual([])
})
