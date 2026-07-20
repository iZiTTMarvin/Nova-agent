/**
 * 缓存诊断状态跨回合持久化。
 *
 * AgentLoop 每个用户回合重建，诊断快照必须存在 loop 之外。
 * 以会话目录下的小 JSON 文件承载，每回合请求边界写入一次。
 * 只存哈希，不落明文。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { DiagnosticPersistState } from '../../../runtime/model/cacheDiagnostics'

const DIAGNOSTIC_FILE = 'cache-diagnostic.json'

/** 从会话目录读回诊断状态；文件不存在或损坏时返回 null */
export function loadDiagnosticState(sessionsDir: string, sessionId: string): DiagnosticPersistState | null {
  try {
    const filePath = path.join(sessionsDir, sessionId, DIAGNOSTIC_FILE)
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as DiagnosticPersistState
    if (!parsed.epochId || typeof parsed.lastCacheReadTokens !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/** 将诊断状态写入会话目录（同步写入，单个小 JSON，IO 可忽略） */
export function saveDiagnosticState(sessionsDir: string, sessionId: string, state: DiagnosticPersistState): void {
  try {
    const dir = path.join(sessionsDir, sessionId)
    if (!fs.existsSync(dir)) return
    const filePath = path.join(dir, DIAGNOSTIC_FILE)
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8')
  } catch {
    // 写入失败不阻断主流程
  }
}
