import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frame, Locator } from '@playwright/test'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import { createLearnSession, learningFlow, sendLearningPrompt, waitLearnTurnSettled } from '../learning/learningFlow'
import { buildVisualizationUri, formatVisualizationResult } from '../../../src/shared/visualization'

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

async function seedLegacyVisualization(nova: NovaHarness, sessionId: string, html: string): Promise<void> {
  const sha256 = createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex')
  const uri = buildVisualizationUri({ sessionId, sha256 })
  const sessionDir = path.join(nova.profileRoot, 'userData', 'sessions', sessionId)
  const visualizationDir = path.join(sessionDir, 'visualizations')
  await mkdir(visualizationDir, { recursive: true })
  await writeFile(path.join(visualizationDir, `${sha256}.html`), html, 'utf8')
  const timestamp = Date.now()
  const result = formatVisualizationResult({ title: '历史 HTML 快照', uri, bytes: Buffer.byteLength(html) })
  const messages = [
    { id: 'legacy-user', parentId: null, role: 'user', content: '查看历史快照', timestamp },
    {
      id: 'legacy-assistant',
      parentId: 'legacy-user',
      role: 'assistant',
      content: '历史可视化',
      messageSchemaVersion: 2,
      blocks: [{
        type: 'tool',
        toolCallId: 'legacy-visualization',
        toolName: 'present_visualization',
        arguments: { title: '历史 HTML 快照', html },
        status: 'success',
        result
      }],
      timestamp: timestamp + 1
    }
  ]
  await writeFile(path.join(sessionDir, 'messages.jsonl'), `${messages.map(message => JSON.stringify(message)).join('\n')}\n`, 'utf8')
  const metadata = JSON.parse(await readFile(path.join(sessionDir, 'session.json'), 'utf8')) as Record<string, unknown>
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    ...metadata,
    currentLeafId: 'legacy-assistant',
    messageCount: 2,
    updatedAt: timestamp + 1
  }, null, 2), 'utf8')
}

const SANDBOX_DRAFT = `## 沙箱里的学习图

这里只有声明式内容，不执行模型脚本。

\`\`\`flow selected=CLI
CLI -> Preload: 用户提问
Preload -> Main: 类型化调用
\`\`\`

\`\`\`ask id=confirm-sandbox
确认这个调用方向吗？
看懂 | 已看懂，请继续
还需要举例 | 请解释 Preload 的边界
\`\`\`

\`\`\`remark id=sandbox-note title=补充你的疑问
\`\`\``

const STREAMING_DRAFT = `## 流式可视化

NOVA_E2E_VIZ_EXPORT_MARKER

\`\`\`flow
输入 -> 编译: 声明式草稿
编译 -> 发布: 不可变快照
\`\`\`

## 快照内容

展开、导出与 reload 都读取同一份快照。`

const LEGACY_GRID_HTML = '<!doctype html><div class="viz-grid"><div class="viz-card">旧 HTML 输入</div></div>'

const WIDTHS_DRAFT = `## 一条消息的流转

先看真实节点，再看各方案的成本与延迟。

\`\`\`flow selected=cli.ts
@group 入口层
cli.ts
index.ts
@group 编排层
agent.ts
orchestrator.ts
@group 支撑层
config.ts
logger.ts
utils/json_utils.ts
memory.ts
cli.ts -> agent.ts: 用户提问
agent.ts -> orchestrator.ts: 建立运行
orchestrator.ts -> config.ts: 读取配置
\`\`\`

\`\`\`comparison
方案 | 平均延迟 | 改造成本
直读数据库 | 38 ms，每次都要走一次网络往返 | 低，沿用现有查询
先查缓存 | 4 ms，命中后只剩一次内存查找 | 中，需要处理失效与回填
\`\`\``

/** 帧内出现横向溢出的区域：页面本身和常用容器都不应比可见宽度更宽 */
function horizontalOverflow(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const targets = [
      document.documentElement,
      ...document.querySelectorAll('.viz-phases, .viz-canvas, .viz-flow, .viz-inspector, .viz-table, .viz-toolbar, .viz-draft-panel, .viz-draft-flow, .viz-draft-table-wrap')
    ]
    return targets
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => (element === document.documentElement ? 'page' : element.className))
  })
}

/** 高度远超内联上限的页面：卡片应提示去展开视图看完整内容 */
const OVERFLOW_DRAFT = Array.from({ length: 24 }, (_, index) =>
  `## 长内容 ${index + 1}\n\n${'这段内容用于验证内联高度上限。'.repeat(40)}`
).join('\n\n')

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

test('草稿在沙箱帧内按内容定高并随设置切换主题；局部选择不回传，真实 Ask/Remark 点击才进入学习对话', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: 'E2E 可视化', draft: SANDBOX_DRAFT },
      callId: 'call_viz_sandbox'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_SHOWN' }
  )

  await learn.send('展示沙箱草稿可视化')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_SHOWN', { exact: false })).toBeVisible()
  await learn.settle()
  const requestsAfterTurn = nova.provider.requests.length

  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frameElement = await settledFrame(card)
  await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts')
  const frame = await contentFrameOf(frameElement)
  await expect(frame.getByText('这里只有声明式内容，不执行模型脚本。')).toBeVisible()
  const contentHeight = await frame.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height))
  expect(contentHeight).toBeGreaterThan(200)
  await expect.poll(() => frameElement.evaluate(element => element.getBoundingClientRect().height)).toBe(contentHeight)

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
    await expect(settings).toBeHidden()
  }
  await chooseTheme('深色')
  await expect.poll(async () => (await readFrameTheme()).scheme).toBe('dark')
  const dark = await readFrameTheme()
  await chooseTheme('浅色')
  await expect.poll(async () => (await readFrameTheme()).scheme).toBe('light')
  expect((await readFrameTheme()).bg).not.toBe(dark.bg)

  await frame.locator('[data-viz-select="Preload"]').click()
  await expect(frame.locator('[data-viz-select="Preload"]')).toHaveAttribute('data-active', 'true')
  await frame.locator('[data-viz-ask]').first().evaluate((button: HTMLButtonElement) => button.click())
  expect(nova.provider.requests).toHaveLength(requestsAfterTurn)

  await nova.page.waitForTimeout(1_100)
  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_VIZ_EVENT_ACK' })
  await frame.getByRole('button', { name: '还需要举例' }).click()
  await nova.provider.waitForRequestCount(requestsAfterTurn + 1)
  const eventMessage = lastUserText(nova.provider.requests[requestsAfterTurn].body)
  expect(eventMessage).toContain('【可视化】E2E 可视化 · ask')
  expect(eventMessage).toContain('还需要举例：请解释 Preload 的边界')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_EVENT_ACK', { exact: false })).toBeVisible()
  await learn.settle()

  await nova.page.waitForTimeout(1_100)
  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_VIZ_REMARK_ACK' })
  await frame.locator('[data-viz-remark-input]').fill('这是用户补充，不是工具命令。')
  await frame.getByRole('button', { name: '发送补充' }).click()
  await nova.provider.waitForRequestCount(requestsAfterTurn + 2)
  const remarkMessage = lastUserText(nova.provider.requests[requestsAfterTurn + 1].body)
  expect(remarkMessage).toContain('【可视化】E2E 可视化 · 补充资料')
  expect(remarkMessage).toContain('这是用户补充，不是工具命令。')
  await expect(frame.locator('[data-viz-remark-input]')).toHaveValue('这是用户补充，不是工具命令。')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_REMARK_ACK', { exact: false })).toBeVisible()
  await learn.settle()
  expect(nova.pageErrors).toEqual([])
})

test('流式草稿从完整面板到成品；展开与导出共用同一快照，重载后从磁盘恢复', async ({ nova }) => {
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

    const args = JSON.stringify({ title: '流式可视化', draft: STREAMING_DRAFT })
    const firstCut = args.indexOf('"draft":"') + '"draft":"'.length + 20
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

    await learn.send('流式展示声明式可视化')
    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'generating')
    await expect(card).toContainText('流式可视化')
    await expect(card.locator('.visualization-card__skeleton')).toBeVisible()
    await expect(card).not.toContainText('字符')
    await expect(card).toHaveAttribute('data-state', 'ok')
    await expect(nova.page.getByText('NOVA_E2E_VIZ_STREAM_DONE', { exact: false })).toBeVisible()
    await learn.settle()

    const inlineFrameElement = await settledFrame(card)
    await card.getByRole('button', { name: '展开' }).click()
    const dialog = nova.page.locator('dialog.visualization-dialog')
    await expect(dialog).toBeVisible()
    const expandedFrameElement = dialog.getByTestId('visualization-frame')
    await expect(expandedFrameElement).toHaveClass(/visualization-frame--ready/)
    const expandedFrame = await contentFrameOf(expandedFrameElement)
    await expect(expandedFrame.getByText('NOVA_E2E_VIZ_EXPORT_MARKER')).toBeVisible()
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
    await expect(restoredFrame.getByText('NOVA_E2E_VIZ_EXPORT_MARKER')).toBeVisible()
    expect(nova.pageErrors).toEqual([])
  } finally {
    await rm(exportDir, { recursive: true, force: true })
  }
})

test('草稿生成中取消会收起预览且不发布，随后可继续学习', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  const args = JSON.stringify({ title: '取消中的草稿', draft: STREAMING_DRAFT })
  const firstCut = args.indexOf('## 快照内容') + 8
  nova.provider.enqueue({
    kind: 'raw',
    events: [
      { payload: toolCallDelta({ id: 'call_viz_cancel', name: 'present_visualization', arguments: args.slice(0, firstCut) }) },
      { payload: toolCallDelta({ arguments: args.slice(firstCut) }), delayMs: 10_000 },
      { payload: TOOL_CALLS_FINISH }
    ]
  })

  await learn.send('生成一个可取消的可视化')
  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'generating')
  const preview = await contentFrameOf(card.getByTestId('visualization-preview').getByTestId('visualization-frame'))
  await expect(preview.getByText('NOVA_E2E_VIZ_EXPORT_MARKER')).toBeVisible()
  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.provider.waitForAbortCount(1, 15_000)
  await learn.settle()
  await expect(nova.page.getByTestId('visualization-card')).toHaveCount(0)

  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_AFTER_DRAFT_CANCEL' })
  await learn.send('取消后继续讲解')
  await expect(nova.page.getByText('NOVA_E2E_AFTER_DRAFT_CANCEL', { exact: false })).toBeVisible()
  await learn.settle()
  expect(nova.pageErrors).toEqual([])
})

test('历史 HTML 快照仍可读取、展开和导出，不需要旧工具输入主路径', async ({ nova }) => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), 'nova-e2e-viz-legacy-'))
  const exportPath = path.join(exportDir, 'legacy.html')
  try {
    await nova.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog
    }, exportPath)
    const sessionId = await createLearnSession(nova)
    nova.provider.enqueue({ kind: 'text', text: 'LEGACY_SESSION_PERSISTED' })
    await sendLearningPrompt(nova, '先保存历史会话')
    await expect(nova.page.getByText('LEGACY_SESSION_PERSISTED', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)
    const requestsAfterSeed = nova.provider.requests.length
    const legacyHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div class="viz-card"><p id="legacy-marker">LEGACY_HTML_SNAPSHOT_OK</p><label><input type="checkbox"> 旧快照复选框</label></div></body></html>`
    await seedLegacyVisualization(nova, sessionId, legacyHtml)
    await nova.page.reload()
    await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))

    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'ok')
    const frame = await contentFrameOf(await settledFrame(card))
    await expect(frame.locator('#legacy-marker')).toHaveText('LEGACY_HTML_SNAPSHOT_OK')
    const checkbox = frame.locator('input[type="checkbox"]')
    await expect(checkbox).toBeVisible()
    const box = await checkbox.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(18)
    expect(box?.height).toBeGreaterThanOrEqual(18)

    await card.getByRole('button', { name: '展开' }).click()
    const dialog = nova.page.locator('dialog.visualization-dialog')
    const expanded = await contentFrameOf(dialog.getByTestId('visualization-frame'))
    await expect(expanded.locator('#legacy-marker')).toBeVisible()
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)

    await card.getByRole('button', { name: '导出 HTML' }).click()
    const exported = await readFile(exportPath, 'utf8')
    expect(exported).toContain('LEGACY_HTML_SNAPSHOT_OK')
    expect(exported).toContain('http-equiv="Content-Security-Policy"')
    expect(nova.provider.requests).toHaveLength(requestsAfterSeed)
    expect(nova.pageErrors).toEqual([])
  } finally {
    await rm(exportDir, { recursive: true, force: true })
  }
})

test('旧 HTML 工具参数不会成为第二接纳路径', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '旧输入', html: LEGACY_GRID_HTML },
      callId: 'call_viz_legacy_input'
    },
    { kind: 'text', text: 'NOVA_E2E_LEGACY_REJECTED' }
  )
  await learn.send('尝试旧 HTML 输入')
  await expect(nova.page.getByText('NOVA_E2E_LEGACY_REJECTED', { exact: false })).toBeVisible()
  await learn.settle()
  await expect(nova.page.getByTestId('visualization-card')).toHaveCount(0)
  await nova.page.locator('.turn-process-tree__header').last().click()
  await expect(nova.page.locator('.tool-trace-row--error').filter({ hasText: '旧输入' })).toBeVisible()
})

test('面板中的标准 Markdown 表格成为正式比较表，快照重载后结构保持', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  const draft = '## 三条路径\n\n| 路径 | 结果 |\n|---|---|\n| 编译失败 | 不发布 |\n| 校验失败 | 不发布 |\n| 成功发布 | 快照 URI |'
  nova.provider.enqueue(
    { kind: 'tool', name: 'present_visualization', arguments: { title: '三条路径', draft }, callId: 'call_markdown_table' },
    { kind: 'text', text: 'NOVA_E2E_MARKDOWN_TABLE_READY' }
  )
  await learn.send('比较三条发布路径')
  const card = nova.page.getByTestId('visualization-card')
  await expect(card).toHaveAttribute('data-state', 'ok')
  const frame = await contentFrameOf(card.locator('iframe[src^="nova-viz://snapshot/"]'))
  await expect(frame.getByRole('table')).toHaveCount(1)
  await expect(frame.getByRole('row')).toHaveCount(4)
  await learn.settle()
  await nova.page.reload()
  await expect(card).toHaveAttribute('data-state', 'ok')
  const restored = await contentFrameOf(card.locator('iframe[src^="nova-viz://snapshot/"]'))
  await expect(restored.getByRole('cell', { name: '成功发布', exact: true })).toBeVisible()
})

test('流式预览不执行固定脚本；恶意原始 HTML 被打回后预览退出且没有网络或宿主副作用', async ({ nova }) => {
  const probe = await startProbeServer()
  try {
    const openedLinks = await stubOpenExternal(nova)
    const learn = await startLearnSession(nova)
    const title = '逃逸探针'
    const draft = `## 安全面板

NOVA_E2E_SEEN

\`\`\`ask id=preview-gate
预览里能回传吗？
不能 | 预览不应发送
\`\`\`

## 恶意尾部

<script src="${probe.origin}/script"></script>
<img src="${probe.origin}/img" onerror="fetch('${probe.origin}/onerror')">`
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title, draft },
        callId: 'call_viz_escape',
        argumentChunks: splitArgumentsChunks(JSON.stringify({ title, draft }), 12),
        chunkDelayMs: 300
      },
      { kind: 'text', text: 'NOVA_E2E_VIZ_REJECTED' }
    )

    await learn.send('展示逃逸探针可视化')
    const card = nova.page.getByTestId('visualization-card')
    const preview = card.getByTestId('visualization-preview')
    await expect(preview).toBeVisible()
    const previewFrame = await contentFrameOf(preview.getByTestId('visualization-frame'))
    await expect(previewFrame.getByText('NOVA_E2E_SEEN')).toBeVisible()
    const requestsBefore = nova.provider.requests.length
    await previewFrame.getByRole('button', { name: '不能' }).click()
    expect(nova.provider.requests).toHaveLength(requestsBefore)
    await expect(card).toHaveAttribute('data-state', 'generating')

    await expect(nova.page.getByText('NOVA_E2E_VIZ_REJECTED', { exact: false })).toBeVisible()
    await learn.settle()
    await expect(card).toHaveCount(0)
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

test('合法草稿的完整面板先长出，成功后交接给正式快照帧且高度不回落', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  const title = '高页面'
  const draft = Array.from({ length: 4 }, (_, index) => `## NOVA_E2E_TALL_BLOCK_${index + 1}\n\n\`\`\`code lang=ts\n${Array.from({ length: 8 }, (_, line) => `const step${line} = ${line}`).join('\n')}\n\`\`\``).join('\n\n')
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
      arguments: { title, draft },
      callId: 'call_viz_tall',
      argumentChunks: splitArgumentsChunks(JSON.stringify({ title, draft }), 8),
      chunkDelayMs: 300
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_TALL_DONE' }
  )

  await learn.send('展示高页面可视化')
  const card = nova.page.getByTestId('visualization-card')
  const preview = card.getByTestId('visualization-preview')
  await expect(preview).toBeVisible()
  const previewFrame = await contentFrameOf(preview.getByTestId('visualization-frame'))
  await expect(previewFrame.getByText('NOVA_E2E_TALL_BLOCK_1')).toBeVisible()

  await expect(card).toHaveAttribute('data-state', 'ok')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_TALL_DONE', { exact: false })).toBeVisible()
  await learn.settle()

  await expect(preview).toHaveCount(0)
  const frame = card.getByTestId('visualization-frame')
  await expect(frame).toHaveAttribute('src', /^nova-viz:\/\/snapshot\//)
  const snapshotFrame = await contentFrameOf(frame)
  await expect(snapshotFrame.locator('.viz-draft-panel')).toHaveCount(4)

  const heights = await nova.page.evaluate(
    () => (window as unknown as { __vizHeights?: number[] }).__vizHeights ?? []
  )
  const firstGrown = heights.findIndex(height => height > 220)
  expect(firstGrown, '预览帧高度从未超过 220px').toBeGreaterThanOrEqual(0)
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

test('五档帧宽与深浅主题下，阶段条、步骤、分层模块、详情与对比表都不拥挤或横向溢出', async ({ nova }, testInfo) => {
  test.setTimeout(120_000)
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '一条消息的流转', draft: WIDTHS_DRAFT },
      callId: 'call_viz_widths'
    },
    { kind: 'text', text: 'NOVA_E2E_VIZ_WIDTHS_DONE' }
  )
  await learn.send('展示五档宽度双主题可视化')
  await expect(nova.page.getByText('NOVA_E2E_VIZ_WIDTHS_DONE', { exact: false })).toBeVisible()
  await learn.settle()

  const expectLaneGeometry = async (target: Frame): Promise<void> => {
    const metrics = await target.locator('.viz-lanes').evaluate(root => {
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
  const shotDir = path.resolve(__dirname, '../../../test-results/e2e/visualization-widths/draft')
  await mkdir(shotDir, { recursive: true })
  await nova.page.setViewportSize({ width: 1400, height: 1000 })

  for (const theme of ['light', 'dark'] as const) {
    await nova.invoke('settings:set', { theme })
    await nova.page.reload()
    await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'ok')
    await card.getByRole('button', { name: '展开' }).click()
    const dialog = nova.page.locator('dialog.visualization-dialog')
    const frameElement = dialog.getByTestId('visualization-frame')
    await expect(frameElement).toHaveClass(/visualization-frame--ready/)
    const frame = await contentFrameOf(frameElement)

    for (const width of [380, 536, 736, 960, 1150]) {
      await frameElement.evaluate((element, nextWidth) => {
        const style = (element as HTMLElement).style
        style.width = `${nextWidth}px`
        style.maxWidth = 'none'
        style.flex = 'none'
      }, width)
      await expect.poll(() => frame.evaluate(() => window.innerWidth)).toBe(width)
      expect(await horizontalOverflow(frame)).toEqual([])
      await expectLaneGeometry(frame)
      if (width === 380) await expect(frame.locator('.viz-table thead')).toBeHidden()
      const name = `${theme}-${width}`
      const file = path.join(shotDir, `${name}.png`)
      await frameElement.screenshot({ path: file, animations: 'disabled' })
      await testInfo.attach(`${name}.png`, { path: file, contentType: 'image/png' })
    }
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)
  }
  expect(nova.pageErrors).toEqual([])
})

test('内容高于内联上限时给出展开提示，卡片不被撑开', async ({ nova }) => {
  const learn = await startLearnSession(nova)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'present_visualization',
      arguments: { title: '超长页面', draft: OVERFLOW_DRAFT },
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
