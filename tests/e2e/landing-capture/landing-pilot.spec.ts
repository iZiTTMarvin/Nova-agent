import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  BROWSER_OPEN,
  SAVE_MODEL_CONFIG,
  SETTINGS_SET,
  WORKSPACE_CREATE_SESSION,
  WORKSPACE_DELETE_SESSION,
  WORKSPACE_SELECT_PROJECT,
  WORKSPACE_SET_PERMISSION_MODE
} from '../../../src/shared/ipc/channels'
import { expect, test, type NovaHarness } from '../fixtures/nova'

/**
 * 宣传页领航截图：真实 Electron 渲染，只在 OpenAI 兼容服务商边界脚本化模型回复。
 * 不属于回归套件，按需手动运行：
 *   npm run build && npx --prefix tests/e2e playwright test landing-capture/landing-pilot
 * 产物写入 landing/assets/shots/。
 */
const OUT_DIR = path.resolve(__dirname, '../../../landing/assets/shots')
const CAPSULE = '.session-status-rail:not(.session-status-rail--inspector) .session-status'

const BUGGY_HTML = `<!doctype html>
<meta charset="utf-8">
<title>番茄钟</title>
<style>
* { box-sizing: border-box }
body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #faf8f5; color: #18181b }
.card { width: 320px; padding: 28px 24px; border-radius: 20px; background: #fff; border: 1px solid rgba(0,0,0,0.07); box-shadow: 0 14px 34px rgba(0,0,0,0.05); text-align: center }
.tag { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #fef3c7; color: #b45309; font-size: 12.5px; font-weight: 600 }
h1 { font: 700 64px/1.05 "JetBrains Mono", Consolas, monospace; letter-spacing: -0.03em; margin: 16px 0 8px }
p { margin: 0 0 16px; color: #52525b; font-size: 14px }
p b { color: #d97706; font-weight: 700 }
.bar { height: 7px; border-radius: 999px; background: #f4f4f5; overflow: hidden; margin-bottom: 20px }
.bar i { display: block; width: 92%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #f59e0b, #ea580c) }
.btns { display: flex; justify-content: center; gap: 10px }
button { font: 600 13.5px/1 system-ui, sans-serif; padding: 10px 18px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.12); background: #fff; color: #18181b; cursor: pointer }
#start { background: #18181b; color: #fff; border-color: #18181b }
</style>
<div class="card">
  <span class="tag">专注进行中</span>
  <h1 id="timer">25:00</h1>
  <p>今天已完成 <b id="done">0</b> 个番茄</p>
  <div class="bar"><i></i></div>
  <div class="btns">
    <button id="start">继续专注</button>
    <button id="reset">重置</button>
  </div>
</div>
<script>
const KEY = 'tomato-state'
if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify({ left: 1487, done: 3 }))
let left = 25 * 60
let done = 0
let ticking = null

function save() { localStorage.setItem(KEY, JSON.stringify({ left, done })) }
function render() {
  timer.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0')
  document.getElementById('done').textContent = done
}

start.onclick = () => {
  if (ticking) return
  ticking = setInterval(() => {
    left -= 1
    if (left <= 0) { done += 1; left = 25 * 60 }
    save(); render()
  }, 1000)
}
render()
</script>
`

const FIXED_HTML = BUGGY_HTML.replace(
  'let left = 25 * 60\nlet done = 0',
  "const saved = JSON.parse(localStorage.getItem(KEY) || '{}')\nlet left = saved.left ?? 25 * 60\nlet done = saved.done ?? 0"
)

const RELOAD_LOG_CMD =
  `node -e "for (let i = 0; i < 1200; i++) { const left = 1500 - i; console.log('[tick ' + String(i).padStart(4, '0') + '] left=' + left + ' saved=' + left + ' after-reload=' + left + ' ok') } console.log('RELOAD CHECK: 1200/1200 restored')"`

function toolText(body: unknown): string {
  const messages = body && typeof body === 'object' && 'messages' in body && Array.isArray(body.messages) ? body.messages : []
  const last = [...messages].reverse().find(message => message?.role === 'tool')
  return typeof last?.content === 'string' ? last.content : ''
}

function field(text: string, key: string): string {
  return new RegExp(`^${key}: (.+)$`, 'm').exec(text)?.[1]?.trim() ?? ''
}

async function shot(nova: NovaHarness, name: string): Promise<void> {
  await nova.page.mouse.move(1270, 790)
  await nova.page.waitForTimeout(700)
  await nova.page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), animations: 'disabled' })
}

test('宣传页截图：领航用方法定位根因，并留下真实证据', async ({ nova }) => {
  test.setTimeout(240_000)
  await mkdir(OUT_DIR, { recursive: true })

  const original = await nova.getWorkspace()
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nova-landing-pilot-')))
  const workspace = path.join(root, 'tomato-timer')
  await mkdir(workspace, { recursive: true })
  const pagePath = path.join(workspace, 'tomato-timer.html')
  await writeFile(pagePath, BUGGY_HTML, 'utf8')

  await nova.invoke(SAVE_MODEL_CONFIG, {
    baseUrl: nova.provider.baseUrl,
    apiKey: 'nova-landing-key',
    modelId: 'nova-demo-model',
    cacheProfile: 'generic',
    toolDialect: 'native'
  })
  await nova.invoke(SETTINGS_SET, { theme: 'light' })
  await nova.invoke(WORKSPACE_SELECT_PROJECT, { path: workspace })
  for (const session of original.availableSessions) {
    await nova.invoke(WORKSPACE_DELETE_SESSION, { sessionId: session.id }).catch(() => undefined)
  }
  await nova.page.reload()
  await nova.page.setViewportSize({ width: 1280, height: 800 })

  const created = await nova.invoke(WORKSPACE_CREATE_SESSION, { workspaceRoot: workspace, mode: 'pilot' })
  const sessionId = created.currentSessionId!
  await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'full_access' })
  await expect(nova.page.locator('.chat-composer-box--pilot')).toBeVisible()

  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(await readFile(pagePath, 'utf8'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  try {
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
    if (opened.status !== 'applied') throw new Error('Fixture browser did not open')
    const browserId = opened.page.browserId

    const todos = (states: Array<'pending' | 'in_progress' | 'completed'>) => [
      '复现：刷新页面，确认倒计时回到 25:00',
      '定位根因：存档写了，启动时有没有读回',
      '修复读取，不改写入逻辑',
      '在真实页面里验证刷新后接着走'
    ].map((content, index) => ({ content, status: states[index], priority: 'high' }))

    let step = 0
    let imageUrl = ''
    let workflowDir = ''
    let artifactId = ''
    nova.provider.setTurnFactory(record => {
      const latest = toolText(record.body)
      switch (step++) {
        case 0:
          return { kind: 'tool', name: 'invoke_skill', arguments: { skill_name: 'builtin:nova-pilot', task: '刷新页面后番茄钟回到 25:00，修好它' }, callId: 'pilot-method' }
        case 1:
          workflowDir = /`([^`]+)\/workflows\/`/.exec(latest)?.[1] ?? ''
          if (!workflowDir) throw new Error('Missing builtin workflow directory')
          return { kind: 'tool', name: 'read', arguments: { path: path.join(workflowDir, 'workflows', 'bug-fix.md') }, callId: 'pilot-workflow' }
        case 2:
          return { kind: 'tool', name: 'todo_write', arguments: { todos: todos(['in_progress', 'pending', 'pending', 'pending']) }, callId: 'todo-1' }
        case 3:
          return { kind: 'tool', name: 'read', arguments: { path: 'tomato-timer.html' }, callId: 'read-page' }
        case 4:
          return { kind: 'tool', name: 'todo_write', arguments: { todos: todos(['completed', 'completed', 'in_progress', 'pending']) }, callId: 'todo-2' }
        case 5:
          return { kind: 'tool', name: 'write', arguments: { path: 'tomato-timer.html', content: FIXED_HTML }, callId: 'write-fix' }
        case 6:
          return { kind: 'tool', name: 'browser_open', arguments: { action: 'reload', browserId }, callId: 'reload-page' }
        case 7:
          return { kind: 'tool', name: 'browser_observe', arguments: { action: 'snapshot', browserId }, callId: 'observe' }
        case 8:
          return { kind: 'tool', name: 'browser_capture', arguments: { observation: {
            browserId, generation: Number(field(latest, 'generation')), documentEpoch: Number(field(latest, 'documentEpoch')),
            observationId: field(latest, 'observationId')
          } }, callId: 'capture' }
        case 9:
          imageUrl = field(latest, 'imageEvidence')
          return { kind: 'tool', name: 'bash', arguments: { command: RELOAD_LOG_CMD }, callId: 'reload-check' }
        case 10:
          artifactId = /artifact:\/\/([a-z0-9-]+)/.exec(latest)?.[1] ?? ''
          return { kind: 'tool', name: 'todo_write', arguments: { todos: todos(['completed', 'completed', 'completed', 'completed']) }, callId: 'todo-3' }
        case 11: {
          return { kind: 'tool', name: 'present_evidence', arguments: { items: [
            { kind: 'image', url: imageUrl, description: '修复后的页面画面' },
            { kind: 'artifact', artifactId, description: '刷新后读回存档的逐次检查输出' }
          ] }, callId: 'present' }
        }
        default:
          return {
            kind: 'hold',
            id: 'pilot-final',
            before: '',
            text: [
              '修好了：刷新页面后倒计时会接着上次的剩余时间走。',
              '',
              '**根因**：每秒都把剩余秒数写进了存档，但页面启动时 `left` 直接取了 25 分钟，从没读回存档。现在启动时先读存档，写入逻辑没动。',
              '',
              '**验证**：用同一个页面入口反复刷新，剩余秒数与存档逐次一致，输出和页面截图在上方。',
              '',
              '**没验证的**：跨天自动清零、多个标签页同时打开。'
            ].join('\n')
          }
      }
    })

    const input = nova.page.getByLabel('消息输入')
    await input.fill('番茄钟刷新页面后又回到 25:00 了，帮我修好')
    await nova.page.getByRole('button', { name: '发送' }).click()

    await expect(nova.page.getByTestId('evidence-card')).toBeVisible({ timeout: 60_000 })
    await shot(nova, 'pilot-01-evidence')

    await nova.page.getByRole('button', { name: '审阅、文件与浏览面板' }).click()
    await expect(nova.page.locator(CAPSULE)).toHaveAttribute('data-expanded', 'true')
    await shot(nova, 'pilot-01-todos')

    nova.provider.release('pilot-final')
    nova.provider.setTurnFactory(null)
    await nova.waitUntilIdle()
    await expect(nova.page.locator(CAPSULE)).toContainText('审阅这轮改动')
    await nova.page.locator(CAPSULE).getByRole('button', { name: '收起浮窗' }).click()
    await expect(nova.page.locator(CAPSULE)).toHaveAttribute('data-expanded', 'false')
    await shot(nova, 'pilot-02-delivery')

    await nova.page.getByTestId('evidence-card').getByRole('button', { name: '查看日志' }).click()
    await expect(nova.page.getByTestId('evidence-card').locator('pre')).toContainText('RELOAD CHECK')
    await shot(nova, 'pilot-03-log')
  } finally {
    nova.provider.setTurnFactory(null)
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  expect(nova.pageErrors).toEqual([])
})
