import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import { BROWSER_CLOSE, BROWSER_OPEN } from '../../../src/shared/ipc/channels'

async function startPopupFixture(): Promise<{
  origin: string
  popupUrl: string
  close: () => Promise<void>
}> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/popup')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>popup</title><body><h1>popup</h1></body>')
      return
    }
    if (url.startsWith('/probe')) {
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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function openGuestWindow(nova: NovaHarness, url: string): Promise<void> {
  await nova.app.evaluate(async ({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((item) => {
      try {
        return item.getType() === 'webview' && !item.isDestroyed()
      } catch {
        return false
      }
    })
    if (!guest) throw new Error('没有已挂载的网页 guest')
    await guest.executeJavaScript(`window.open(${JSON.stringify(target)}, "_blank")`)
  }, url)
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
