/**
 * 学习 E2E 共享工具：定位一律走角色与无障碍名称（文案见学习文案表），
 * 只在 HTTP 服务商边界控制模型响应。
 */
import { expect } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FakeRuntime, FakeTurn } from '../fixtures/fake-runtime'
import type { NovaHarness } from '../fixtures/nova'
import { isTerminalRunStatus } from '../../../src/shared/run/types'

export const CHECKPOINT_QUESTION = '刷新之后这条记录还在，主要依靠哪一段？'

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function contentDelta(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
}

function checkpointToolDelta(callId: string): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: 'function',
              function: {
                name: 'learning_checkpoint',
                arguments: JSON.stringify({
                  question: CHECKPOINT_QUESTION,
                  cursorVersion: 1,
                  checkpointId: `ckpt-${callId}`,
                  rubric: {
                    targetClaim: '指出刷新后数据的来源',
                    knowledgeRevision: null,
                    verificationMethod: 'open_answer',
                    criteria: '能说明刷新后数据从哪读取'
                  }
                })
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

/** 教练出题回合：可选一段正文（用于断言题目行锚定在这条回复之后），随后落停点并结束本轮。 */
export function checkpointToolTurn(callId: string, anchorText?: string): FakeTurn {
  const events: Array<{ payload: Record<string, unknown> | '[DONE]' }> = []
  if (anchorText) events.push({ payload: contentDelta(anchorText) })
  events.push({ payload: checkpointToolDelta(callId) })
  events.push({ payload: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } })
  return { kind: 'raw', events }
}

export async function createLearnSession(nova: NovaHarness): Promise<string> {
  const state = await nova.createSession('learn')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('learn session id missing')
  await expect(learningEmptyHeading(nova)).toBeVisible()
  return sessionId
}

export function learningEmptyHeading(nova: NovaHarness): Locator {
  return nova.page.getByRole('heading', { name: /想搞懂 .* 的哪一部分？/ })
}

/**
 * 等输入框可编辑：不可编辑时 contenteditable 为 false，fill 会立刻报错而不是等待，
 * 而 toBeEditable 对 role=textbox 只看 aria-readonly，判断不出这种禁用。
 */
async function waitEditable(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate(element => (element as HTMLElement).isContentEditable).catch(() => false), {
      timeout: 20_000
    })
    .toBe(true)
}

export async function sendLearningPrompt(nova: NovaHarness, text: string): Promise<void> {
  const input = nova.page.getByLabel('学习提问')
  await expect(input).toBeVisible()
  await waitEditable(input)
  await input.fill(text)
  await nova.page.getByRole('button', { name: '发送' }).click()
}

/** 停靠面板里填写回答。 */
export async function fillLearningAnswer(nova: NovaHarness, text: string): Promise<void> {
  const input = nova.page.getByLabel('回答')
  await expect(input).toBeVisible()
  await waitEditable(input)
  await input.fill(text)
}

export async function waitLearnTurnSettled(nova: NovaHarness, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await nova.getRunSnapshot(sessionId)
        return snapshot == null || isTerminalRunStatus(snapshot.status)
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

/** 停靠问题面板（出题时替换输入区）。 */
export function learningDock(nova: NovaHarness): Locator {
  return nova.page.getByRole('region', { name: '当前问题' })
}

/** 学习主区容器：只用于 scope，不用于定位元素。 */
export function learningMain(nova: NovaHarness): Locator {
  return nova.page.getByRole('region', { name: '学习对话', exact: true })
}

/** 对话流阅读柱：题目行锚定断言的 scope。 */
export function learningFlow(nova: NovaHarness): Locator {
  return nova.page.getByRole('region', { name: '学习消息', exact: true })
}

export function outlinePane(nova: NovaHarness): Locator {
  return nova.page.getByRole('tabpanel', { name: '大纲' })
}

/** 大纲主题按钮的名称不包含进度提示与展开箭头。 */
export function outlineTopicRow(pane: Locator, title: string): Locator {
  return pane.getByRole('button', { name: title, exact: true })
}

export async function expectSingleLearningInput(nova: NovaHarness): Promise<void> {
  const main = learningMain(nova)
  const textboxes = main.getByRole('textbox')
  await expect(textboxes).toHaveCount(1)
  await expect(textboxes).toBeVisible()
  await expect.poll(() => main.evaluate(element => {
    return Array.from(element.querySelectorAll('input, textarea, [contenteditable="true"]'))
      .filter(target => target.getClientRects().length > 0)
      .filter(target => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? !target.disabled && !target.readOnly && target.type !== 'hidden'
        : (target as HTMLElement).isContentEditable).length
  })).toBe(1)
}

export async function openOutlinePane(nova: NovaHarness): Promise<Locator> {
  const pane = outlinePane(nova)
  if (await pane.isVisible().catch(() => false)) return pane
  const tab = nova.page.getByRole('tab', { name: '大纲' })
  if (await tab.isVisible().catch(() => false)) {
    await tab.click()
  } else {
    const launcherCard = nova.page.getByRole('button', { name: /打开大纲/ })
    // 面板收起时先展开；展开后没有大纲标签就停在启动器，从卡片打开
    if (!(await launcherCard.isVisible().catch(() => false))) {
      await nova.page.getByRole('button', { name: '大纲、文件与浏览面板' }).click()
    }
    await launcherCard.click()
  }
  await expect(pane).toBeVisible()
  return pane
}

/** 读输入框内容：兼容受控 input/textarea 与可编辑容器两种实现。 */
export async function readEditableValue(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    const target = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : (target.textContent ?? '')
  })
}

/** 用户气泡与侧栏标题里不允许出现内部指令、内部概念或会话 id。 */
export async function expectNoInstructionLeak(nova: NovaHarness): Promise<void> {
  const bubbles = await learningMain(nova).getByRole('article', { name: 'Message from user' }).allTextContents()
  const sidebarTitles = await nova.page
    .getByRole('navigation', { name: 'Side navigation' }).getByRole('button')
    .evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? element.textContent ?? ''))
  const menuTitles = await nova.page.getByRole('button').evaluateAll(elements => elements
    .filter(element => element.getAttribute('aria-haspopup') === 'menu')
    .map(element => element.textContent ?? ''))
  for (const text of [...bubbles, ...sidebarTitles, ...menuTitles]) {
    expect(text).not.toContain('[学习')
    expect(text).not.toContain('learning_context')
    expect(text).not.toMatch(UUID_PATTERN)
  }
}

// ── 大纲生成驱动 ──────────────────────────────────────────

const BUILD_PROMPT_MARKER = 'skeleton_knowledge_compile'

function findBuildPrompt(body: Record<string, unknown>): string | null {
  const messages = body.messages
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string' && content.includes(BUILD_PROMPT_MARKER)) return content
  }
  return null
}

/** 给临时工作区补几个代码文件，让大纲取证有真实片段可用。 */
export async function writeSampleCode(workspacePath: string): Promise<void> {
  await mkdir(path.join(workspacePath, 'src'), { recursive: true })
  await mkdir(path.join(workspacePath, 'src', 'data'), { recursive: true })
  await writeFile(
    path.join(workspacePath, 'README.md'),
    '# 示例项目\n\n用于学习大纲生成。\n',
    'utf8'
  )
  await writeFile(
    path.join(workspacePath, 'src', 'module-a.ts'),
    'export function startApp(): void {\n  bootstrap()\n}\n\nfunction bootstrap(): void {}\n',
    'utf8'
  )
  await writeFile(
    path.join(workspacePath, 'src', 'module-b.ts'),
    'import { startApp } from "./module-a"\n\nexport function run(): void {\n  startApp()\n}\n',
    'utf8'
  )
  await writeFile(
    path.join(workspacePath, 'src', 'data', 'loader.ts'),
    'export function loadRecords(): string[] {\n  return []\n}\n',
    'utf8'
  )
}

function compileNode(
  nodeId: string,
  title: string,
  navDimension: string,
  parentNodeId: string | null,
  summary: string,
  learningGoal: string,
  claims: unknown[] = []
): Record<string, unknown> {
  return {
    nodeId,
    title,
    summary,
    learningGoal,
    navDimension,
    parentNodeId,
    claims,
    prerequisiteNodeIds: [],
    relatedNodeIds: [],
    flowNextNodeIds: []
  }
}

/** 合法的编译输出：启动主题带一条引用真实证据的源码要点，其余主题无出处（呈现 ≈ 标记）。 */
export function createCompileOutput(firstSourceId: string | null): string {
  const claims = firstSourceId
    ? [{ kind: 'source_fact', text: '启动入口负责装配核心模块', sourceIds: [firstSourceId] }]
    : []
  return JSON.stringify({
    schemaVersion: 1,
    nodes: [
      compileNode('topic-purpose', '这个项目解决什么问题', 'project_purpose', null, '一句话说清项目用途。', '说清项目的目标'),
      compileNode('topic-startup', '应用如何启动', 'startup_runtime', null, '入口文件与启动顺序。', '说清启动顺序', claims),
      compileNode('topic-startup-init', '启动时的初始化顺序', 'startup_runtime', 'topic-startup', '初始化各模块的先后关系。', '说清初始化依赖'),
      compileNode('topic-modules', '核心模块的职责', 'module_roles', null, '各模块分别负责什么。', '说清模块分工')
    ]
  })
}

export interface OutlineBuildInfo {
  sourceId: string | null
  sourcePath: string | null
}

/** 构建请求全部返回 500：驱动 provider_error 失败横幅。 */
export function installOutlineBuildFailure(provider: FakeRuntime): void {
  provider.setTurnFactory(record =>
    findBuildPrompt(record.body) !== null ? { kind: 'error', status: 500 } : null
  )
}

/** 构建请求挂起不返回：制造「生成中」窗口，供取消。 */
export function installOutlineBuildHold(provider: FakeRuntime, id: string): void {
  provider.setTurnFactory(record =>
    findBuildPrompt(record.body) !== null ? { kind: 'hold', id, text: '{}' } : null
  )
}

/** 解析取证请求里的第一个证据片段，返回能通过校验的编译输出；命中信息写回 info。 */
export function installOutlineBuildSuccess(provider: FakeRuntime, info: OutlineBuildInfo): void {
  provider.setTurnFactory(record => {
    const promptText = findBuildPrompt(record.body)
    if (promptText === null) return null
    let firstSourceId: string | null = null
    let firstPath: string | null = null
    try {
      const prompt = JSON.parse(promptText.slice(promptText.indexOf('{'))) as {
        evidenceFragments?: Array<{ sourceId?: unknown; path?: unknown }>
      }
      const fragment = prompt.evidenceFragments?.[0]
      if (fragment && typeof fragment.sourceId === 'string') {
        firstSourceId = fragment.sourceId
        firstPath = typeof fragment.path === 'string' ? fragment.path : null
      }
    } catch {
      // 解析不到证据时输出无出处节点，仍能完成发布
    }
    info.sourceId = firstSourceId
    info.sourcePath = firstPath
    return { kind: 'text', text: createCompileOutput(firstSourceId) }
  })
}
