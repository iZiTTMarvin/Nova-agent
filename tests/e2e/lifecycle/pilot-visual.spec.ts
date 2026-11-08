import { expect, test } from '../fixtures/nova'

test('领航视觉：空会话气泡、草稿退出、光晕、模式切换与深浅色真实 Electron 检验', async ({ nova }, testInfo) => {
  test.setTimeout(90_000)

  // 1. 初始为领航模式，空会话
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()
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

  // 3. 清空草稿，气泡恢复；退出领航模式回到默认模式
  await composerInput.fill('')
  await expect(bubble).toBeVisible()

  // 点击退出领航 Chip
  await nova.page.getByRole('button', { name: '退出 领航' }).click()
  // 默认模式下不应有领航光晕
  await expect(nova.page.locator('.chat-composer-box--pilot')).toHaveCount(0)
  // 普通模式空态气泡：引导试试领航
  await expect(bubble).toContainText('想让我多带你一步吗？')
  const tryPilotBtn = bubble.getByRole('button', { name: '试试领航' })
  await expect(tryPilotBtn).toBeVisible()

  const shotDefaultEmpty = testInfo.outputPath('default-light-empty.png')
  await nova.page.screenshot({ path: shotDefaultEmpty })
  await testInfo.attach('default-light-empty', { path: shotDefaultEmpty, contentType: 'image/png' })

  // 4. 点击“试试领航”，切回领航模式
  await tryPilotBtn.click()
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
