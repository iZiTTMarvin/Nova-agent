import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frame, Locator } from '@playwright/test'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import { createLearnSession, learningFlow, sendLearningPrompt, waitLearnTurnSettled } from '../learning/learningFlow'

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

/** 生成期的预览帧垫在正式帧上方，正式帧就绪后淡出卸载；退场后卡片里只剩正式帧 */
async function settledFrame(card: Locator): Promise<Locator> {
  await expect(card.getByTestId('visualization-preview')).toHaveCount(0)
  return card.getByTestId('visualization-frame')
}

function userTexts(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  return messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content ?? ''))
}

function lastUserText(body: Record<string, unknown>): string {
  return userTexts(body).at(-1) ?? '""'
}

/** 可视化只在学习会话里提供：每个用例先建学习会话，回合收尾以运行快照终态为准 */
async function startLearnSession(nova: NovaHarness): Promise<{ send: (text: string) => Promise<void>; settle: () => Promise<void> }> {
  const sessionId = await createLearnSession(nova)
  return {
    send: text => sendLearningPrompt(nova, text),
    settle: () => waitLearnTurnSettled(nova, sessionId)
  }
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

/** 按写法说明搭的教材式插图：阶段条、步骤流、详情区与带列标签的对比表 */
const WIDTHS_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"></head>
<body>
<div class="viz-workbench">
  <div class="viz-phases">
    <button class="viz-phase is-active" type="button"><span class="viz-phase-kicker">步骤 1–2</span><span class="viz-phase-title">输入与提交</span></button>
    <button class="viz-phase" type="button"><span class="viz-phase-kicker">步骤 3–5</span><span class="viz-phase-title">路由与建流</span></button>
    <button class="viz-phase" type="button"><span class="viz-phase-kicker">步骤 6–9</span><span class="viz-phase-title">上下文组装</span></button>
    <button class="viz-phase" type="button"><span class="viz-phase-kicker">步骤 10–11</span><span class="viz-phase-title">调用模型</span></button>
    <button class="viz-phase" type="button"><span class="viz-phase-kicker">步骤 12–16</span><span class="viz-phase-title">回传与落库</span></button>
  </div>
  <div class="viz-split">
    <div class="viz-canvas"><div class="viz-flow">
      <button class="viz-flow-step is-active" type="button"><span class="viz-node-step">1</span><span><span class="viz-flow-title">输入框绑定</span><span class="viz-flow-meta">浏览器 · x-model="chatInput"</span></span></button>
      <button class="viz-flow-step" type="button"><span class="viz-node-step">2</span><span><span class="viz-flow-title">sendChat() 发起请求</span><span class="viz-flow-meta">浏览器 · fetch POST，先插入占位消息</span></span></button>
    </div></div>
    <aside class="viz-inspector">
      <div class="viz-title">输入框绑定</div>
      <p class="viz-note">把输入框的值绑定到 chatInput；流式回答进行中提交按钮被禁用，避免并发提问。</p>
      <dl class="viz-kv"><dt>输入</dt><dd>用户按键</dd><dt>输出</dt><dd>chatInput 字符串</dd></dl>
      <span class="viz-file-ref">frontend/index.html:211</span>
    </aside>
  </div>
<div class="viz-lanes" id="geometry-lanes">
  <div class="viz-lane"><span class="viz-lane-label">入口层</span><div class="viz-lane-nodes"><button class="viz-node">cli.ts</button><button class="viz-node">index.ts</button></div></div>
  <div class="viz-lane"><span class="viz-lane-label">编排层</span><div class="viz-lane-nodes"><button class="viz-node">agent.ts</button><button class="viz-node">orchestrator.ts</button></div></div>
  <div class="viz-lane"><span class="viz-lane-label">支撑层</span><div class="viz-lane-nodes"><button class="viz-node">config.ts</button><button class="viz-node">logger.ts</button><button class="viz-node">utils/json_utils.ts</button><button class="viz-node">memory.ts</button></div></div>
</div>
  <table class="viz-table">
    <thead><tr><th>方案</th><th>平均延迟</th><th>改造成本</th></tr></thead>
    <tbody>
      <tr><td data-label="方案">直读数据库</td><td data-label="平均延迟">38 ms，每次都要走一次网络往返</td><td data-label="改造成本">低，沿用现有查询</td></tr>
      <tr><td data-label="方案">先查缓存</td><td data-label="平均延迟">4 ms，命中后只剩一次内存查找</td><td data-label="改造成本">中，需要处理失效与回填</td></tr>
    </tbody>
  </table>
  <div class="viz-toolbar"><span class="viz-note">1 / 16</span><span class="viz-row"><button class="viz-btn" type="button">上一步</button><button class="viz-btn viz-btn-primary" type="button">下一步</button></span></div>
</div>
</body>
</html>`

/** 帧内出现横向溢出的区域：页面本身和常用容器都不应比可见宽度更宽 */
function horizontalOverflow(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const targets = [
      document.documentElement,
      ...document.querySelectorAll('.viz-phases, .viz-canvas, .viz-flow, .viz-inspector, .viz-table, .viz-toolbar')
    ]
    return targets
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => (element === document.documentElement ? 'page' : element.className))
  })
}

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

/** 把参数 JSON 切成若干片：分片发送让生成期间能观察预览逐步长出 */
function splitArgumentsChunks(raw: string, count: number): string[] {
  const size = Math.ceil(raw.length / count)
  const chunks: string[] = []
  for (let index = 0; index < raw.length; index += size) {
    chunks.push(raw.slice(index, index + size))
  }
  return chunks
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
    const learn = await startLearnSession(nova)
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

    await learn.send('展示沙箱探针可视化')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_SHOWN', { exact: false })).toBeVisible()
    await learn.settle()
    const requestsAfterTurn = nova.provider.requests.length

    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'ok')
    const frameElement = await settledFrame(card)
    await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts')
    const frame = await contentFrameOf(frameElement)

    await expect(frame.locator('#status')).toHaveText('parent-blocked api-absent storage-blocked popup-null')
    const contentHeight = await frame.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height))
    expect(contentHeight).toBeGreaterThan(300)
    await expect.poll(() => frameElement.evaluate(element => element.getBoundingClientRect().height)).toBe(contentHeight)

    // 联网、导航、无手势回传与弹窗都发生在加载后 300ms 内：留足时间让放行的请求落地
    await nova.page.waitForTimeout(1_000)
    expect(probe.hits).toEqual([])
    expect(nova.provider.requests).toHaveLength(requestsAfterTurn)
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
    await nova.provider.waitForRequestCount(requestsAfterTurn + 1)
    const eventMessage = lastUserText(nova.provider.requests[requestsAfterTurn].body)
    expect(eventMessage).toContain('【可视化】E2E 可视化 · pick')
    expect(eventMessage).toContain('{\\"id\\":2}')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_EVENT_ACK', { exact: false })).toBeVisible()
    await learn.settle()

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
    const learn = await startLearnSession(nova)

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

    await learn.send('流式展示动画可视化')
    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'generating')
    await expect(card).toContainText('流式可视化')
    await expect(card.locator('.visualization-card__skeleton')).toBeVisible()
    await expect(card).not.toContainText('字符')
    await expect(card).toHaveAttribute('data-state', 'ok')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_STREAM_DONE', { exact: false })).toBeVisible()
    await learn.settle()

    const inlineFrameElement = await settledFrame(card)
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
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '折叠网格', html: COLLAPSIBLE_GRID_HTML },
      callId: 'call_viz_collapsed'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_COLLAPSED_DONE' }
  )
  await learn.send('展示折叠卡片网格')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_COLLAPSED_DONE', { exact: false })).toBeVisible()
  await learn.settle()

  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frame = await contentFrameOf(await settledFrame(card))
  const heights = await frame.evaluate(() =>
    [...document.querySelectorAll('.viz-card')].map(node => Math.round(node.getBoundingClientRect().height))
  )
  expect(heights).toHaveLength(2)
  expect(heights[0]).toBeGreaterThan(300)
  // 网格默认 stretch：没有 align-items:start 时折叠卡片会被拉到与高卡片同高
  expect(heights[1]).toBeLessThan(heights[0] / 3)
})

test('流式预览期间恶意页面执行不了脚本也联不了网，被发布闸门打回后预览随卡片退出', async ({ nova }) => {
  const probe = await startProbeServer()
  try {
    const openedLinks = await stubOpenExternal(nova)
    const learn = await startLearnSession(nova)
    const title = '逃逸探针'
    const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${probe.origin}/refresh">
<style>.box{height:96px;border:1px solid var(--viz-border)}</style>
</head><body>
<p id="marker">NOVA_E2E_SEEN</p>
<a id="remote" href="${probe.origin}/link">远程链接</a>
<div class="box">NOVA_E2E_PREVIEW_GREW</div>
<img src="${probe.origin}/img" onerror="fetch('${probe.origin}/onerror')">
</body></html>`
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title, html },
        callId: 'call_viz_escape',
        argumentChunks: splitArgumentsChunks(JSON.stringify({ title, html }), 12),
        chunkDelayMs: 300
      },
      { kind: 'text', text: 'NOVA_E2E_VIZ_REJECTED' }
    )

    await learn.send('展示逃逸探针可视化')
    const card = nova.page.getByTestId('visualization-card')
    const preview = card.getByTestId('visualization-preview')
    await expect(preview).toBeVisible()
    const previewFrame = await contentFrameOf(preview.getByTestId('visualization-frame'))
    // 生成尚未结束，预览帧里已经能看到到达的节点
    await expect(previewFrame.locator('#marker')).toHaveText('NOVA_E2E_SEEN')
    // 预览只展示结构：生成中真实点击外链也不交给系统浏览器
    await previewFrame.locator('#remote').click()
    await expect(card).toHaveAttribute('data-state', 'generating')

    // img 的远程地址与 meta refresh 触发发布闸门：打回后预览随卡片退回轨迹行
    await expect(nova.page.getByText('NOVA_E2E_VIZ_REJECTED', { exact: false })).toBeVisible()
    await learn.settle()
    await expect(card).toHaveCount(0)
    // 工具轨迹默认收在「已工作 X 秒」折叠头里，先展开再定位被打回的那一行
    await nova.page.locator('.turn-process-tree__header').last().click()
    const rejectedRow = nova.page.locator('.tool-trace-row--error').filter({ hasText: '逃逸探针' })
    await expect(rejectedRow.first()).toBeVisible()

    expect(await openedLinks()).toEqual([])
    expect(probe.hits).toEqual([])
    expect(nova.pageErrors).toEqual([])
  } finally {
    await probe.close()
  }
})

test('合法页面的流式预览先长出，成功后交接给正式快照帧且高度不回落', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  const title = '高页面'
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
.block{height:140px;margin-bottom:12px;border:1px solid var(--viz-border);border-radius:var(--viz-radius)}
</style></head><body>
<div class="block">NOVA_E2E_TALL_BLOCK_1</div>
<div class="block">NOVA_E2E_TALL_BLOCK_2</div>
<div class="block">NOVA_E2E_TALL_BLOCK_3</div>
<div class="block">NOVA_E2E_TALL_BLOCK_4</div>
</body></html>`
  // 每次 rAF 采样当前帧或占位的高度：预览 → 正式帧之间任何回落都会留下记录
  await nova.page.evaluate(() => {
    const samples: number[] = []
    ;(window as unknown as { __vizHeights?: number[] }).__vizHeights = samples
    const tick = (): void => {
      const card = document.querySelector('[data-testid="visualization-card"]')
      const target = card?.querySelector('iframe') ?? card?.querySelector('.visualization-card__placeholder')
      if (target) samples.push(target.getBoundingClientRect().height)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title, html },
      callId: 'call_viz_tall',
      argumentChunks: splitArgumentsChunks(JSON.stringify({ title, html }), 8),
      chunkDelayMs: 300
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_TALL_DONE' }
  )

  await learn.send('展示高页面可视化')
  const card = nova.page.getByTestId('visualization-card')
  const preview = card.getByTestId('visualization-preview')
  await expect(preview).toBeVisible()
  const previewFrame = await contentFrameOf(preview.getByTestId('visualization-frame'))
  await expect(previewFrame.locator('.block').first()).toContainText('NOVA_E2E_TALL_BLOCK_1')

  await expect(card).toHaveAttribute('data-state', 'ok')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_TALL_DONE', { exact: false })).toBeVisible()
  await learn.settle()

  // 成功后预览卸载，正式帧指向快照地址
  await expect(preview).toHaveCount(0)
  const frame = card.getByTestId('visualization-frame')
  await expect(frame).toHaveAttribute('src', /^nova-viz:\/\/snapshot\//)
  const snapshotFrame = await contentFrameOf(frame)
  await expect(snapshotFrame.locator('.block')).toHaveCount(4)

  const heights = await nova.page.evaluate(
    () => (window as unknown as { __vizHeights?: number[] }).__vizHeights ?? []
  )
  const firstGrown = heights.findIndex(height => height > 240)
  expect(firstGrown, '预览帧高度从未超过 240px').toBeGreaterThanOrEqual(0)
  expect(
    Math.min(...heights.slice(firstGrown)),
    '预览长大后到正式帧就绪期间高度回落到 160px 以下'
  ).toBeGreaterThan(160)
  expect(nova.pageErrors).toEqual([])
})

test('openui 围栏在开发对话里只是代码块；学习会话里流式尾部禁用，封口后可交互，回合结束后值保持', async ({ nova }) => {
  const fence = [
    '```openui',
    'root = Col([Slider($v, "并发", 1, 16, 1), Stat("吞吐", @Round($v * 120) + " msg/s")])',
    '$v = 4',
    '```'
  ].join('\n')

  // 开发对话没有界面状态回传，同样的围栏按普通代码块显示
  nova.provider.enqueue({ kind: 'text', text: `开发对话里的估算：\n\n${fence}\n\nNOVA_E2E_OPENUI_DEV` })
  await nova.sendPrompt('开发对话里展示 openui 围栏')
  await expect(nova.page.getByText('NOVA_E2E_OPENUI_DEV', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expect(nova.page.locator('.md-code-block__lang', { hasText: 'openui' })).toBeVisible()
  await expect(nova.page.locator('[role="slider"]')).toHaveCount(0)

  const learn = await startLearnSession(nova)
  const flow = learningFlow(nova)

  // 第一轮：围栏未闭合，块落在活动尾部，控件禁用
  nova.provider.enqueue({
    kind: 'hold',
    id: 'openui-unclosed',
    before: `先给一个估算：\n\n${fence.slice(0, -3)}`,
    text: '```\n\n第一轮收尾 NOVA_E2E_OPENUI_R1'
  })
  await learn.send('展示 openui 组件第一轮')
  const tailSlider = flow.locator('[role="slider"]')
  await expect(tailSlider).toBeVisible()
  await expect(tailSlider).toHaveAttribute('aria-disabled', 'true')
  nova.provider.release('openui-unclosed')
  await expect(nova.page.getByText('NOVA_E2E_OPENUI_R1', { exact: false })).toBeVisible()
  await learn.settle()
  expect(nova.pageErrors).toEqual([])

  // 第二轮：围栏已闭合并带空行，块落在封口区，可交互
  nova.provider.enqueue({
    kind: 'hold',
    id: 'openui-sealed',
    before: `再看这个估算：\n\n${fence}\n\n`,
    text: '第二轮收尾 NOVA_E2E_OPENUI_R2'
  })
  await learn.send('展示 openui 组件第二轮')
  // 第一轮的块也在会话里，定位限定在第二轮的文本块内；打字机放出期间块先处于活动尾部
  const round2 = flow.locator('.turn-process-text', { hasText: '再看这个估算' })
  const slider = round2.locator('[role="slider"]')
  const metric = round2.locator('.inline-ui__stat-value')
  await expect(slider).toBeVisible()
  await expect(slider).toBeEnabled()
  await expect(metric).toHaveText('480 msg/s')
  await slider.focus()
  await nova.page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuenow', '16')
  await expect(metric).toHaveText('1,920 msg/s')
  nova.provider.release('openui-sealed')
  await expect(nova.page.getByText('NOVA_E2E_OPENUI_R2', { exact: false })).toBeVisible()
  await learn.settle()

  // 回合结束整块重挂后，滑块值与派生指标不变；值随下一条学习消息回传由学习表面用例保护
  await expect(metric).toHaveText('1,920 msg/s')
  await expect(slider).toHaveAttribute('aria-valuenow', '16')

  // 调完立刻刷新：落盘合并窗口还没到期，最后一次操作也要留住
  await slider.focus()
  await nova.page.keyboard.press('Home')
  await expect(slider).toHaveAttribute('aria-valuenow', '1')
  await nova.page.reload()
  await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
  const restored = learningFlow(nova).locator('.turn-process-text', { hasText: '再看这个估算' })
  await expect(restored.locator('[role="slider"]')).toHaveAttribute('aria-valuenow', '1')
  await expect(restored.locator('.inline-ui__stat-value')).toHaveText('120 msg/s')
  expect(nova.pageErrors).toEqual([])
})

test('窄卡片、常规内联与展开视图三档宽度下，阶段条、步骤、分层模块、详情与对比表都不拥挤或横向溢出', async ({ nova }, testInfo) => {
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '一条消息的流转', html: WIDTHS_HTML },
      callId: 'call_viz_widths'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_WIDTHS_DONE' }
  )
  await learn.send('展示三档宽度可视化')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_WIDTHS_DONE', { exact: false })).toBeVisible()
  await learn.settle()

  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frameElement = await settledFrame(card)
  const expectLaneGeometry = async (target: Frame): Promise<void> => {
    const metrics = await target.locator('#geometry-lanes').evaluate(root => {
      const nodes = [...root.querySelectorAll('.viz-lane-nodes > .viz-node')]
      const widths = nodes.map(node => node.getBoundingClientRect().width)
      const centerDeltas = [...root.querySelectorAll('.viz-lane')].flatMap(lane => {
        const area = lane.querySelector('.viz-lane-nodes')
        if (!area) return []
        const areaRect = area.getBoundingClientRect()
        const rows = new Map<number, { left: number; right: number }>()
        for (const node of area.querySelectorAll('.viz-node')) {
          const rect = node.getBoundingClientRect()
          const key = Math.round(rect.top)
          const row = rows.get(key) ?? { left: rect.left, right: rect.right }
          row.left = Math.min(row.left, rect.left)
          row.right = Math.max(row.right, rect.right)
          rows.set(key, row)
        }
        return [...rows.values()].map(row => Math.abs((row.left + row.right - areaRect.left - areaRect.right) / 2))
      })
      return { widthDelta: Math.max(...widths) - Math.min(...widths), centerDeltas }
    })
    expect(metrics.widthDelta).toBeLessThanOrEqual(1)
    for (const delta of metrics.centerDeltas) expect(delta).toBeLessThanOrEqual(1)
  }
  const frame = await contentFrameOf(frameElement)
  const shotDir = path.resolve(__dirname, '../../../test-results/e2e/visualization-widths')
  await mkdir(shotDir, { recursive: true })
  const capture = async (name: string, target: Locator): Promise<void> => {
    const file = path.join(shotDir, `${name}.png`)
    await target.screenshot({ path: file, animations: 'disabled' })
    await testInfo.attach(`${name}.png`, { path: file, contentType: 'image/png' })
  }

  const inlineWidth = await frame.evaluate(() => document.documentElement.clientWidth)
  expect(await horizontalOverflow(frame)).toEqual([])
  await expectLaneGeometry(frame)
  await capture('inline', card)

  // 小窗口里卡片只有约 380px：对比表逐行变成带列标签的卡片
  await frameElement.evaluate(element => { (element as HTMLElement).style.width = '380px' })
  await expect.poll(() => frame.evaluate(() => document.documentElement.clientWidth)).toBe(380)
  expect(await horizontalOverflow(frame)).toEqual([])
  await expectLaneGeometry(frame)
  await expect(frame.locator('.viz-table thead')).toBeHidden()
  // 窄帧会变高：截图时临时拉高窗口，让整张卡片入镜
  const viewport = nova.page.viewportSize()
  if (viewport) await nova.page.setViewportSize({ width: viewport.width, height: 1600 })
  await capture('narrow-380', frameElement)
  if (viewport) await nova.page.setViewportSize(viewport)
  await frameElement.evaluate(element => { (element as HTMLElement).style.removeProperty('width') })

  await card.getByRole('button', { name: '展开' }).click()
  const dialog = nova.page.locator('dialog.visualization-dialog')
  const expandedElement = dialog.getByTestId('visualization-frame')
  await expect(expandedElement).toHaveClass(/visualization-frame--ready/)
  const expanded = await contentFrameOf(expandedElement)
  expect(await expanded.evaluate(() => document.documentElement.clientWidth)).toBeGreaterThan(inlineWidth)
  expect(await horizontalOverflow(expanded)).toEqual([])
  await expectLaneGeometry(expanded)
  await capture('expanded', dialog)
  expect(nova.pageErrors).toEqual([])
})

test('内容高于内联上限时给出展开提示，卡片不被撑开', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '超长页面', html: OVERFLOW_HTML },
      callId: 'call_viz_overflow'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_OVERFLOW_DONE' }
  )
  await learn.send('展示超长可视化')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_OVERFLOW_DONE', { exact: false })).toBeVisible()
  await learn.settle()

  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frameElement = await settledFrame(card)
  await expect.poll(() => frameElement.evaluate(element => element.getBoundingClientRect().height)).toBe(1200)

  const overflow = card.getByTestId('visualization-overflow')
  await expect(overflow).toContainText('可在卡片内滚动查看')
  await overflow.getByRole('button', { name: '展开查看' }).click()
  await expect(nova.page.locator('dialog.visualization-dialog')).toBeVisible()
})
