import { expect, test } from '../fixtures/nova'

test('会话准备完成后，preload 与 workspace IPC 指向本次隔离工作区', async ({ nova }) => {
  const workspace = await nova.getWorkspace()

  expect(workspace.currentProjectPath).toBe(nova.workspacePath)
  expect(workspace.currentSessionId).not.toBeNull()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})

test('输入框聚焦时仍只有眼睛跟随鼠标，字标与星星身体固定', async ({ nova }, testInfo) => {
  const { page } = nova
  const input = page.getByLabel('消息输入')
  const letters = page.locator('.welcome-wordmark__letters')
  const body = page.locator('.welcome-mascot__body')
  const eye = page.locator('.welcome-mascot__eye').first()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await input.focus()
  const initialLetters = await letters.boundingBox()
  const initialBody = await body.boundingBox()
  const eyeOffset = () => eye.evaluate(element => {
    if (!(element instanceof SVGEllipseElement)) throw new Error('眼睛元素不可用')
    const matrix = element.ownerSVGElement?.getScreenCTM()
    if (!matrix) throw new Error('眼睛坐标不可用')
    const rest = new DOMPoint(element.cx.baseVal.value, element.cy.baseVal.value).matrixTransform(matrix)
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2 - rest.x, y: rect.y + rect.height / 2 - rest.y }
  })
  for (const draft of ['', '目光跟随检查']) {
    if (draft) {
      await input.fill(draft)
      await expect.poll(async () => (await eyeOffset()).y).toBeGreaterThan(1)
      await expect.poll(async () => (await eyeOffset()).x).toBeCloseTo(0, 1)
    }
    await page.mouse.move(20, 200)
    await expect.poll(async () => (await eyeOffset()).x).toBeLessThan(-1)
    expect(await letters.boundingBox()).toEqual(initialLetters)
    expect(await body.boundingBox()).toEqual(initialBody)
    await page.locator('.welcome-wordmark').screenshot({ path: testInfo.outputPath('gaze-left.png') })
    await page.mouse.move(1180, 200)
    await expect.poll(async () => (await eyeOffset()).x).toBeGreaterThan(1)
    expect(await letters.boundingBox()).toEqual(initialLetters)
    expect(await body.boundingBox()).toEqual(initialBody)
    await page.locator('.welcome-wordmark').screenshot({ path: testInfo.outputPath('gaze-right.png') })
    await expect(input).toBeFocused()
  }
  await expect(input).toHaveText('目光跟随检查')
})

test('欢迎页只移动目光，重载与深浅色窄窗口下仍可输入', async ({ nova }, testInfo) => {
  const { page } = nova
  const wordmark = page.locator('.welcome-wordmark')
  const mascot = page.locator('.welcome-mascot')
  const body = page.locator('.welcome-mascot__body')
  const pupils = page.locator('.welcome-mascot__pupil')
  const input = page.getByLabel('消息输入')
  const screenGaze = () => pupils.first().evaluate(element => {
    if (!(element instanceof SVGGElement)) throw new Error('目光元素不可用')
    const matrix = element.ownerSVGElement?.getScreenCTM()
    const offset = element.transform.baseVal.consolidate()?.matrix
    if (!matrix || !offset) throw new Error('目光坐标不可用')
    return {
      x: matrix.a * offset.e + matrix.c * offset.f,
      y: matrix.b * offset.e + matrix.d * offset.f
    }
  })

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
      await page.setViewportSize(size)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width)
      await expect(wordmark).toBeVisible()
      await expect(mascot).toBeVisible()
      await expect(input).toBeEditable()
      const wordmarkBox = await wordmark.boundingBox()
      const inputBox = await input.boundingBox()
      if (!wordmarkBox || !inputBox) throw new Error('欢迎图形或输入框不可见')
      expect(wordmarkBox.width).toBeGreaterThan(300)
      expect(wordmarkBox.width).toBeLessThanOrEqual(480)
      expect(wordmarkBox.x).toBeGreaterThanOrEqual(0)
      expect(wordmarkBox.x + wordmarkBox.width).toBeLessThanOrEqual(size.width)
      expect(wordmarkBox.y + wordmarkBox.height).toBeLessThan(inputBox.y)
      expect(inputBox.y + inputBox.height).toBeLessThan(size.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
      const overlap = await page.evaluate(() => {
        const star = document.querySelector<SVGSVGElement>('.welcome-mascot')
        const letter = document.querySelector<SVGPathElement>('.welcome-wordmark__letters path:last-child')
        const starMatrix = star?.getScreenCTM()
        const letterMatrix = letter?.getScreenCTM()
        if (!starMatrix || !letterMatrix || !letter) throw new Error('字标坐标不可用')
        const inLetter = (x: number, y: number) => letter.isPointInFill(
          new DOMPoint(x, y).matrixTransform(starMatrix).matrixTransform(letterMatrix.inverse())
        )
        const eyes = Array.from(document.querySelectorAll<SVGEllipseElement>('.welcome-mascot__eye'))
        return {
          lowerTipsHidden: inLetter(28, 106) && inLetter(88, 108),
          eyesVisible: eyes.every(eye => !inLetter(eye.cx.baseVal.value, eye.cy.baseVal.value + eye.ry.baseVal.value + 2.4))
        }
      })
      expect(overlap).toEqual({ lowerTipsHidden: true, eyesVisible: true })
      const screenshot = testInfo.outputPath(`welcome-${theme}-${size.width}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`welcome-${theme}-${size.width}`, { path: screenshot, contentType: 'image/png' })
    }
  }

  await nova.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1200, 800)
  })
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(input).toBeEditable()
  await input.evaluate(element => element.blur())
  await page.mouse.move(1100, 180)
  await expect(pupils.first()).toHaveAttribute('transform', /^translate\([1-9]/)
  await input.fill('欢迎页输入检查')
  await expect(input).toHaveText('欢迎页输入检查')
  await expect.poll(async () => (await screenGaze()).y).toBeGreaterThan(1)
  await expect.poll(async () => (await screenGaze()).x).toBeCloseTo(0, 1)
  expect(nova.pageErrors).toEqual([])
})
