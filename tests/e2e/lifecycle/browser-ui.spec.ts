import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '../fixtures/nova'
import { BROWSER_CLOSE, BROWSER_OPEN } from '../../../src/shared/ipc/channels'

async function startBrowseFixture(): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/two')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>two</title><body><h1>second</h1><input id="field" /></body>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>one</title><body style="background:#32c832"><h1>first</h1></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('可从地址栏打开、后退前进刷新停止并关闭，聊天仍可用', async ({ nova }) => {
  const fixture = await startBrowseFixture()
  try {
    await nova.page.getByRole('button', { name: '在 Nova 中打开' }).click()
    const address = nova.page.getByTestId('browser-address')
    await expect(address).toBeVisible()
    await address.fill(`${fixture.origin}/`)
    await address.press('Enter')
    await address.blur()

    const guest = nova.page.locator('webview[data-browser-id]')
    await expect(guest).toBeVisible()
    await expect(nova.page.getByTestId('browser-panel')).toBeVisible()

    await nova.page.getByRole('button', { name: '刷新' }).click()
    await expect(guest).toBeVisible()

    await address.fill(`${fixture.origin}/two`)
    await address.press('Enter')
    await address.blur()
    await expect.poll(async () => address.inputValue()).toContain('/two')

    await nova.page.getByRole('button', { name: '后退' }).click()
    await nova.page.getByRole('button', { name: '前进' }).click()

    const composer = nova.page.getByLabel('消息输入')
    await expect(composer).toBeVisible()

    // 浏览器是右侧面板页签：最后一页关闭后留在原处显示空态，聊天区始终可见
    await nova.page.getByRole('button', { name: '关闭页面' }).click()
    await expect(guest).toHaveCount(0)
    await expect(nova.page.getByTestId('browser-panel')).toBeVisible()
    await expect(nova.page.getByText('在地址栏输入网址开始浏览')).toBeVisible()
    await composer.click()
    await expect(composer).toBeFocused()
  } finally {
    await fixture.close()
  }
})

test('切会话只展示当前会话页面，连续 reload 后仍能挂上', async ({ nova }) => {
  const fixture = await startBrowseFixture()
  try {
    const workspace = await nova.getWorkspace()
    const sessionA = workspace.currentSessionId
    expect(sessionA).toBeTruthy()
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionA!,
      url: `${fixture.origin}/`
    })
    expect(opened.status).toBe('applied')
    const guest = nova.page.locator('webview[data-browser-id]')
    await expect(guest).toBeVisible()

    const next = await nova.createSession()
    expect(next.currentSessionId).not.toBe(sessionA)
    await expect(guest).toBeHidden()

    await nova.selectSession(sessionA!)
    await expect(guest).toBeVisible()

    await nova.page.reload()
    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    await nova.page.reload()
    await expect(nova.page.locator('webview[data-browser-id]')).toBeVisible()
    expect(nova.pageErrors).toEqual([])

    await nova.invoke(BROWSER_CLOSE, {
      sessionId: sessionA!,
      browserId: opened.status === 'applied' ? opened.page.browserId : ''
    })
  } finally {
    await fixture.close()
  }
})

test('会话页与用户页同列显示，用户上限如实提示，可单独关', async ({ nova }) => {
  const fixture = await startBrowseFixture()
  try {
    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()

    // AI 侧会话页面走隔离槽（上限 2）
    const first = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionId!,
      url: `${fixture.origin}/`
    })
    expect(first.status).toBe('applied')

    // 地址栏新页签是用户页面（持久用户 profile，不绑会话）
    await nova.page.getByTestId('browser-new-tab').click()
    const address = nova.page.getByTestId('browser-address')
    await address.fill(`${fixture.origin}/two`)
    await address.press('Enter')
    await address.blur()
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)

    // 用户页上限 4：再补 3 个用户页后到达上限
    for (let index = 0; index < 3; index++) {
      const opened = await nova.invoke(BROWSER_OPEN, {
        sessionId: null,
        url: `${fixture.origin}/two?tab=${index}`
      })
      expect(opened.status).toBe('applied')
    }
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(5)

    await nova.page.getByRole('button', { name: '最多同时打开四个页面' }).click()
    await expect(nova.page.getByTestId('browser-surface-error')).toHaveText('最多同时打开四个页面')

    await nova.page.getByTestId('browser-tab').first().getByTestId('browser-tab-close').click()
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(4)
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(4)
    await expect.poll(async () => address.inputValue()).toContain('/two')
  } finally {
    await fixture.close()
  }
})

test('用户页跨会话存活，AI 页随会话隔离，用户页没有接管按钮', async ({ nova }) => {
  const fixture = await startBrowseFixture()
  try {
    const workspace = await nova.getWorkspace()
    const sessionA = workspace.currentSessionId
    expect(sessionA).toBeTruthy()

    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionA!,
      url: `${fixture.origin}/`
    })
    expect(opened.status).toBe('applied')

    // 地址栏直接输入新网址：聚焦的是 AI 会话页，导航留在会话作用域
    const address = nova.page.getByTestId('browser-address')
    await expect.poll(async () => address.inputValue()).toContain(fixture.origin)
    await expect(nova.page.getByTestId('browser-takeover')).toBeVisible()

    // 新页签 = 用户页；接管按钮对用户页不出现
    await nova.page.getByTestId('browser-new-tab').click()
    await address.fill(`${fixture.origin}/two`)
    await address.press('Enter')
    await address.blur()
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)
    await expect(nova.page.getByTestId('browser-takeover')).toHaveCount(0)

    const next = await nova.createSession()
    expect(next.currentSessionId).not.toBe(sessionA)
    // 换会话后：AI 会话页隐藏，用户页仍可见
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(1)
    await expect(nova.page.getByTestId('browser-tab')).toContainText('two')
    const userGuest = nova.page.locator('webview[data-browser-id][partition="persist:nova-browser-user"]')
    await expect(userGuest).toBeVisible()

    await nova.selectSession(sessionA!)
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)
  } finally {
    await fixture.close()
  }
})

test('面板页签切走再切回，webview 隐藏后恢复且与舞台对齐', async ({ nova }) => {
  const fixture = await startBrowseFixture()
  try {
    const workspace = await nova.getWorkspace()
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: workspace.currentSessionId!,
      url: `${fixture.origin}/`
    })
    expect(opened.status).toBe('applied')
    const guest = nova.page.locator('webview[data-browser-id]')
    await expect(guest).toBeVisible()

    await nova.page.getByRole('tab', { name: '文件' }).click()
    await expect(guest).toBeHidden()
    await nova.page.getByRole('tab', { name: '浏览' }).click()
    await expect(guest).toBeVisible()

    // 页签切换不重挂 webview，且舞台对齐（历史坑：晚挂载后 0×0）
    await expect.poll(async () => {
      const slot = await nova.page.getByTestId('browser-guest-slot').boundingBox()
      const webview = await guest.boundingBox()
      if (!slot || !webview) return false
      return Math.abs(slot.width - webview.width) < 4 && Math.abs(slot.height - webview.height) < 4
    }).toBe(true)

    // Ctrl+Alt+B 收起面板再展开，页面不丢
    await nova.page.keyboard.press('Control+Alt+B')
    await expect(nova.page.getByTestId('browser-panel')).toHaveCount(0)
    await nova.page.keyboard.press('Control+Alt+B')
    await expect(nova.page.getByTestId('browser-panel')).toBeVisible()
    await expect(guest).toBeVisible()
    expect(nova.pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('加载失败显示错误与重试', async ({ nova }) => {
  const live = await startBrowseFixture()
  const dead = await startBrowseFixture()
  const deadUrl = `${dead.origin}/`
  await dead.close()
  try {
    const workspace = await nova.getWorkspace()
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: workspace.currentSessionId!,
      url: `${live.origin}/`
    })
    expect(opened.status).toBe('applied')
    await expect(nova.page.locator('webview[data-browser-id]')).toBeVisible()

    const address = nova.page.getByTestId('browser-address')
    await address.fill(deadUrl)
    await address.press('Enter')
    await address.blur()

    const error = nova.page.getByTestId('browser-load-error')
    await expect(error).toBeVisible({ timeout: 20_000 })
    await expect(error.getByText('无法打开该页面')).toBeVisible()
    await nova.page.getByTestId('browser-load-error-retry').click()
    await expect(error).toBeVisible()
  } finally {
    await live.close()
  }
})

test('设置浮层盖住网页，缩放后舞台仍对齐', async ({ nova }) => {
  const fixture = await startBrowseFixture()
  try {
    const workspace = await nova.getWorkspace()
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: workspace.currentSessionId!,
      url: `${fixture.origin}/`
    })
    expect(opened.status).toBe('applied')
    const guest = nova.page.locator('webview[data-browser-id]')
    await expect(guest).toBeVisible()

    await nova.page.getByRole('button', { name: '设置' }).click()
    const settings = nova.page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible()
    const dialogBox = await settings.boundingBox()
    expect(dialogBox).toBeTruthy()
    const hit = await nova.page.evaluate(
      ({ x, y }) => {
        const node = document.elementFromPoint(x, y)
        return node?.tagName ?? null
      },
      { x: dialogBox!.x + dialogBox!.width / 2, y: dialogBox!.y + dialogBox!.height / 2 }
    )
    expect(hit === 'WEBVIEW').toBe(false)

    await nova.page.getByRole('button', { name: '返回应用' }).click()
    await expect(settings).toBeHidden()

    await nova.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('missing window')
      win.webContents.setZoomFactor(1.5)
    })
    await expect.poll(async () => {
      const slot = await nova.page.getByTestId('browser-guest-slot').boundingBox()
      const webview = await guest.boundingBox()
      if (!slot || !webview) return false
      return Math.abs(slot.width - webview.width) < 4 && Math.abs(slot.height - webview.height) < 4
    }).toBe(true)
  } finally {
    await nova.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.webContents.setZoomFactor(1)
    })
    await fixture.close()
  }
})
