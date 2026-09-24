import * as fs from 'fs'
import * as path from 'path'

export interface PersistedLearningCheckpoint {
  readonly checkpointId: string
  readonly sessionId: string
  readonly runId: string
  readonly cursorVersion: number
  readonly question: string
  readonly createdAt: number
}

export interface LearningCheckpointTurnStore {
  save(checkpoint: PersistedLearningCheckpoint): void
  getForSession(sessionId: string): PersistedLearningCheckpoint | null
}

export function createFileLearningCheckpointTurnStore(
  rootDir: string
): LearningCheckpointTurnStore {
  const filePath = path.join(rootDir, 'learning-checkpoints.json')

  const readAll = (): PersistedLearningCheckpoint[] => {
    if (!fs.existsSync(filePath)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
      return Array.isArray(parsed) ? (parsed as PersistedLearningCheckpoint[]) : []
    } catch {
      return []
    }
  }

  const writeAll = (items: PersistedLearningCheckpoint[]): void => {
    fs.mkdirSync(rootDir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf8')
  }

  return {
    save(checkpoint) {
      const items = readAll().filter(
        item => item.sessionId !== checkpoint.sessionId
      )
      items.push(checkpoint)
      writeAll(items)
    },
    getForSession(sessionId) {
      return readAll().find(item => item.sessionId === sessionId) ?? null
    }
  }
}

let defaultStore: LearningCheckpointTurnStore | null = null

export function getDefaultLearningCheckpointTurnStore(): LearningCheckpointTurnStore | null {
  return defaultStore
}

export function setDefaultLearningCheckpointTurnStore(
  store: LearningCheckpointTurnStore | null
): void {
  defaultStore = store
}
