import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, params: unknown) => Promise<unknown>>(),
  showSaveDialog: vi.fn()
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, handler: (event: unknown, params: unknown) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  }
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog }
}))

import { registerVisualizationHandler } from '../../../src/main/ipc/visualizationHandler'
import { VISUALIZATION_EXPORT } from '../../../src/shared/ipc/channels'
import type { VisualizationSnapshotRead } from '../../../src/runtime/visualizations/VisualizationStore'
import {
  buildVisualizationUri,
  VISUALIZATION_THEME_TOKENS,
  type VisualizationTheme
} from '../../../src/shared/visualization'

const URI = buildVisualizationUri({ sessionId: 's1', sha256: 'e'.repeat(64) })
const THEME: VisualizationTheme = {
  scheme: 'dark',
  tokens: Object.fromEntries(VISUALIZATION_THEME_TOKENS.map(name => [name, '#202020'])) as VisualizationTheme['tokens']
}

let outputDir: string
let snapshot: VisualizationSnapshotRead

function invoke(params: unknown): Promise<unknown> {
  return mocks.handlers.get(VISUALIZATION_EXPORT)!({}, params)
}

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), 'nova-viz-export-'))
  snapshot = { status: 'ok', html: '<!doctype html><p>导出内容</p>' }
  mocks.handlers.clear()
  mocks.showSaveDialog.mockReset()
  registerVisualizationHandler(() => ({ read: async () => snapshot }))
})

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true })
})

describe('visualization:export', () => {
  it('从快照存储装配离线文件，文件名取自清洗后的标题', async () => {
    const target = path.join(outputDir, 'out.html')
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })

    const result = await invoke({ uri: URI, title: 'A/B: 对比?* ', theme: THEME })

    expect(result).toEqual({ status: 'saved', filePath: target })
    expect(mocks.showSaveDialog.mock.calls[0][0].defaultPath).toBe('A_B_ 对比__.html')
    const written = await readFile(target, 'utf8')
    expect(written).toContain('<p>导出内容</p>')
    expect(written).toContain('http-equiv="Content-Security-Policy"')
    expect(written).toContain('"bg":"#202020"')
  })

  it('取消保存不写文件', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await invoke({ uri: URI, title: '图', theme: THEME })).toEqual({ status: 'cancelled' })
  })

  it('快照缺失时直接报告失败，不弹保存框', async () => {
    snapshot = { status: 'missing' }
    expect(await invoke({ uri: URI, title: '图', theme: THEME })).toEqual({ status: 'failed', error: '可视化快照不存在' })
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it.each([
    ['地址不是快照', { uri: 'file:///C:/secret.html', title: '图', theme: THEME }],
    ['主题含注入字符', { uri: URI, title: '图', theme: { ...THEME, tokens: { ...THEME.tokens, bg: 'red;}</style>' } } }],
    ['缺少标题', { uri: URI, theme: THEME }],
    ['参数不是对象', 'nova-viz://snapshot']
  ])('拒绝不合法参数：%s', async (_label, params) => {
    await expect(invoke(params)).rejects.toThrow('参数不合法')
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })
})
