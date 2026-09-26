import { expect, test } from '../fixtures/nova'
import type { NovaHarness } from '../fixtures/nova'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * 学习表面视觉留证：双主题 × 四类桌面窗口尺寸。
 * §12.3 验证 compact 1024×768、normal 1200×800、wide 1600×1000，并含最小窗口 900×650。
 * 键盘导航与最终视觉判断为人工项，本 spec 只沉淀截图证据，不做自动通过结论。
 */
const VIEWPORTS = [
  { name: 'min-900x650', width: 900, height: 650 },
  { name: 'compact-1024x768', width: 1024, height: 768 },
  { name: 'normal-1200x800', width: 1200, height: 800 },
  { name: 'wide-1600x1000', width: 1600, height: 1000 }
] as const

const THEMES = ['dark', 'light'] as const

const CHECKPOINT_QUESTION = '刷新之后这条记录还在，主要依靠哪一段？'

async function prepareLearningSurface(nova: NovaHarness): Promise<void> {
  const state = await nova.createSession('learn')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('learn session id missing')
  await expect(nova.page.locator('.learning-surface')).toBeVisible()

  nova.provider.enqueue({
    kind: 'tool',
    name: 'learning_checkpoint',
    arguments: {
      question: CHECKPOINT_QUESTION,
      cursorVersion: 1,
      checkpointId: 'ckpt-visual',
      rubric: {
        targetClaim: '指出刷新后数据的来源',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: '能说明刷新后数据从哪读取'
      }
    },
    callId: 'call_ckpt_visual'
  })

  const input = nova.page.getByLabel('学习提问输入')
  await input.fill('数据保存后刷新为什么还在？')
  await nova.page.getByRole('button', { name: '发送学习问题' }).click()
  await expect(nova.page.locator('.learning-checkpoint')).toContainText(CHECKPOINT_QUESTION)
}

test('视觉留证：学习表面双主题与四类窗口尺寸截图', async ({ nova }) => {
  test.setTimeout(180_000)
  await prepareLearningSurface(nova)

  const outputDir = path.resolve(
    __dirname,
    '../../../test-results/e2e/learning-visuals'
  )
  await mkdir(outputDir, { recursive: true })

  const manifest: string[] = []
  for (const theme of THEMES) {
    await nova.invoke('settings:set', { theme })
    await nova.page.reload()
    await expect(nova.page.locator('.learning-surface')).toBeVisible()
    await expect(nova.page.locator('.learning-checkpoint')).toContainText(CHECKPOINT_QUESTION)
    await expect(nova.page.locator('html')).toHaveAttribute('data-theme', theme)

    for (const viewport of VIEWPORTS) {
      await nova.page.setViewportSize({ width: viewport.width, height: viewport.height })
      // 等布局稳定后再截图
      await nova.page.waitForTimeout(300)
      const file = path.join(outputDir, `learning-${theme}-${viewport.name}.png`)
      await nova.page.screenshot({ path: file })
      manifest.push(`learning-${theme}-${viewport.name}.png`)
    }
  }

  await nova.invoke('settings:set', { theme: 'dark' })
  // eslint-disable-next-line no-console
  console.log(`learning visuals saved: ${manifest.join(', ')}`)
  expect(manifest).toHaveLength(THEMES.length * VIEWPORTS.length)
})
