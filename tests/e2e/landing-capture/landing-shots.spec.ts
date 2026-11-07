import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import {
  SAVE_MODEL_CONFIG,
  SETTINGS_SET,
  WORKSPACE_CREATE_SESSION,
  WORKSPACE_DELETE_SESSION,
  WORKSPACE_SELECT_PROJECT
} from '../../../src/shared/ipc/channels'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import type { FakeTurn } from '../fixtures/fake-runtime'
import {
  fillLearningAnswer,
  learningDock,
  learningEmptyHeading,
  learningFlow,
  openOutlinePane,
  outlineTopicRow,
  waitLearnTurnSettled
} from '../learning/learningFlow'

/**
 * 宣传页截图：真实 Electron 渲染，只在 OpenAI 兼容服务商边界脚本化模型回复。
 * 不属于回归套件（test:main 不包含本目录），按需手动运行：
 *   npm run build && npx --prefix tests/e2e playwright test landing-capture
 * 产物写入 landing/assets/shots/。
 */
const OUT_DIR = path.resolve(__dirname, '../../../landing/assets/shots')
const CAPSULE = '.session-status-rail:not(.session-status-rail--inspector) .session-status'

const TIMER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>番茄钟</title>
<h1 id="timer">25:00</h1>
<p>今天完成 <b id="done">0</b> 个</p>
<button id="start">开始专注</button>
<button id="reset">重置</button>
<script>
const KEY = 'tomato-state'
const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
let left = saved.left ?? 25 * 60
let done = saved.day === today() ? saved.done : 0
let ticking = null

function today() { return new Date().toDateString() }
function save() { localStorage.setItem(KEY, JSON.stringify({ left, done, day: today() })) }
function render() {
  timer.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0')
  document.getElementById('done').textContent = done
}

start.onclick = () => {
  if (ticking) return
  ticking = setInterval(() => {
    left -= 1
    if (left <= 0) { done += 1; left = 25 * 60; clearInterval(ticking); ticking = null }
    save(); render()
  }, 1000)
}
reset.onclick = () => { clearInterval(ticking); ticking = null; left = 25 * 60; save(); render() }
render()
</script>
`

function outlineNode(nodeId: string, title: string, navDimension: string, summary: string, learningGoal: string): Record<string, unknown> {
  return {
    nodeId,
    title,
    summary,
    learningGoal,
    navDimension,
    parentNodeId: null,
    claims: [],
    prerequisiteNodeIds: [],
    relatedNodeIds: [],
    flowNextNodeIds: []
  }
}

/** 大纲编译输出：主题围绕故事里刚做出来的番茄钟。 */
const OUTLINE_OUTPUT = JSON.stringify({
  schemaVersion: 1,
  nodes: [
    outlineNode('t-purpose', '这个页面解决什么问题', 'project_purpose', '25 分钟专注计时与今日计数。', '说清页面目标'),
    outlineNode('t-boot', '打开页面时发生了什么', 'startup_runtime', '读回存档、渲染初始时间。', '说清启动顺序'),
    outlineNode('t-tick', '计时如何开始与停止', 'key_user_flows', '开始、每秒减一、重置。', '说清计时器生命周期'),
    outlineNode('t-store', '数据存在哪、怎么读回', 'data_and_state', 'localStorage 里的 left / done / day。', '说清持久化'),
    outlineNode('t-tradeoff', '为什么不用后端', 'design_tradeoffs', '单文件双击即用的取舍。', '说清技术取舍')
  ]
})

async function shot(nova: NovaHarness, name: string, keepPointer = false): Promise<void> {
  // 指针移出内容区，避免悬停提示混进截图；等过渡与流式渲染落定
  if (!keepPointer) await nova.page.mouse.move(1270, 790)
  await nova.page.waitForTimeout(700)
  await nova.page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), animations: 'disabled' })
}

async function prepareStoryWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nova-landing-')))
  const workspace = path.join(root, 'tomato-timer')
  await mkdir(path.join(workspace, 'old-build'), { recursive: true })
  await writeFile(path.join(workspace, 'README.md'), '# tomato-timer\n\n一个单文件番茄钟。\n', 'utf8')
  await writeFile(path.join(workspace, 'old-build', 'stale.txt'), 'stale\n', 'utf8')
  return workspace
}

async function expandCapsule(nova: NovaHarness): Promise<Locator> {
  const capsule = nova.page.locator(CAPSULE)
  if ((await capsule.getAttribute('data-expanded')) !== 'true') {
    await nova.page.getByRole('button', { name: '查看会话状态', exact: true }).click()
    await expect(capsule).toHaveAttribute('data-expanded', 'true')
  }
  return capsule
}

async function collapseCapsule(nova: NovaHarness): Promise<void> {
  const capsule = nova.page.locator(CAPSULE)
  if ((await capsule.count()) === 0) return
  if ((await capsule.getAttribute('data-expanded')) === 'true') {
    await capsule.getByRole('button', { name: '收起浮窗' }).click()
    await expect(capsule).toHaveAttribute('data-expanded', 'false')
  }
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  const last = messages.filter(message => message.role === 'user').at(-1)
  return JSON.stringify(last?.content ?? '')
}

/** 学习游标版本由产品注入请求；读不到时按回合数兜底。 */
function cursorVersionOf(body: Record<string, unknown>, fallback: number): number {
  const match = JSON.stringify(body.messages ?? '').match(/cursorVersion\D{0,8}(\d+)/g)
  const last = match?.at(-1)?.match(/(\d+)$/)
  return last ? Number(last[1]) : fallback
}

function learnCheckpoint(callId: string, cursorVersion: number, question: string, anchor: string): FakeTurn {
  return {
    kind: 'raw',
    events: [
      { payload: { choices: [{ index: 0, delta: { content: anchor }, finish_reason: null }] } },
      {
        payload: {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: callId,
                type: 'function',
                function: {
                  name: 'learning_checkpoint',
                  arguments: JSON.stringify({
                    question,
                    cursorVersion,
                    checkpointId: `ckpt-${callId}`,
                    rubric: {
                      targetClaim: '说明刷新后数据从 localStorage 读回',
                      knowledgeRevision: null,
                      verificationMethod: 'open_answer',
                      criteria: '能指出 save() 写入、加载时 getItem 读回'
                    }
                  })
                }
              }]
            },
            finish_reason: null
          }]
        }
      },
      { payload: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } }
    ]
  }
}

test('宣传页截图：一句话做出来，再切到学习搞懂它', async ({ nova }) => {
  test.setTimeout(300_000)
  await mkdir(OUT_DIR, { recursive: true })

  // 换成有意义的工作区名与模型名；默认临时工作区的空草稿删掉，侧栏只留故事主角
  const original = await nova.getWorkspace()
  const workspace = await prepareStoryWorkspace()
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

  // ── 开发：普通会话，一句话做出来 ─────────────────────────
  const dev = await nova.invoke(WORKSPACE_CREATE_SESSION, { workspaceRoot: workspace, mode: 'default' })
  const devId = dev.currentSessionId!
  const input = nova.page.getByLabel('消息输入')
  await expect(input).toBeVisible()
  await input.fill('帮我做一个番茄钟页面，要能记住今天完成了几个')
  await shot(nova, 'dev-01-compose')

  // hold 释放后吐出的正文就是本轮最终回复，所以工具都排在它前面
  nova.provider.enqueue(
    { kind: 'tool', name: 'read', arguments: { path: 'README.md' }, callId: 'call_read_readme' },
    { kind: 'tool', name: 'write', arguments: { path: 'tomato-timer.html', content: TIMER_HTML }, callId: 'call_write' },
    { kind: 'tool', name: 'bash', arguments: { command: 'Remove-Item -Recurse -Force old-build' }, callId: 'call_bash_clean' },
    {
      kind: 'hold',
      id: 'dev-hold',
      text: '做好了。`tomato-timer.html` 双击就能打开：\n\n- 专注 25 分钟，结束自动记一个\n- 刷新页面接着上次的倒计时，跨天计数自动清零\n- 连点「开始专注」不会叠加计时器\n\n顺手清掉了旧的 `old-build` 目录。改动都在审阅里，逐个文件看完再保留。'
    }
  )
  await nova.page.getByRole('button', { name: '发送' }).click()
  await expect(nova.page.getByText(/写入 1 个文件/).first()).toBeVisible({
    timeout: 30_000
  })

  // 删除目录属于风险操作：出现授权条就留证再放行；没出现则继续
  const allow = nova.page.locator('.inline-perm__btn--allow').first()
  if (await allow.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) {
    await collapseCapsule(nova)
    await shot(nova, 'dev-02-permission')
    await allow.click()
  }
  await nova.provider.waitForRequestCount(4, 30_000)
  await collapseCapsule(nova)
  await shot(nova, 'dev-03-working')

  nova.provider.release('dev-hold')
  await nova.waitUntilIdle()
  await collapseCapsule(nova)
  await shot(nova, 'dev-04-done')

  const capsule = nova.page.locator(CAPSULE)
  if ((await capsule.count()) > 0) {
    await expandCapsule(nova)
    await shot(nova, 'dev-05-status')
    const reviewEntry = capsule.getByRole('button', { name: '审阅这轮改动' })
    if (await reviewEntry.isVisible().catch(() => false)) {
      await reviewEntry.click()
      const expandAll = nova.page.getByRole('button', { name: '全部展开' })
      if (await expandAll.isVisible().catch(() => false)) await expandAll.click()
      await nova.page.waitForTimeout(800)
      await shot(nova, 'dev-06-review')
    }
  }

  // ── 学习：先留空状态，再从开发回复的「学懂这次改动」进入 ──────
  const learn = await nova.invoke(WORKSPACE_CREATE_SESSION, { workspaceRoot: workspace, mode: 'learn' })
  const learnId = learn.currentSessionId!
  await expect(learningEmptyHeading(nova)).toBeVisible()
  if (await nova.page.getByRole('tabpanel', { name: '大纲' }).isVisible().catch(() => false)) {
    await nova.page.getByRole('button', { name: '大纲、文件与浏览面板' }).click()
  }
  await shot(nova, 'learn-01-empty')

  await nova.page.getByRole('button', { name: '开发' }).first().click()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  expect((await nova.getWorkspace()).currentSessionId).toBe(devId)
  const lastReply = nova.page.getByRole('article', { name: 'Message from assistant' }).last()
  await lastReply.hover()
  const learnEntry = lastReply.getByRole('button', { name: '学懂这次改动' })
  await expect(learnEntry).toBeVisible()
  await shot(nova, 'dev-07-learn-entry', true)

  const flowFence = [
    '```openui',
    'root = Col([life])',
    'life = Flow([{title: "点开始专注", detail: "只起一个计时器"}, {title: "每秒减一", detail: "setInterval 回调"}, {title: "写进本机", detail: "save() 存进 localStorage"}, {title: "刷新读回", detail: "启动时 getItem"}], $step)',
    '$step = 0',
    '```'
  ].join('\n')
  nova.provider.enqueue(
    { kind: 'tool', name: 'read', arguments: { path: 'tomato-timer.html' }, callId: 'call_learn_read' },
    {
      kind: 'text',
      text: [
        '我们一步一步来，这次只看**数据怎么流动**，先不管样式。',
        '',
        '**第 1 步：计时从哪开始**',
        '',
        '你点「开始专注」时，`start.onclick` 先看 `ticking`：已经有计时器就直接返回，所以连点也只跑一个。',
        '',
        flowFence,
        '',
        '接下来是 `save()`：每过一秒，它把剩余秒数和今天的日期一起写进浏览器本地存储。',
        '',
        '```suggestions',
        '- 为什么要先判断 ticking？',
        '- 跨天清零是怎么做到的？',
        '- 考考我',
        '```'
      ].join('\n')
    }
  )
  await learnEntry.click()
  await expect(nova.page.getByLabel('学习提问')).toBeVisible()
  expect((await nova.getWorkspace()).currentSessionId).toBe(learnId)
  await waitLearnTurnSettled(nova, learnId)
  await expect(learningFlow(nova).getByRole('group', { name: '接下来可以问' })).toBeVisible()
  await shot(nova, 'learn-02-explain')

  const question = '刷新页面后，倒计时为什么能接着上次的走？'
  let checkpointIssued = false
  nova.provider.setTurnFactory(record => {
    if (checkpointIssued || !lastUserText(record.body).includes('考考我')) return null
    checkpointIssued = true
    return learnCheckpoint('call_ckpt_landing', cursorVersionOf(record.body, 2), question, '好，来检查一下理解。')
  })
  await learningFlow(nova).getByRole('button', { name: '考考我' }).click()
  await waitLearnTurnSettled(nova, learnId)
  nova.provider.setTurnFactory(null)
  await expect(learningDock(nova)).toContainText(question)
  await fillLearningAnswer(nova, '每秒 save() 把剩余秒数写进 localStorage，页面加载时先 getItem 读回来')
  await shot(nova, 'learn-03-question')

  // 评估回合：从请求里取回答尝试 ID，提交「理解到位」
  let assessed = false
  let contextRead = false
  nova.provider.setTurnFactory(record => {
    const raw = JSON.stringify(record.body)
    if (assessed) return null
    const attempt = raw.match(/attemptId\W{0,8}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
    if (!attempt) {
      // 回答尝试 ID 只能经学习上下文工具读到：先读一次，下一请求再评估
      if (contextRead) return null
      contextRead = true
      return { kind: 'tool', name: 'learning_context', arguments: {}, callId: 'learning_ctx_read' }
    }
    assessed = true
    return {
      kind: 'tool',
      name: 'learning_assess',
      arguments: {
        attemptId: attempt[1],
        checkpointId: 'ckpt-call_ckpt_landing',
        verdict: 'understanding_observed',
        summary: '指出了写入时机与读回位置',
        cursorVersion: Number(raw.match(/status\\+":\\+"ok\\+",\\+"cursorVersion\\+":(\d+)/)?.[1] ?? cursorVersionOf(record.body, 3))
      },
      callId: 'learning_assess_done'
    }
  })
  nova.provider.enqueue({
    kind: 'text',
    text: [
      '对，关键就两处：`save()` 每秒写一次，脚本开头 `getItem` 读回来。',
      '',
      '**第 2 步：跨天为什么会清零**',
      '',
      '存进去的不只是秒数，还有 `day`。读回时比较 `saved.day === today()`，不是今天就把 `done` 归零。',
      '',
      '```suggestions',
      '- 如果用户改了系统时间会怎样？',
      '- 把这段改成按周统计',
      '```'
    ].join('\n')
  })
  await learningDock(nova).getByRole('button', { name: '提交' }).click()
  await waitLearnTurnSettled(nova, learnId)
  nova.provider.setTurnFactory(null)
  await expect(nova.page.getByLabel('学习提问')).toBeVisible()
  await shot(nova, 'learn-04-assessed')

  // ── 学习：生成项目大纲 ───────────────────────────────────
  nova.provider.setTurnFactory(record => {
    const messages = Array.isArray(record.body.messages) ? (record.body.messages as Array<{ content?: unknown }>) : []
    const isBuild = messages.some(message => typeof message.content === 'string' && message.content.includes('skeleton_knowledge_compile'))
    return isBuild ? { kind: 'text', text: OUTLINE_OUTPUT } : null
  })
  const pane = await openOutlinePane(nova)
  await pane.getByRole('button', { name: '生成大纲' }).click()
  await expect(outlineTopicRow(pane, '计时如何开始与停止')).toBeVisible({ timeout: 60_000 })
  nova.provider.setTurnFactory(null)
  await shot(nova, 'learn-05-outline')

  expect(devId).not.toBe(learnId)
  expect(nova.pageErrors).toEqual([])
})
