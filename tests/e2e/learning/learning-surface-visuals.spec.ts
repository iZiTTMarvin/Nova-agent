import { expect, test } from '../fixtures/nova'
import type { NovaHarness } from '../fixtures/nova'
import type { Locator } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  CHECKPOINT_QUESTION,
  checkpointToolTurn,
  createLearnSession,
  installOutlineBuildSuccess,
  learningDock,
  learningEmptyHeading,
  openOutlinePane,
  outlinePane,
  outlineTopicRow,
  sendLearningPrompt,
  waitLearnTurnSettled,
  writeSampleCode,
  type OutlineBuildInfo
} from './learningFlow'

/**
 * 学习界面视觉留证：双主题 × 四类桌面窗口尺寸 × 四个场景。
 * 只沉淀截图证据交人工判断观感，不对视觉质量下自动结论；
 * 常规回归用 `--grep-invert 视觉留证` 跳过本用例。
 */
const VIEWPORTS = [
  { name: 'min-900x650', width: 900, height: 650 },
  { name: 'compact-1024x768', width: 1024, height: 768 },
  { name: 'normal-1200x800', width: 1200, height: 800 },
  { name: 'wide-1600x1000', width: 1600, height: 1000 }
] as const

const THEMES = ['dark', 'light'] as const

const TOPIC_TITLE = '应用如何启动'

/** 主区场景（空状态、出题）收起右侧面板，让阅读柱占满宽度。 */
async function collapseInspector(nova: NovaHarness): Promise<void> {
  const tab = nova.page.getByRole('tab', { name: '大纲' })
  if (!(await tab.isVisible().catch(() => false))) return
  await nova.page.getByRole('button', { name: '关闭面板' }).click()
  await expect(outlinePane(nova)).toBeHidden()
  await expect(tab).toBeHidden()
}

async function capture(
  nova: NovaHarness,
  outputDir: string,
  manifest: string[],
  name: string
): Promise<void> {
  const file = path.join(outputDir, `${name}.png`)
  await nova.page.screenshot({ path: file, animations: 'disabled' })
  manifest.push(`${name}.png`)
}

test('视觉留证：学习界面双主题四尺寸四场景截图', async ({ nova }, testInfo) => {
  test.setTimeout(420_000)
  await writeSampleCode(nova.workspacePath)

  // 空状态会话：只建会话不发消息；大纲生成后它会多出一条「从某主题开始」的建议
  const emptySessionId = await createLearnSession(nova)

  // 出题会话：先落一个待答停点，再生成一份真实大纲
  const questionSessionId = await createLearnSession(nova)
  nova.provider.enqueue(checkpointToolTurn('call_ckpt_visuals'))
  await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
  await waitLearnTurnSettled(nova, questionSessionId)
  await expect(learningDock(nova)).toContainText(CHECKPOINT_QUESTION)

  const pane = await openOutlinePane(nova)
  const buildInfo: OutlineBuildInfo = { sourceId: null, sourcePath: null }
  installOutlineBuildSuccess(nova.provider, buildInfo)
  await pane.getByRole('button', { name: '生成大纲' }).click()
  await expect(outlineTopicRow(pane, TOPIC_TITLE)).toBeVisible({ timeout: 60_000 })

  // 详情场景要连出处片段一起留证，片段按钮名从取证结果推出来
  const fileName = buildInfo.sourcePath?.split(/[\\/]/).pop() ?? null
  const sourceChipName = fileName ? new RegExp(`^${fileName.replace(/\./g, '\\.')}:\\d+$`) : null

  const outputDir = path.resolve(__dirname, '../../../test-results/e2e/learning-visuals')
  await mkdir(outputDir, { recursive: true })
  const manifest: string[] = []

  for (const theme of THEMES) {
    // 主题只由 renderer store 拥有，测试直接写主进程设置，需要重载才生效
    await nova.invoke('settings:set', { theme })
    await nova.page.reload()
    await expect(nova.page.locator('html')).toHaveAttribute('data-theme', theme)

    for (const viewport of VIEWPORTS) {
      await nova.page.setViewportSize({ width: viewport.width, height: viewport.height })
      const prefix = `learning-${theme}-${viewport.name}`

      await nova.selectSession(emptySessionId)
      await expect(learningEmptyHeading(nova)).toBeVisible()
      await collapseInspector(nova)
      await capture(nova, outputDir, manifest, `${prefix}-empty`)

      await nova.selectSession(questionSessionId)
      await expect(learningDock(nova)).toContainText(CHECKPOINT_QUESTION)
      await capture(nova, outputDir, manifest, `${prefix}-question`)

      const scenePane: Locator = await openOutlinePane(nova)
      await expect(outlineTopicRow(scenePane, TOPIC_TITLE)).toBeVisible()
      await expect(scenePane.getByRole('button', { name: '大纲操作' })).toBeInViewport({ ratio: 1 })
      await capture(nova, outputDir, manifest, `${prefix}-outline`)

      // 详情是组件内局部状态，重载后需要重新进入
      await outlineTopicRow(scenePane, TOPIC_TITLE).click()
      await expect(scenePane.getByRole('button', { name: '返回大纲' })).toBeVisible()
      await expect(scenePane.getByText('说清启动顺序')).toBeVisible()
      await expect(scenePane.getByRole('button', { name: '主题操作' })).toBeInViewport({ ratio: 1 })
      if (sourceChipName) {
        const chip = scenePane.getByRole('button', { name: sourceChipName })
        if (await chip.isVisible().catch(() => false)) {
          await chip.click()
          await expect(scenePane.getByRole('region', { name: '代码片段' })).toBeVisible()
        }
      }
      await capture(nova, outputDir, manifest, `${prefix}-detail`)
    }
  }

  for (const name of manifest) {
    await testInfo.attach(name, { path: path.join(outputDir, name), contentType: 'image/png' })
  }
  expect(manifest).toHaveLength(THEMES.length * VIEWPORTS.length * 4)
  expect(nova.pageErrors).toEqual([])
})
