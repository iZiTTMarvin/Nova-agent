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

test('有名额的 http 弹窗开成内部标签，满员改走系统浏览器，非 http 丢弃', async ({ nova }) => {
  const fixture = await startPopupFixture()
  const extra = await startPopupFixture()
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
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(2)

    await openGuestWindow(nova, extra.popupUrl)
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(2)

    await openGuestWindow(nova, 'about:blank')
    await expect(nova.page.getByTestId('browser-tab')).toHaveCount(2)

    if (first.status === 'applied') {
      await nova.invoke(BROWSER_CLOSE, { sessionId: sessionId!, browserId: first.page.browserId })
    }
  } finally {
    await fixture.close()
    await extra.close()
  }
})
