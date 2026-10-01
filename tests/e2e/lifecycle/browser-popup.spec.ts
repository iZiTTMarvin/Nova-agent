import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import { BROWSER_CLOSE, BROWSER_GET_SNAPSHOT, BROWSER_NAVIGATE, BROWSER_OPEN } from '../../../src/shared/ipc/channels'

async function startPopupFixture(redirectTo?: string): Promise<{
  origin: string
  popupUrl: string
  probeHits: () => number
  redirectHits: () => number
  close: () => Promise<void>
}> {
  let probeHits = 0
  let redirectHits = 0
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/held-image') return
    if (url === '/slow-page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>slow page</title><h1>Visible document</h1><img src="/held-image">')
      return
    }
    if (url === '/redirect-news') {
      res.writeHead(302, { location: '/popup' })
      res.end()
      return
    }
    if (url.startsWith('/redirect-to-previous') && redirectTo) {
      redirectHits += 1
      res.writeHead(302, { location: `${redirectTo}/probe` })
      res.end()
      return
    }
    if (url.startsWith('/popup')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>popup</title><body><h1>popup</h1></body>')
      return
    }
    if (url.startsWith('/probe')) {
      probeHits += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>probe</title><p id="out">pending</p>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>host</title><body><h1>host</h1></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    popupUrl: `${origin}/popup`,
    probeHits: () => probeHits,
    redirectHits: () => redirectHits,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
}

async function openGuestWindow(nova: NovaHarness, url: string, sourceUrl?: string): Promise<void> {
  await nova.app.evaluate(async ({ webContents }, { target, sourceUrl }) => {
    const guest = webContents.getAllWebContents().find((item) => {
      try {
        return item.getType() === 'webview' && !item.isDestroyed() && (!sourceUrl || item.getURL() === sourceUrl)
      } catch {
        return false
      }
    })
    if (!guest) throw new Error('没有已挂载的网页 guest')
    await guest.executeJavaScript(`window.open(${JSON.stringify(target)}, "_blank")`)
  }, { target: url, sourceUrl })
}

async function probeFetch(nova: NovaHarness, url: string): Promise<string> {
  return nova.app.evaluate(async ({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((item) => {
      try {
        return item.getType() === 'webview' && !item.isDestroyed()
      } catch {
        return false
      }
    })
    if (!guest) throw new Error('没有已挂载的网页 guest')
    return guest.executeJavaScript(`Promise.race([
      fetch(${JSON.stringify(target)}).then(() => 'allowed').catch(() => 'blocked'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1500))
    ])`)
  }, url)
}

test('弹窗默认拒绝并显示来源，确认后才在当前页打开', async ({ nova }) => {
  const fixture = await startPopupFixture()
  try {
    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()

    const first = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionId!,
      url: `${fixture.origin}/`
    })
    expect(first.status).toBe('applied')
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(1)

    await openGuestWindow(nova, fixture.popupUrl)
    const notice = nova.page.getByTestId('browser-guest-notice')
    await expect(notice).toContainText(fixture.popupUrl)
    await expect(notice).toContainText(fixture.origin)
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(1)

    await nova.page.getByTestId('browser-popup-open').click()
    await expect(nova.page.getByTestId('browser-tab')).toContainText('popup')
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(1)

    await openGuestWindow(nova, 'about:blank')
    await expect(notice).toContainText('不是 http')
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(1)

    if (first.status === 'applied') {
      await nova.invoke(BROWSER_CLOSE, { sessionId: sessionId!, browserId: first.page.browserId })
    }
  } finally {
    await fixture.close()
  }
})

test('用户地址栏接受网站重定向，页面显示后没有 AI 就绪超时报错', async ({ nova }) => {
  const fixture = await startPopupFixture()
  try {
    await nova.invoke(BROWSER_OPEN, { sessionId: null, url: `${fixture.origin}/` })
    await expect(nova.page.getByTestId('browser-tab')).toContainText('host')
    await nova.page.getByTestId('browser-address').fill(`${fixture.origin}/redirect-news`)
    await nova.page.getByRole('button', { name: '访问网址', exact: true }).click()
    await expect(nova.page.getByTestId('browser-tab')).toContainText('popup')
    await expect(nova.page.getByRole('button', { name: '访问网址', exact: true })).toBeEnabled({ timeout: 12_000 })
    await expect(nova.page.getByTestId('browser-address')).toHaveValue(fixture.popupUrl)
    await expect(nova.page.getByTestId('browser-surface-error')).toHaveCount(0)
    await nova.page.getByRole('button', { name: '后退', exact: true }).click()
    await expect(nova.page.getByTestId('browser-tab')).toContainText('host')
    await nova.page.getByRole('button', { name: '前进', exact: true }).click()
    await expect(nova.page.getByTestId('browser-tab')).toContainText('popup')
    await expect(nova.page.getByTestId('browser-surface-error')).toHaveCount(0)
  } finally {
    await fixture.close()
  }
})

test('用户网页的新窗口链接打开用户页签，保留来源并遵守四页上限', async ({ nova }) => {
  const fixture = await startPopupFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId: null, url: `${fixture.origin}/` })
    expect(opened.status).toBe('applied')
    await expect(nova.page.getByTestId('browser-tab')).toContainText('host')
    await openGuestWindow(nova, fixture.popupUrl, `${fixture.origin}/`)
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)
    await expect(nova.page.getByTestId('browser-address')).toHaveValue(fixture.popupUrl)
    await expect(nova.page.getByTestId('browser-guest-notice')).toHaveCount(0)
    const snapshot = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId: null })
    expect(snapshot.status).toBe('applied')
    if (snapshot.status !== 'applied') throw new Error('没有浏览器快照')
    expect(snapshot.snapshot.pages.map(page => page.sessionId)).toEqual([null, null])
    expect(snapshot.snapshot.pages[0]?.url).toBe(`${fixture.origin}/`)
    expect(await nova.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const sessionId = (await nova.getWorkspace()).currentSessionId!
    const aiSnapshot = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId })
    expect(aiSnapshot).toMatchObject({ status: 'applied', snapshot: { pages: [] } })
    await openGuestWindow(nova, 'about:blank', `${fixture.origin}/`)
    await nova.page.getByTestId('browser-tab').first().click()
    await expect(nova.page.getByTestId('browser-guest-notice')).toHaveCount(0)
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)
    for (let i = 0; i < 2; i++) {
      expect(await nova.invoke(BROWSER_OPEN, { sessionId: null, url: `${fixture.origin}/probe?tab=${i}` }))
        .toMatchObject({ status: 'applied' })
    }
    await openGuestWindow(nova, `${fixture.popupUrl}?overflow`, `${fixture.origin}/`)
    await nova.page.getByTestId('browser-tab').first().click()
    await expect(nova.page.getByTestId('browser-guest-notice')).toContainText('最多同时打开四个页面')
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(4)
  } finally {
    await fixture.close()
  }
})

test('用户页面子资源未结束时仍可停止加载和再次访问', async ({ nova }) => {
  const fixture = await startPopupFixture()
  try {
    await nova.invoke(BROWSER_OPEN, { sessionId: null, url: `${fixture.origin}/` })
    await expect(nova.page.getByTestId('browser-tab')).toContainText('host')
    await nova.page.getByTestId('browser-address').fill(`${fixture.origin}/slow-page`)
    await nova.page.getByRole('button', { name: '访问网址', exact: true }).click()
    await expect(nova.page.getByTestId('browser-tab')).toContainText('slow page')
    await expect(nova.page.getByRole('button', { name: '访问网址', exact: true })).toBeEnabled()
    await nova.page.getByRole('button', { name: '停止加载', exact: true }).click()
    await expect(nova.page.getByRole('button', { name: '刷新', exact: true })).toBeVisible()
    await nova.page.getByTestId('browser-address').fill(fixture.popupUrl)
    await nova.page.getByTestId('browser-address').press('Enter')
    await expect(nova.page.getByTestId('browser-tab')).toContainText('popup')
    await expect(nova.page.getByTestId('browser-surface-error')).toHaveCount(0)
  } finally {
    await fixture.close()
  }
})

test('已确认的本机页面仍不能请求元数据或其它私网地址', async ({ nova }) => {
  const fixture = await startPopupFixture()
  try {
    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionId!,
      url: `${fixture.origin}/probe`
    })
    expect(opened.status).toBe('applied')
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(1)

    expect(await probeFetch(nova, `${fixture.origin}/`)).toBe('allowed')
    expect(await probeFetch(nova, 'http://169.254.169.254/latest/meta-data')).toBe('blocked')
    expect(await probeFetch(nova, 'http://10.1.2.3/secret')).toBe('blocked')
    expect(await probeFetch(nova, 'http://192.168.1.20/secret')).toBe('blocked')
  } finally {
    await fixture.close()
  }
})

test('本机预览授权不被后续页面重定向借用，后退前进仍可访问已打开页面', async ({ nova }) => {
  const first = await startPopupFixture()
  const second = await startPopupFixture(first.origin)
  try {
    const sessionId = (await nova.getWorkspace()).currentSessionId
    expect(sessionId).toBeTruthy()
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId: sessionId!, url: `${first.origin}/probe` })
    expect(opened.status).toBe('applied')
    if (opened.status !== 'applied') return
    const browserId = opened.page.browserId
    const currentUrl = async (): Promise<string | null> => {
      const result = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId: sessionId! })
      return result.status === 'applied'
        ? result.snapshot.pages.find((page) => page.browserId === browserId)?.url ?? null
        : null
    }
    await expect.poll(async () => nova.app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview')
      return guest?.navigationHistory.getAllEntries().at(-1)?.url ?? null
    })).toBe(`${first.origin}/probe`)

    await expect(nova.invoke(BROWSER_NAVIGATE, {
      sessionId: sessionId!, browserId, action: { kind: 'url', url: second.popupUrl }
    })).resolves.toMatchObject({ status: 'applied' })
    await expect.poll(currentUrl).toBe(second.popupUrl)
    await expect(nova.invoke(BROWSER_NAVIGATE, {
      sessionId: sessionId!, browserId, action: { kind: 'back' }
    })).resolves.toMatchObject({ status: 'applied' })
    await expect.poll(currentUrl).toBe(`${first.origin}/probe`)
    await expect(nova.invoke(BROWSER_NAVIGATE, {
      sessionId: sessionId!, browserId, action: { kind: 'forward' }
    })).resolves.toMatchObject({ status: 'applied' })
    await expect.poll(currentUrl).toBe(second.popupUrl)

    const beforeRedirect = first.probeHits()
    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: sessionId!, browserId,
      action: { kind: 'url', url: `${second.origin}/redirect-to-previous` }
    })
    await expect.poll(second.redirectHits).toBe(1)
    expect(first.probeHits()).toBe(beforeRedirect)
    await nova.invoke(BROWSER_CLOSE, { sessionId: sessionId!, browserId })
  } finally {
    await second.close()
    await first.close()
  }
})
