import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frame, Locator } from '@playwright/test'
import { expect, test, type NovaHarness } from '../fixtures/nova'

type Delta = Record<string, unknown>

interface ProbeServer {
  origin: string
  hits: string[]
  close: () => Promise<void>
}

/** 本机探针服务：帧内任何联网或导航尝试一旦放行，都会在这里留下记录 */
async function startProbeServer(): Promise<ProbeServer> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(204)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

/** 在主进程替换系统浏览器入口，记录外链而不真的打开 */
async function stubOpenExternal(nova: NovaHarness): Promise<() => Promise<string[]>> {
  await nova.app.evaluate(({ shell }) => {
    const opened: string[] = []
    const stub = async (url: string): Promise<void> => {
      opened.push(url)
    }
    Object.assign(stub, { novaE2eOpened: opened })
    shell.openExternal = stub
  })
  const installed = await nova.app.evaluate(({ shell }) =>
    Array.isArray((shell.openExternal as unknown as { novaE2eOpened?: unknown }).novaE2eOpened)
  )
  expect(installed, '主进程 shell.openExternal 无法替换，外链用例会打开真实浏览器').toBe(true)
  return () =>
    nova.app.evaluate(({ shell }) => [...(shell.openExternal as unknown as { novaE2eOpened: string[] }).novaE2eOpened])
}

async function contentFrameOf(frame: Locator): Promise<Frame> {
  const handle = await frame.elementHandle()
  const content = await handle?.contentFrame()
  if (!content) throw new Error('可视化帧尚未挂载')
  return content
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  const user = messages.filter(message => message.role === 'user').at(-1)
  return JSON.stringify(user?.content ?? '')
}

function sandboxProbeHtml(probe: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  #stage { position: relative; height: 300px; background: var(--viz-surface); border-radius: var(--viz-radius); }
  #pick { position: absolute; left: 24px; top: 24px; }
  #docs { position: absolute; left: 24px; top: 72px; color: var(--viz-accent); }
  #status { position: absolute; left: 24px; bottom: 24px; font-family: var(--viz-font-mono); }
</style>
</head>
<body>
<div id="stage">
  <button id="pick" type="button">选择 2 号</button>
  <a id="docs" href="${probe}/docs">外部文档</a>
  <output id="status"></output>
</div>
<script>
  var probe = '${probe}';
  var results = [];
  try { void window.parent.document.title; results.push('parent-readable'); } catch (error) { results.push('parent-blocked'); }
  results.push(typeof window.api === 'undefined' ? 'api-absent' : 'api-present');
  try { window.localStorage.getItem('k'); results.push('storage-readable'); } catch (error) { results.push('storage-blocked'); }
  results.push(window.open(probe + '/popup') === null ? 'popup-null' : 'popup-opened');
  document.getElementById('status').textContent = results.join(' ');
  fetch(probe + '/fetch').catch(function () {});
  var image = new Image();
  image.src = probe + '/img';
  var script = document.createElement('script');
  script.src = probe + '/script';
  document.head.appendChild(script);
  setTimeout(function () { nova.emit('auto', { unattended: true }); }, 200);
  setTimeout(function () { location.href = probe + '/nav'; }, 300);
  document.getElementById('pick').addEventListener('click', function () { nova.emit('pick', { id: 2 }); });
  setTimeout(function () { missingHelper(); }, 0);
</script>
</body>
</html>`
}

const ANIMATED_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.25); } }
  #dot { width: 40px; height: 40px; border-radius: 50%; background: var(--viz-accent); animation: pulse 2s ease-in-out infinite alternate; }
</style>
</head>
<body>
<p id="marker">NOVA_E2E_VIZ_EXPORT_MARKER</p>
<div id="dot"></div>
</body>
</html>`

/** 折叠卡片与高卡片同处一行的网格：折叠那张必须按自己的内容高度排布 */
const COLLAPSIBLE_GRID_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  .viz-grid { grid-template-columns: repeat(3, 1fr); }
  .tall { height: 320px; }
  .collapsed .body { max-height: 0; overflow: hidden; }
</style>
</head>
<body>
  <div class="viz-grid">
    <div class="viz-card tall">高卡片</div>
    <div class="viz-card collapsed">折叠卡片<div class="body">展开后才有内容</div></div>
  </div>
</body>
</html>`

/** 高度远超内联上限的页面：卡片应提示去展开视图看完整内容 */
const OVERFLOW_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"></head>
<body><div style="height:2000px">长内容</div></body>
</html>`

function toolCallDelta(part: { id?: string; name?: string; arguments: string }): Delta {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(part.id ? { id: part.id, type: 'function' } : {}),
              function: { ...(part.name ? { name: part.name } : {}), arguments: part.arguments }
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

const TOOL_CALLS_FINISH: Delta = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }

/** 作者源码中某段代码的行列号（从 1 起），即报错应指向的位置 */
function sourcePosition(html: string, snippet: string): string {
  const lines = html.split('\n')
  const index = lines.findIndex(line => line.includes(snippet))
  if (index < 0) throw new Error(`作者源码中没有 ${snippet}`)
  return `${index + 1}:${lines[index].indexOf(snippet) + 1}`
}

test('可视化在无权限沙箱帧内渲染：按内容定高、报错指向作者源码、随设置切换主题，只有真实点击才能回传与外链', async ({ nova }) => {
  const probe = await startProbeServer()
  try {
    const openedLinks = await stubOpenExternal(nova)
    const html = sandboxProbeHtml(probe.origin)
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: 'E2E 可视化', html },
        callId: 'call_viz_sandbox'
      },
      { kind: 'text', text: 'NOVA_E2E_VIZ_SHOWN' }
    )

    await nova.sendPrompt('展示沙箱探针可视化')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_SHOWN', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()

    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'ok')
    const frameElement = card.getByTestId('visualization-frame')
    await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts')
    const frame = await contentFrameOf(frameElement)

    await expect(frame.locator('#status')).toHaveText('parent-blocked api-absent storage-blocked popup-null')
    const contentHeight = await frame.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height))
    expect(contentHeight).toBeGreaterThan(300)
    await expect.poll(() => frameElement.evaluate(element => element.getBoundingClientRect().height)).toBe(contentHeight)

    // 联网、导航、无手势回传与弹窗都发生在加载后 300ms 内：留足时间让放行的请求落地
    await nova.page.waitForTimeout(1_000)
    expect(probe.hits).toEqual([])
    expect(nova.provider.requests).toHaveLength(2)
    expect(await openedLinks()).toEqual([])
    await expect(frame.locator('#status')).toBeVisible()
    const errors = card.getByTestId('visualization-errors')
    await expect(errors).toContainText('Blocked')
    await expect(errors.locator('.visualization-card__error')).toHaveAttribute(
      'title',
      new RegExp(`missingHelper is not defined \\(${sourcePosition(html, 'missingHelper')}\\)`)
    )

    // 走真实设置入口：帧保持挂载，主题经桥实时下发
    const readFrameTheme = () =>
      frame.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        return { scheme: style.colorScheme, bg: style.getPropertyValue('--viz-bg').trim() }
      })
    const settings = nova.page.getByRole('dialog', { name: '设置' })
    const chooseTheme = async (label: '深色' | '浅色'): Promise<void> => {
      await nova.page.getByRole('button', { name: '设置', exact: true }).click()
      await settings.getByRole('tab', { name: '通用' }).click()
      await settings.getByRole('radio', { name: label }).click()
      await settings.getByRole('button', { name: '返回应用' }).click()
      // 模态壳退场期间底层仍是 inert，点击与焦点都落不到帧上
      await expect(settings).toBeHidden()
    }
    await chooseTheme('深色')
    await expect.poll(async () => (await readFrameTheme()).scheme).toBe('dark')
    const dark = await readFrameTheme()
    await chooseTheme('浅色')
    await expect.poll(async () => (await readFrameTheme()).scheme).toBe('light')
    expect((await readFrameTheme()).bg).not.toBe(dark.bg)

    await frame.locator('#docs').click()
    await expect.poll(openedLinks).toEqual([`${probe.origin}/docs`])
    await expect(frame.locator('#status')).toBeVisible()

    // 回传有每秒一次的频率上限
    await nova.page.waitForTimeout(1_100)
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_VIZ_EVENT_ACK' })
    await frame.locator('#pick').click()
    await nova.provider.waitForRequestCount(3)
    const eventMessage = lastUserText(nova.provider.requests[2].body)
    expect(eventMessage).toContain('【可视化】E2E 可视化 · pick')
    expect(eventMessage).toContain('{\\"id\\":2}')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_EVENT_ACK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()

    expect(nova.provider.requests.some(request => JSON.stringify(request.body).includes('· auto'))).toBe(false)
    expect(probe.hits).toEqual([])
    // Playwright 把子帧的未捕获异常也记为页面错误：只排除探针页故意抛出的那一条
    expect(nova.pageErrors.filter(error => !error.includes('missingHelper is not defined'))).toEqual([])
  } finally {
    await probe.close()
  }
})

test('流式生成占位到成品；慢放、展开与导出共用同一快照，重载后从磁盘恢复', async ({ nova }) => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), 'nova-e2e-viz-export-'))
  const exportPath = path.join(exportDir, 'exported.html')
  try {
    await nova.app.evaluate(({ dialog }, target) => {
      const stub = async () => ({ canceled: false, filePath: target })
      Object.assign(stub, { novaE2eStub: true })
      dialog.showSaveDialog = stub as unknown as typeof dialog.showSaveDialog
    }, exportPath)
    const dialogStubbed = await nova.app.evaluate(({ dialog }) =>
      (dialog.showSaveDialog as unknown as { novaE2eStub?: boolean }).novaE2eStub === true
    )
    expect(dialogStubbed, '主进程 dialog.showSaveDialog 无法替换').toBe(true)

    const args = JSON.stringify({ title: '流式可视化', html: ANIMATED_HTML })
    const firstCut = args.indexOf('"html":"') + '"html":"'.length + 20
    const secondCut = Math.floor((firstCut + args.length) / 2)
    nova.provider.enqueue(
      {
        kind: 'raw',
        events: [
          { payload: toolCallDelta({ id: 'call_viz_stream', name: 'present_visualization', arguments: args.slice(0, firstCut) }) },
          { payload: toolCallDelta({ arguments: args.slice(firstCut, secondCut) }), delayMs: 600 },
          { payload: toolCallDelta({ arguments: args.slice(secondCut) }), delayMs: 600 },
          { payload: TOOL_CALLS_FINISH }
        ]
      },
      { kind: 'text', text: 'NOVA_E2E_VIZ_STREAM_DONE' }
    )

    await nova.sendPrompt('流式展示动画可视化')
    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'generating')
    await expect(card).toContainText('流式可视化')
    await expect(card).toContainText(/正在生成 · \d+ 字符/)
    await expect(card).toHaveAttribute('data-state', 'ok')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_STREAM_DONE', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()

    const inlineFrameElement = card.getByTestId('visualization-frame')
    const inlineFrame = await contentFrameOf(inlineFrameElement)
    const playbackRate = (target: Frame) => target.evaluate(() => document.getAnimations()[0]?.playbackRate ?? null)
    const slowMotion = card.getByRole('button', { name: '慢放' })
    await expect(slowMotion).toBeVisible()
    expect(await playbackRate(inlineFrame)).toBe(1)
    await slowMotion.click()
    await expect.poll(() => playbackRate(inlineFrame)).toBe(0.25)
    await expect(card.getByRole('button', { name: '恢复正常速度' })).toHaveAttribute('aria-pressed', 'true')

    await card.getByRole('button', { name: '展开' }).click()
    const dialog = nova.page.locator('dialog.visualization-dialog')
    await expect(dialog).toBeVisible()
    const expandedFrameElement = dialog.getByTestId('visualization-frame')
    await expect(expandedFrameElement).toHaveClass(/visualization-frame--ready/)
    const expandedFrame = await contentFrameOf(expandedFrameElement)
    await expect(expandedFrame.locator('#marker')).toHaveText('NOVA_E2E_VIZ_EXPORT_MARKER')
    await expect.poll(() => playbackRate(expandedFrame)).toBe(0.25)
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(inlineFrameElement).toHaveClass(/visualization-frame--ready/)

    await card.getByRole('button', { name: '导出 HTML' }).click()
    await expect(card.locator('.visualization-card__notice')).toHaveText('已导出')
    const exported = await readFile(exportPath, 'utf8')
    expect(exported).toContain('http-equiv="Content-Security-Policy"')
    expect(exported).toContain('NOVA_E2E_VIZ_EXPORT_MARKER')
    expect(exported).not.toContain('sandbox allow-scripts')

    await nova.page.reload()
    await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
    const restored = nova.page.getByTestId('visualization-card')
    await expect(restored).toHaveAttribute('data-state', 'ok')
    const restoredFrame = await contentFrameOf(restored.getByTestId('visualization-frame'))
    await expect(restoredFrame.locator('#marker')).toHaveText('NOVA_E2E_VIZ_EXPORT_MARKER')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await rm(exportDir, { recursive: true, force: true })
  }
})

test('同一网格里的折叠卡片按自身内容排布，不被同排最高卡片撑成空白', async ({ nova }) => {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '折叠网格', html: COLLAPSIBLE_GRID_HTML },
      callId: 'call_viz_collapsed'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_COLLAPSED_DONE' }
  )
  await nova.sendPrompt('展示折叠卡片网格')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_COLLAPSED_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frame = await contentFrameOf(card.getByTestId('visualization-frame'))
  const heights = await frame.evaluate(() =>
    [...document.querySelectorAll('.viz-card')].map(node => Math.round(node.getBoundingClientRect().height))
  )
  expect(heights).toHaveLength(2)
  expect(heights[0]).toBeGreaterThan(300)
  // 网格默认 stretch：没有 align-items:start 时折叠卡片会被拉到与高卡片同高
  expect(heights[1]).toBeLessThan(heights[0] / 3)
})

test('内容高于内联上限时给出展开提示，卡片不被撑开', async ({ nova }) => {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '超长页面', html: OVERFLOW_HTML },
      callId: 'call_viz_overflow'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_OVERFLOW_DONE' }
  )
  await nova.sendPrompt('展示超长可视化')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_OVERFLOW_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frameElement = card.getByTestId('visualization-frame')
  await expect.poll(() => frameElement.evaluate(element => element.getBoundingClientRect().height)).toBe(1200)

  const overflow = card.getByTestId('visualization-overflow')
  await expect(overflow).toContainText('可在卡片内滚动查看')
  await overflow.getByRole('button', { name: '展开查看' }).click()
  await expect(nova.page.locator('dialog.visualization-dialog')).toBeVisible()
})
