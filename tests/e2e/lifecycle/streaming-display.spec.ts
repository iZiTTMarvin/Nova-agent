import { expect, test } from '../fixtures/nova'

type Delta = Record<string, unknown>

function contentDelta(content: string): Delta {
  return {
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  }
}

function reasoningDelta(content: string): Delta {
  return {
    choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }]
  }
}

function finishDelta(): Delta {
  return {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  }
}

test('agile 及时展示已收到内容，并保持慢流、突发代码块和思考转正文的顺序', async ({ nova }, testInfo) => {
  const firstChunk = `${'首包内容'.repeat(35)}AGILE_FIRST_CHUNK_TAIL`
  nova.provider.enqueue({
    kind: 'raw',
    events: [
      { payload: contentDelta(firstChunk) },
      { payload: finishDelta(), delayMs: 1_000 }
    ]
  })

  await nova.sendPrompt('验证 agile 首包展示')
  await nova.provider.waitForRequestCount(1)
  const dispatchedAt = Date.now()
  await expect(
    nova.page.getByText('AGILE_FIRST_CHUNK_TAIL', { exact: false })
  ).toBeVisible({ timeout: 500 })
  const firstVisibleMs = Date.now() - dispatchedAt
  expect(firstVisibleMs).toBeLessThan(300)
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  await nova.waitUntilIdle()

  const slowText = 'SLOW_STREAM_ORDER_OK'
  nova.provider.enqueue({
    kind: 'text',
    text: slowText,
    chunks: [...slowText],
    chunkDelayMs: 20
  })
  await nova.sendPrompt('验证慢速逐字内容')
  await expect(nova.page.getByText(slowText, { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const codeLines = Array.from({ length: 80 }, (_, index) => `const value${index} = ${index}`).join('\n')
  const burst = `突发正文开始\n\n\`\`\`ts\n${codeLines}\n\`\`\`\nBURST_CODE_TAIL_OK`
  const frameProbe = nova.page.evaluate(() => new Promise<number[]>(resolve => {
    const samples: number[] = []
    let previous = performance.now()
    const sample = (now: number): void => {
      samples.push(now - previous)
      previous = now
      if (samples.length >= 60) {
        resolve(samples)
        return
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  nova.provider.enqueue({
    kind: 'raw',
    events: [
      { payload: contentDelta(burst) },
      { payload: finishDelta(), delayMs: 500 }
    ]
  })
  await nova.sendPrompt('验证突发长代码块')
  await expect(nova.page.getByText('BURST_CODE_TAIL_OK', { exact: false })).toBeVisible()
  await expect(nova.page.locator('.md-code-block')).toHaveCount(1)
  await nova.waitUntilIdle()
  const frameSamples = (await frameProbe).sort((left, right) => left - right)
  const p95FrameMs = frameSamples[Math.ceil(frameSamples.length * 0.95) - 1] ?? 0
  const maxFrameMs = frameSamples.at(-1) ?? 0
  expect(p95FrameMs).toBeLessThan(100)
  expect(maxFrameMs).toBeLessThan(250)

  nova.provider.enqueue({
    kind: 'raw',
    events: [
      { payload: reasoningDelta('先分析展示路径') },
      { payload: contentDelta('THINKING_TO_TEXT_OK'), delayMs: 80 },
      { payload: finishDelta() }
    ]
  })
  await nova.sendPrompt('验证思考转正文')
  await expect(nova.page.getByText('THINKING_TO_TEXT_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  await testInfo.attach('streaming-display-metrics.json', {
    body: Buffer.from(JSON.stringify({ firstVisibleMs, p95FrameMs, maxFrameMs }, null, 2)),
    contentType: 'application/json'
  })
  expect(nova.pageErrors).toEqual([])
})

test('窗口隐藏再恢复后正文完整且不重复', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'text',
    text: 'VISIBLE_BEFORE_HIDE_VISIBLE_AFTER_RESTORE',
    chunks: ['VISIBLE_BEFORE_HIDE_', 'VISIBLE_AFTER_RESTORE'],
    chunkDelayMs: 300
  })

  await nova.sendPrompt('验证隐藏恢复')
  await expect(nova.page.getByText('VISIBLE_BEFORE_HIDE_', { exact: false })).toBeVisible()
  await nova.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await nova.page.waitForTimeout(350)
  await nova.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect(
    nova.page.getByText('VISIBLE_BEFORE_HIDE_VISIBLE_AFTER_RESTORE', { exact: false })
  ).toHaveCount(1)
  await nova.waitUntilIdle()
  expect(nova.pageErrors).toEqual([])
})
