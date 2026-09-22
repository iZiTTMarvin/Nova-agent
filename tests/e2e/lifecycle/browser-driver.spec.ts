import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import {
  BROWSER_ACT,
  BROWSER_CAPTURE,
  BROWSER_CLAIM,
  BROWSER_NAVIGATE,
  BROWSER_OBSERVE,
  BROWSER_OPEN
} from '../../../src/shared/ipc/channels'
import type { BrowserObserveResult } from '../../../src/shared/browser'

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

async function startFixture(): Promise<{ origin: string; held: () => boolean; releaseHold: () => void; close: () => Promise<void> }> {
  let seenHold = false
  let releaseHold = (): void => {
    seenHold = true
  }
  const pending = new Promise<void>((resolve) => {
    releaseHold = () => {
      seenHold = true
      resolve()
    }
  })
  const routes: Record<string, string> = {
    '/doc': page('DocTitle', '<p id="copy">主框架正文-ALPHA</p>'),
    '/next': page('NextTitle', '<p>下一页</p>'),
    '/form': page('Form', `
      <input id="email" aria-label="邮箱">
      <button id="save" type="button">保存</button>
      <p id="out"></p>
      <script>
        document.getElementById('save').onclick = () => {
          document.getElementById('out').textContent = 'saved:' + document.getElementById('email').value;
        };
      </script>
    `),
    '/spa': page('Spa', `
      <div id="slot"><input id="email" aria-label="邮箱"></div>
      <button id="replace" type="button">替换</button>
      <button id="save" type="button">保存</button>
      <p id="out"></p>
      <script>
        document.getElementById('replace').onclick = () => {
          const input = document.createElement('input');
          input.id = 'email';
          input.setAttribute('aria-label', '邮箱');
          document.getElementById('slot').replaceChildren(input);
        };
        document.getElementById('save').onclick = () => {
          const field = document.getElementById('email');
          document.getElementById('out').textContent = 'saved:' + (field && 'value' in field ? field.value : '');
        };
      </script>
    `),
    '/scroll': page('Scroll', `
      <p id="pos">scrollpos:0</p>
      <div style="height:5000px"></div>
      <script>
        addEventListener('scroll', () => {
          document.getElementById('pos').textContent = 'scrollpos:' + Math.round(scrollY || document.scrollingElement.scrollTop || 0);
        }, { passive: true });
      </script>
    `),
    '/shot': page('Shot', '<div style="width:200px;height:120px;background:#32c832">shot</div>'),
    '/dialog': page('Dialog', `
      <button id="alert" type="button">弹出</button>
      <p id="state">idle</p>
      <script>
        document.getElementById('alert').onclick = () => {
          alert('lab-dialog');
          document.getElementById('state').textContent = 'alerted';
        };
      </script>
    `)
  }
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path === '/hold') {
      seenHold = true
      void pending.then(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('Held', '<p>held-page</p>'))
      })
      return
    }
    const html = routes[path]
    if (!html) {
      res.writeHead(404)
      res.end('missing')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    held: () => seenHold,
    releaseHold,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function openPage(nova: NovaHarness, url: string): Promise<{ sessionId: string; browserId: string }> {
  const workspace = await nova.getWorkspace()
  const sessionId = workspace.currentSessionId
  if (!sessionId) throw new Error('没有当前会话')
  const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url }) as { status: string; page?: { browserId: string } }
  expect(opened.status).toBe('applied')
  await nova.page.locator('webview[data-browser-id]').waitFor()
  return { sessionId: sessionId!, browserId: opened.page!.browserId }
}

test('内置浏览器可以阅读、填写、在替换节点后定位、导航、滚动和截图', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const doc = await openPage(nova, `${fixture.origin}/doc`)
    const observed = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(observed, JSON.stringify(observed)).toMatchObject({ status: 'applied' })
    if (observed.status !== 'applied') return
    expect(observed.snapshot.title).toBe('DocTitle')
    expect(observed.snapshot.summary).toContain('主框架正文-ALPHA')

    const moved = await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/form` }
    })
    const form = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(form, JSON.stringify({ moved, form })).toMatchObject({ status: 'applied' })
    if (form.status !== 'applied') return
    const email = form.snapshot.interactive.find((item) => item.name === '邮箱')
    const save = form.snapshot.interactive.find((item) => item.name === '保存')
    expect(email).toBeTruthy()
    expect(save).toBeTruthy()
    const filled = await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: form.observation,
      action: { kind: 'fill', ref: email!.ref, text: '你好' }
    }) as { status: string }
    expect(filled.status).toBe('applied')
    const saved = await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: form.observation,
      action: { kind: 'click', ref: save!.ref }
    }) as { status: string }
    expect(saved.status).toBe('applied')
    const formAfter = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(formAfter.status).toBe('applied')
    if (formAfter.status === 'applied') expect(formAfter.snapshot.summary).toContain('saved:你好')

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/spa` }
    })
    const spa = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(spa, JSON.stringify(spa)).toMatchObject({ status: 'applied' })
    if (spa.status !== 'applied') return
    const spaEmail = spa.snapshot.interactive.find((item) => item.name === '邮箱')
    const replace = spa.snapshot.interactive.find((item) => item.name === '替换')
    const spaSave = spa.snapshot.interactive.find((item) => item.name === '保存')
    expect(spaEmail && replace && spaSave).toBeTruthy()
    expect((await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: spa.observation,
      action: { kind: 'click', ref: replace!.ref }
    }) as { status: string }).status).toBe('applied')
    expect((await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: spa.observation,
      action: { kind: 'fill', ref: spaEmail!.ref, text: '之后' }
    }) as { status: string }).status).toBe('applied')
    expect((await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: spa.observation,
      action: { kind: 'click', ref: spaSave!.ref }
    }) as { status: string }).status).toBe('applied')
    const spaAfter = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(spaAfter.status).toBe('applied')
    if (spaAfter.status === 'applied') expect(spaAfter.snapshot.summary).toContain('saved:之后')

    const next = await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/next` }
    }) as { status: string }
    expect(next.status).toBe('applied')
    const nextView = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(nextView.status).toBe('applied')
    if (nextView.status === 'applied') expect(nextView.snapshot.title).toBe('NextTitle')

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/scroll` }
    })
    const beforeScroll = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(beforeScroll.status).toBe('applied')
    if (beforeScroll.status !== 'applied') return
    const scrolled = await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: beforeScroll.observation,
      action: { kind: 'scroll', direction: 'down', amount: 'page' }
    }) as { status: string; summary?: string; detail?: string }
    expect(scrolled.status, scrolled.detail).toBe('applied')
    const afterScroll = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(afterScroll.status).toBe('applied')
    if (afterScroll.status === 'applied') {
      expect(afterScroll.snapshot.summary).toMatch(/scrollpos:[1-9]/)
    }

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/shot` }
    })
    const shotView = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(shotView.status).toBe('applied')
    if (shotView.status !== 'applied') return
    const firstShot = await nova.invoke(BROWSER_CAPTURE, {
      sessionId: doc.sessionId,
      observation: shotView.observation
    }) as { status: string; width?: number; height?: number; image?: { base64: string } }
    const secondShot = await nova.invoke(BROWSER_CAPTURE, {
      sessionId: doc.sessionId,
      observation: shotView.observation
    }) as { status: string; width?: number; height?: number; image?: { base64: string } }
    expect(firstShot.status).toBe('applied')
    expect(secondShot.status).toBe('applied')
    expect(firstShot.width).toBe(secondShot.width)
    expect(firstShot.height).toBe(secondShot.height)
    const png = Buffer.from(firstShot.image?.base64 ?? '', 'base64')
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    expect(png.readUInt32BE(16)).toBe(firstShot.width)
    expect(png.readUInt32BE(20)).toBe(firstShot.height)
  } finally {
    await fixture.close()
  }
})

test('导航进行中接管后，迟到的加载不会记成成功', async ({ nova }) => {
  const fixture = await startFixture()
  try {
    const doc = await openPage(nova, `${fixture.origin}/doc`)
    const pending = nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/hold` }
    })
    await expect.poll(() => fixture.held(), { timeout: 8_000 }).toBe(true)
    const claimed = await nova.invoke(BROWSER_CLAIM, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as { status: string }
    expect(claimed.status).toBe('applied')
    fixture.releaseHold()
    const loaded = await pending as { status: string; code?: string }
    expect(loaded.status).not.toBe('applied')
    expect(loaded.code === 'taken_over' || loaded.code === 'cancelled' || loaded.status === 'outcome_unknown').toBe(true)
  } finally {
    await fixture.close()
  }
})

test('对话框在 Page.enable 下能结束，DevTools 断开后不再挂起', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const acceptDialog = (dialog: { accept: () => Promise<void> }): void => {
      void dialog.accept().catch(() => undefined)
    }
    const bindDialogs = (page: { on: (event: 'dialog', handler: (dialog: { accept: () => Promise<void> }) => void) => void }): void => {
      page.on('dialog', acceptDialog)
    }
    bindDialogs(nova.page)
    nova.page.context().on('page', bindDialogs)
    for (const page of nova.page.context().pages()) bindDialogs(page)
    const doc = await openPage(nova, `${fixture.origin}/dialog`)
    for (const page of nova.page.context().pages()) bindDialogs(page)
    const view = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    expect(view.status).toBe('applied')
    if (view.status !== 'applied') return
    const button = view.snapshot.interactive.find((item) => item.name === '弹出')
    expect(button).toBeTruthy()
    const clicked = await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: view.observation,
      action: { kind: 'click', ref: button!.ref }
    }) as { status: string; code?: string; detail?: string }
    const after = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as BrowserObserveResult
    const summary = after.status === 'applied' ? after.snapshot.summary : ''
    console.log(JSON.stringify({
      dialogProduct: { click: clicked, observe: after.status, summary }
    }))
    expect(clicked.status === 'applied' || clicked.code === 'timeout' || clicked.status === 'outcome_unknown').toBe(true)
    expect(summary).toContain('alerted')

    await nova.page.locator('webview[data-browser-id]').evaluate((node) => {
      const viewNode = node as unknown as { openDevTools?: () => void }
      viewNode.openDevTools?.()
    })
    const started = Date.now()
    const detached = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as { status: string; code?: string; detail?: string }
    const elapsedMs = Date.now() - started
    console.log(JSON.stringify({ devtools: { ...detached, elapsedMs } }))
    expect(elapsedMs).toBeLessThan(5_000)
    expect(detached.status === 'applied' || detached.code === 'debugger_detached').toBe(true)
    await nova.page.locator('webview[data-browser-id]').evaluate((node) => {
      const viewNode = node as unknown as { closeDevTools?: () => void }
      viewNode.closeDevTools?.()
    }).catch(() => undefined)

    const guestId = await nova.page.locator('webview[data-browser-id]').evaluate((node) => {
      const viewNode = node as unknown as { getWebContentsId?: () => number }
      return viewNode.getWebContentsId?.() ?? 0
    })
    expect(guestId).toBeGreaterThan(0)
    const bare = await nova.app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id)
      if (!guest) return { missing: true as const }
      try {
        if (guest.debugger.isAttached()) guest.debugger.detach()
      } catch {
        // 已经释放
      }
      const probeStarted = Date.now()
      let dialogs = 0
      const onMessage = (_event: unknown, method: string): void => {
        if (method === 'Page.javascriptDialogOpening') dialogs += 1
      }
      guest.debugger.on('message', onMessage)
      guest.debugger.attach('1.3')
      const outcome = await Promise.race([
        guest.debugger.sendCommand('Runtime.evaluate', {
          expression: 'alert("bare"); "done"',
          awaitPromise: true,
          returnByValue: true
        }).then(() => 'resolved').catch((error: unknown) => (
          error instanceof Error ? `error:${error.message}` : 'error'
        )),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2_500))
      ])
      guest.debugger.off('message', onMessage)
      try {
        if (guest.debugger.isAttached()) guest.debugger.detach()
      } catch {
        // 探测结束
      }
      return { missing: false as const, outcome, dialogs, elapsedMs: Date.now() - probeStarted }
    }, guestId)
    console.log(JSON.stringify({ dialogBare: bare }))
    expect(bare.missing).toBe(false)
    if (!bare.missing) expect(bare.elapsedMs).toBeLessThan(4_000)
    const startedAfterDetach = Date.now()
    const afterDetach = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId
    }) as { status: string; code?: string; detail?: string }
    const afterDetachMs = Date.now() - startedAfterDetach
    console.log(JSON.stringify({ afterRealDetach: { ...afterDetach, elapsedMs: afterDetachMs } }))
    expect(afterDetachMs).toBeLessThan(5_000)
    expect(afterDetach).toMatchObject({ status: 'not_applied', code: 'debugger_detached' })
  } finally {
    await fixture.close()
  }
})
