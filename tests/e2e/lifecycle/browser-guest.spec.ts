import http from 'node:http'
import { AddressInfo } from 'node:net'
import { expect, test } from '../fixtures/nova'
import { BROWSER_OPEN } from '../../../src/shared/ipc/channels'

async function startGuestFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>guest</title><body style="background:#32c832">guest</body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('内置网页可被设置浮层挡住，reload 后仍能重新挂上', async ({ nova }) => {
  const fixture = await startGuestFixture()
  try {
    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()

    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionId!,
      url: fixture.url
    })
    expect(opened.status).toBe('applied')

    const guest = nova.page.locator('webview[data-browser-id]')
    await expect(guest).toBeVisible()
    const firstId = await guest.getAttribute('data-browser-id')
    expect(firstId).toBeTruthy()

    await nova.page.getByRole('button', { name: '设置' }).click()
    const settings = nova.page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible()

    const box = await guest.boundingBox()
    expect(box).toBeTruthy()
    const hit = await nova.page.evaluate(
      ({ x, y }) => {
        const node = document.elementFromPoint(x, y)
        return {
          tag: node?.tagName ?? null,
          settings: Boolean(node?.closest('[aria-label="设置"]'))
        }
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    )
    expect(hit.settings).toBe(true)
    expect(hit.tag === 'WEBVIEW').toBe(false)

    await nova.page.getByRole('button', { name: '返回应用' }).click()
    await expect(settings).toBeHidden()

    const composer = nova.page.getByLabel('消息输入')
    await composer.click()
    await expect(composer).toBeFocused()

    await nova.page.reload()
    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    await expect(nova.page.locator('webview[data-browser-id]')).toBeVisible()
    // 卸旧 webview 时 Electron 会抛 Invalid guestInstanceId，不是应用错误
    expect(
      nova.pageErrors.filter((error) => !error.includes('Invalid guestInstanceId'))
    ).toEqual([])
  } finally {
    await fixture.close()
  }
})
