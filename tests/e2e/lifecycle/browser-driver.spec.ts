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
      <button id="push" type="button">跳转</button>
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
        document.getElementById('push').onclick = () => {
          history.pushState({}, '', '/spa?view=next');
          document.getElementById('out').textContent = 'pushed';
        };
      </script>
    `),
    '/dupe': page('Dupe', `
      <button id="spawn-hidden" type="button">克隆隐藏</button>
      <button id="spawn-visible" type="button">克隆显示</button>
      <div id="target-wrap"><button type="button">保存</button></div>
      <p id="out">idle</p>
      <script>
        const spawn = (hidden) => {
          const wrap = document.getElementById('target-wrap');
          const copy = wrap.querySelector('button').cloneNode(true);
          copy.style.display = hidden ? 'none' : '';
          wrap.insertBefore(copy, wrap.querySelector('button'));
          document.getElementById('out').textContent = 'spawned';
        };
        document.getElementById('spawn-hidden').onclick = () => spawn(true);
        document.getElementById('spawn-visible').onclick = () => spawn(false);
        document.getElementById('target-wrap').addEventListener('click', (event) => {
          if (event.target instanceof HTMLButtonElement && event.target.textContent === '保存') {
            document.getElementById('out').textContent = 'saved';
          }
        });
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
    `),
    '/budget': (() => {
      const body = `
      <div id="filler"></div>
      <div id="controls"></div>
      <script>
        const params = new URLSearchParams(location.search);
        const fillerCount = Number(params.get('filler') || '3000');
        const buttonCount = Number(params.get('buttons') || '250');
        const filler = document.getElementById('filler');
        for (let index = 0; index < fillerCount; index += 1) {
          const node = document.createElement('div');
          node.className = 'fill';
          node.textContent = 'filler-' + index;
          filler.appendChild(node);
        }
        const controls = document.getElementById('controls');
        for (let index = 0; index < buttonCount; index += 1) {
          const node = document.createElement('button');
          node.type = 'button';
          node.textContent = 'btn-' + index;
          controls.appendChild(node);
        }
      </script>
    `
      return page('Budget', body)
    })(),
    '/frames': page('Frames', `
      <h1>外层页面</h1>
      <iframe id="inner" src="/doc" title="同源子页"></iframe>
    `),
    '/cover': page('Cover', `
      <div style="position:relative;height:120px">
        <button id="under" type="button" style="position:absolute;top:0;left:0">被盖住的按钮</button>
        <div id="veil" style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.2)"></div>
      </div>
      <p id="hit">idle</p>
      <script>
        document.getElementById('under').onclick = () => {
          document.getElementById('hit').textContent = 'clicked-under';
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

async function observePage(nova: NovaHarness, sessionId: string, browserId: string): Promise<Extract<BrowserObserveResult, { status: 'applied' }>> {
  const view = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
  expect(view, JSON.stringify(view)).toMatchObject({ status: 'applied' })
  if (view.status !== 'applied') throw new Error('观察失败')
  return view
}

test('内置浏览器可以阅读、填写、在替换节点后定位、导航、滚动和截图', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const doc = await openPage(nova, `${fixture.origin}/doc`)
    const observed = await observePage(nova, doc.sessionId, doc.browserId)
    expect(observed.snapshot.title).toBe('DocTitle')
    expect(observed.snapshot.dom).toContain('主框架正文-ALPHA')
    expect(observed.snapshot.truncated).toBe(false)
    expect(observed.snapshot.limits).toEqual([])
    expect(observed.snapshot.elements.length).toBe(1)
    expect(observed.snapshot.elements[0]!.selector.length).toBeGreaterThan(0)
    expect(observed.snapshot.elements[0]!.rect.width).toBeGreaterThan(0)

    const moved = await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/form` }
    }) as { status: string }
    expect(moved.status, '导航到表单页').toBe('applied')
    const form = await observePage(nova, doc.sessionId, doc.browserId)
    const email = form.snapshot.elements.find((item) => item.name === '邮箱')
    const save = form.snapshot.elements.find((item) => item.name === '保存')
    expect(email).toBeTruthy()
    expect(save).toBeTruthy()
    expect(email!.selector.length).toBeGreaterThan(0)
    expect(email!.rect.width).toBeGreaterThan(0)
    expect(form.snapshot.dom).toContain('[ref=' + email!.ref + ']')
    expect(form.snapshot.dom).toContain('[ref=' + save!.ref + ']')
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
    const formAfter = await observePage(nova, doc.sessionId, doc.browserId)
    expect(formAfter.snapshot.dom).toContain('saved:你好')

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/spa` }
    })
    const spa = await observePage(nova, doc.sessionId, doc.browserId)
    const spaEmail = spa.snapshot.elements.find((item) => item.name === '邮箱')
    const replace = spa.snapshot.elements.find((item) => item.name === '替换')
    const spaSave = spa.snapshot.elements.find((item) => item.name === '保存')
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
    const spaAfter = await observePage(nova, doc.sessionId, doc.browserId)
    expect(spaAfter.snapshot.dom).toContain('saved:之后')

    const next = await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/next` }
    }) as { status: string }
    expect(next.status).toBe('applied')
    const nextView = await observePage(nova, doc.sessionId, doc.browserId)
    expect(nextView.snapshot.title).toBe('NextTitle')

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/scroll` }
    })
    const beforeScroll = await observePage(nova, doc.sessionId, doc.browserId)
    const scrolled = await nova.invoke(BROWSER_ACT, {
      sessionId: doc.sessionId,
      observation: beforeScroll.observation,
      action: { kind: 'scroll', direction: 'down', amount: 'page' }
    }) as { status: string; summary?: string; detail?: string }
    expect(scrolled.status, scrolled.detail).toBe('applied')
    const afterScroll = await observePage(nova, doc.sessionId, doc.browserId)
    expect(afterScroll.snapshot.dom).toMatch(/scrollpos:[1-9]/)

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: doc.sessionId,
      browserId: doc.browserId,
      action: { kind: 'url', url: `${fixture.origin}/shot` }
    })
    const shotView = await observePage(nova, doc.sessionId, doc.browserId)
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

test('快照预算硬上限生效并如实标记截断', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const opened = await openPage(nova, `${fixture.origin}/budget`)
    const view = await observePage(nova, opened.sessionId, opened.browserId)
    expect(view.snapshot.truncated).toBe(true)
    expect(view.snapshot.limits).toContain('node-budget')
    expect(view.snapshot.limits).toContain('item-budget')
    expect(view.snapshot.elements.length).toBeLessThanOrEqual(200)
    expect(view.snapshot.elements.length).toBeGreaterThan(100)
    const domBytes = Buffer.byteLength(view.snapshot.dom, 'utf8')
    expect(domBytes).toBeLessThanOrEqual(16 * 1024)
    const listedRefs = view.snapshot.elements.map((item) => item.ref)
    for (const ref of listedRefs) {
      expect(view.snapshot.dom).toContain('[ref=' + ref + ']')
    }
  } finally {
    await fixture.close()
  }
})

test('子 frame 内容不进快照，受限范围如实返回', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const opened = await openPage(nova, `${fixture.origin}/frames`)
    const view = await observePage(nova, opened.sessionId, opened.browserId)
    expect(view.snapshot.limits).toContain('subframes')
    expect(view.snapshot.dom).toContain('外层页面')
    expect(view.snapshot.dom).not.toContain('主框架正文-ALPHA')
    const frameRef = view.snapshot.elements.find((item) => item.role === 'iframe')
    expect(frameRef).toBeTruthy()
  } finally {
    await fixture.close()
  }
})

test('点击被遮挡的目标返回 target_occluded，不误报成功', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const opened = await openPage(nova, `${fixture.origin}/cover`)
    const view = await observePage(nova, opened.sessionId, opened.browserId)
    const under = view.snapshot.elements.find((item) => item.name === '被盖住的按钮')
    expect(under).toBeTruthy()
    const clicked = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: view.observation,
      action: { kind: 'click', ref: under!.ref }
    }) as { status: string; code?: string; detail?: string }
    expect(clicked, JSON.stringify(clicked)).toMatchObject({ status: 'not_applied', code: 'target_occluded' })
    const after = await observePage(nova, opened.sessionId, opened.browserId)
    expect(after.snapshot.dom).toContain('idle')
  } finally {
    await fixture.close()
  }
})

test('导航后旧 ref 失效，动作返回 stale_observation', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const opened = await openPage(nova, `${fixture.origin}/form`)
    const form = await observePage(nova, opened.sessionId, opened.browserId)
    const save = form.snapshot.elements.find((item) => item.name === '保存')
    expect(save).toBeTruthy()
    const moved = await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: opened.sessionId,
      browserId: opened.browserId,
      action: { kind: 'url', url: `${fixture.origin}/next` }
    }) as { status: string }
    expect(moved.status).toBe('applied')
    const stale = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: form.observation,
      action: { kind: 'click', ref: save!.ref }
    }) as { status: string; code?: string }
    expect(stale, JSON.stringify(stale)).toMatchObject({ status: 'not_applied', code: 'stale_observation' })

    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId: opened.sessionId,
      browserId: opened.browserId,
      action: { kind: 'url', url: `${fixture.origin}/spa` }
    })
    const spa = await observePage(nova, opened.sessionId, opened.browserId)
    const push = spa.snapshot.elements.find((item) => item.name === '跳转')
    const spaSave = spa.snapshot.elements.find((item) => item.name === '保存')
    expect(push && spaSave).toBeTruthy()
    const pushed = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: spa.observation,
      action: { kind: 'click', ref: push!.ref }
    }) as { status: string }
    // 点击本身触发页内导航：输入已发出，但所属观察同时失效，按设计不写回
    expect(['applied', 'outcome_unknown']).toContain(pushed.status)
    const staleAfterPush = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: spa.observation,
      action: { kind: 'click', ref: spaSave!.ref }
    }) as { status: string; code?: string }
    expect(staleAfterPush, JSON.stringify(staleAfterPush)).toMatchObject({
      status: 'not_applied',
      code: 'stale_observation'
    })
  } finally {
    await fixture.close()
  }
})

test('同选择器多匹配时唯一可见者优先，仍有歧义则拒绝', async ({ nova }) => {
  test.setTimeout(90_000)
  const fixture = await startFixture()
  try {
    const opened = await openPage(nova, `${fixture.origin}/dupe`)
    const view = await observePage(nova, opened.sessionId, opened.browserId)
    const save = view.snapshot.elements.find((item) => item.name === '保存' && item.role === 'button')
    const spawnHidden = view.snapshot.elements.find((item) => item.name === '克隆隐藏')
    const spawnVisible = view.snapshot.elements.find((item) => item.name === '克隆显示')
    expect(save && spawnHidden && spawnVisible).toBeTruthy()

    // 生成隐藏副本后旧选择器匹配两个：唯一可见者优先，点击应落在原按钮上
    const hid = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: view.observation,
      action: { kind: 'click', ref: spawnHidden!.ref }
    }) as { status: string }
    expect(hid.status).toBe('applied')
    const saved = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: view.observation,
      action: { kind: 'click', ref: save!.ref }
    }) as { status: string; code?: string }
    expect(saved, JSON.stringify(saved)).toMatchObject({ status: 'applied' })

    // 再生成可见副本：两个都可见，必须拒绝而不是乱点
    const shown = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: view.observation,
      action: { kind: 'click', ref: spawnVisible!.ref }
    }) as { status: string }
    expect(shown.status).toBe('applied')
    const ambiguous = await nova.invoke(BROWSER_ACT, {
      sessionId: opened.sessionId,
      observation: view.observation,
      action: { kind: 'click', ref: save!.ref }
    }) as { status: string; code?: string }
    expect(ambiguous, JSON.stringify(ambiguous)).toMatchObject({ status: 'not_applied', code: 'target_ambiguous' })

    const after = await observePage(nova, opened.sessionId, opened.browserId)
    expect(after.snapshot.elements.filter((item) => item.name === '保存').length).toBe(2)
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
    const view = await observePage(nova, doc.sessionId, doc.browserId)
    const button = view.snapshot.elements.find((item) => item.name === '弹出')
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
    const summary = after.status === 'applied' ? after.snapshot.dom : ''
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
