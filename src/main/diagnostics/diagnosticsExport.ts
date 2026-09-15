/**
 * 诊断包导出：收集诊断素材（日志 / 系统信息 / 模型配置摘要 / 会话元数据），
 * 脱敏后打包为用户选定路径的 zip。
 *
 * 边界：配置摘要结构上不含 key，日志经 redactSecrets 兜底；
 * 会话只带元数据不带消息内容；renderer 无文件日志是一期已知盲区（README 注明）。
 */
import { app, dialog } from 'electron'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { platform, arch, release } from 'os'
import * as yazl from 'yazl'
import { createWriteStream } from 'fs'
import { getLaunchIdentity } from '../../shared/diagnostics/launchIdentity'
import { loadLlmRegistry } from '../../runtime/model/config'
import { getSessionStore } from '../services/SessionStoreHost'
import { redactSecrets, REDACTED } from './redact'

/** 收进包里的日志天数窗口 */
const LOG_WINDOW_DAYS = 7
/** 单个日志文件收进包里的字节上限；超出取尾部并注明 */
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024

export type DiagnosticsExportResult =
  | { status: 'saved'; filePath: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

function collectLogFiles(logsDir: string, now: Date): string[] {
  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    return []
  }
  const cutoff = now.getTime() - LOG_WINDOW_DAYS * 24 * 60 * 60 * 1000
  return entries
    .filter(name => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .filter(name => {
      const full = join(logsDir, name)
      try {
        return statSync(full).mtimeMs >= cutoff
      } catch {
        return false
      }
    })
    .sort()
}

/** 单日志控量：超上限保留尾部（最近的错误最有诊断价值），头部注明截断 */
function readLogTailBounded(filePath: string): string {
  const raw = readFileSync(filePath, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') <= MAX_LOG_FILE_BYTES) return redactSecrets(raw)
  const tail = raw.slice(-MAX_LOG_FILE_BYTES)
  return redactSecrets(`[日志超过 ${MAX_LOG_FILE_BYTES} 字节，仅保留尾部]\n${tail}`)
}

function buildSystemInfo(now: Date): string {
  return JSON.stringify(
    {
      exportedAt: now.toISOString(),
      launchIdentity: getLaunchIdentity(),
      os: { platform: platform(), arch: arch(), release: release() },
      electron: process.versions.electron,
      node: process.versions.node
    },
    null,
    2
  )
}

/** 模型配置摘要：provider 名/模型 ID/baseUrl，永不含 key */
function buildModelConfigSummary(): string {
  const registry = loadLlmRegistry(app.getPath('userData'))
  if (!registry) return JSON.stringify({ providers: [] }, null, 2)
  const providers = registry.providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    presetId: provider.presetId,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models.map(model => model.modelId)
  }))
  return JSON.stringify(
    { activeModel: registry.activeModel, fallbacks: registry.fallbacks ?? [], providers },
    null,
    2
  )
}

/** 会话元数据：id/标题/时间/消息数，不含消息内容 */
function buildSessionMetadata(): string {
  const store = getSessionStore()
  const summaries = store.list().map(session => ({
    id: session.id,
    kind: session.kind,
    title: session.title,
    workspaceRoot: session.workspaceRoot,
    mode: session.mode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount
  }))
  return JSON.stringify({ sessions: summaries }, null, 2)
}

function buildReadme(): string {
  return [
    'Nova Agent 诊断包',
    '==================',
    '',
    '内容清单：',
    '- system-info.json：系统与构建信息',
    '- model-config.json：模型配置摘要（不含 API Key）',
    '- sessions.json：会话元数据（不含消息内容）',
    '- logs/：最近 7 天主进程日志（已脱敏，单文件超 2MB 保留尾部）',
    '',
    `所有文本均经凭据脱敏管道处理（密钥模式替换为 ${REDACTED}）。`,
    '已知盲区：渲染进程没有文件日志，本包不包含 renderer 侧日志。'
  ].join('\n')
}

function writeZip(entries: Array<{ path: string; content: string }>, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile()
    const out = createWriteStream(zipPath)
    out.on('close', () => resolve())
    out.on('error', reject)
    zipfile.outputStream.on('error', reject)
    zipfile.outputStream.pipe(out)
    for (const entry of entries) {
      zipfile.addBuffer(Buffer.from(entry.content, 'utf8'), entry.path)
    }
    zipfile.end()
  })
}

/** 导出主入口：弹保存对话框 → 收集 → 脱敏 → 打包。用户取消对话框不是失败。 */
export async function exportDiagnostics(getParentWindow: () => Electron.BrowserWindow | null): Promise<DiagnosticsExportResult> {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const parent = getParentWindow()
  const saveOptions: Electron.SaveDialogOptions = {
    title: '导出诊断包',
    defaultPath: join(app.getPath('downloads'), `nova-diagnostics-${stamp}.zip`),
    filters: [{ name: '诊断包', extensions: ['zip'] }]
  }
  const picked = parent
    ? await dialog.showSaveDialog(parent, saveOptions)
    : await dialog.showSaveDialog(saveOptions)
  if (picked.canceled || !picked.filePath) return { status: 'cancelled' }

  try {
    const logsDir = join(app.getPath('userData'), 'logs')
    const entries: Array<{ path: string; content: string }> = [
      { path: 'README.txt', content: buildReadme() },
      { path: 'system-info.json', content: buildSystemInfo(now) },
      { path: 'model-config.json', content: buildModelConfigSummary() },
      { path: 'sessions.json', content: buildSessionMetadata() }
    ]
    for (const name of collectLogFiles(logsDir, now)) {
      entries.push({ path: `logs/${name}`, content: readLogTailBounded(join(logsDir, name)) })
    }
    await writeZip(entries, picked.filePath)
    return { status: 'saved', filePath: picked.filePath }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
