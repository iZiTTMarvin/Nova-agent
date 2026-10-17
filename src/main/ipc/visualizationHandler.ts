/**
 * 可视化导出：把快照装配为可独立打开的 HTML 文件。
 * 参数一律视为不可信：地址与主题在此校验，内容只从快照存储读取，不接受渲染层传入的 HTML。
 */
import { dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { handle } from './secureIpc'
import { VISUALIZATION_EXPORT } from '../../shared/ipc/channels'
import {
  parseVisualizationTheme,
  parseVisualizationUri,
  type VisualizationAddress,
  type VisualizationTheme
} from '../../shared/visualization'
import {
  buildExportedVisualizationDocument,
  type VisualizationSnapshotReader
} from '../../runtime/visualizations/visualizationDocument'

const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g
const MAX_FILE_NAME_CHARS = 80

const SNAPSHOT_FAILURE = {
  missing: '可视化快照不存在',
  corrupt: '可视化快照已损坏'
} as const

export function registerVisualizationHandler(getReader: () => VisualizationSnapshotReader): void {
  handle(VISUALIZATION_EXPORT, async (_event, params: unknown) => {
    const request = parseExportRequest(params)
    if (!request) {
      throw new Error('visualization:export 参数不合法')
    }
    try {
      const snapshot = await getReader().read(request.address)
      if (snapshot.status !== 'ok') {
        return { status: 'failed' as const, error: SNAPSHOT_FAILURE[snapshot.status] }
      }
      const picked = await dialog.showSaveDialog({
        title: '导出可视化',
        defaultPath: `${toFileName(request.title)}.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }]
      })
      if (picked.canceled || !picked.filePath) return { status: 'cancelled' as const }
      await writeFile(picked.filePath, buildExportedVisualizationDocument(snapshot.html, request.theme), 'utf8')
      return { status: 'saved' as const, filePath: picked.filePath }
    } catch (err) {
      return { status: 'failed' as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function parseExportRequest(
  params: unknown
): { address: VisualizationAddress; title: string; theme: VisualizationTheme } | null {
  if (typeof params !== 'object' || params === null) return null
  const { uri, title, theme } = params as Record<string, unknown>
  const address = typeof uri === 'string' ? parseVisualizationUri(uri) : null
  const parsedTheme = parseVisualizationTheme(theme)
  if (!address || !parsedTheme || typeof title !== 'string') return null
  return { address, title, theme: parsedTheme }
}

function toFileName(title: string): string {
  const name = Array.from(title.replace(ILLEGAL_FILE_NAME_CHARS, '_').trim())
    .slice(0, MAX_FILE_NAME_CHARS)
    .join('')
    .replace(/[. ]+$/, '')
  return name || 'visualization'
}
