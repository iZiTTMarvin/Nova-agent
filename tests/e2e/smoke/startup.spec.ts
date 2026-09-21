import { expect, test } from '../fixtures/nova'

test('会话准备完成后，preload 与 workspace IPC 指向本次隔离工作区', async ({ nova }) => {
  const workspace = await nova.getWorkspace()

  expect(workspace.currentProjectPath).toBe(nova.workspacePath)
  expect(workspace.currentSessionId).not.toBeNull()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})

test('欢迎页只移动目光，重载与深浅色窄窗口下仍可输入', async ({ nova }, testInfo) => {
  const { page } = nova
  const mascot = page.locator('.welcome-mascot')
  const body = page.locator('.welcome-mascot__body')
  const pupils = page.locator('.welcome-mascot__pupil')
  const input = page.getByLabel('消息输入')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(mascot).toBeVisible()
  await expect(pupils).toHaveCount(2)
  await input.evaluate(element => element.blur())
  const initialBody = await body.boundingBox()
  expect(initialBody).not.toBeNull()

  await page.mouse.move(1100, 180)
  await expect(pupils.first()).toHaveAttribute('transform', /^translate\([1-9]/)
  await expect(pupils.last()).toHaveAttribute('transform', /^translate\([1-9]/)
  expect(await body.boundingBox()).toEqual(initialBody)
  expect(await mascot.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0)

  await page.mouse.move(10, 180)
  await expect(pupils.first()).toHaveAttribute('transform', /^translate\(-/)
  expect(await body.boundingBox()).toEqual(initialBody)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(pupils.first()).toHaveAttribute('transform', 'translate(0.00 0.00)')
  await page.mouse.move(1100, 180)
  await expect(pupils.last()).toHaveAttribute('transform', 'translate(0.00 0.00)')

  for (const theme of ['light', 'dark'] as const) {
    await nova.invoke('settings:set', { theme })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    for (const size of [{ width: 1200, height: 800 }, { width: 900, height: 650 }]) {
      await nova.app.evaluate(({ BrowserWindow }, dimensions) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(dimensions.width, dimensions.height)
      }, size)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width)
      await expect(mascot).toBeVisible()
      await expect(input).toBeEditable()
      const mascotBox = await mascot.boundingBox()
      const inputBox = await input.boundingBox()
      if (!mascotBox || !inputBox) throw new Error('欢迎图形或输入框不可见')
      expect(mascotBox.width).toBeGreaterThan(100)
      expect(mascotBox.width).toBeLessThanOrEqual(176)
      expect(mascotBox.y + mascotBox.height).toBeLessThan(inputBox.y)
      expect(inputBox.y + inputBox.height).toBeLessThan(size.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
      const screenshot = testInfo.outputPath(`welcome-${theme}-${size.width}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`welcome-${theme}-${size.width}`, { path: screenshot, contentType: 'image/png' })
    }
  }

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(input).toBeEditable()
  await input.evaluate(element => element.blur())
  await page.mouse.move(880, 180)
  await expect(pupils.first()).toHaveAttribute('transform', /^translate\([1-9]/)
  await input.fill('欢迎页输入检查')
  await expect(input).toHaveText('欢迎页输入检查')
  expect(nova.pageErrors).toEqual([])
})
