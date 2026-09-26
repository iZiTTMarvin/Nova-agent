import { join } from 'path'
import { mkdirSync } from 'fs'
import { app } from 'electron'
import { LearningDbWorkerClient } from '../../runtime/learning/storage/LearningDbWorkerClient'
import { LearningProgressRepository } from '../../runtime/learning/progress/LearningProgressRepository'
import {
  LearningProgress,
  getDefaultLearningProgress,
  setDefaultLearningProgress
} from '../../runtime/learning/progress/LearningProgress'
import { ProjectKnowledgeReader } from '../../runtime/learning/knowledge/ProjectKnowledgeReader'
import { ProjectKnowledge, ProjectKnowledgeRepository } from '../../runtime/learning/knowledge/ProjectKnowledgeRepository'
import { isLearningModuleAssembled } from '../agent/runtime/learningModuleGate'

let client: LearningDbWorkerClient | null = null
let reader: ProjectKnowledgeReader | null = null
let knowledge: ProjectKnowledge | null = null
let readyPromise: Promise<LearningProgress | null> | null = null

export function getLearningProgressOrNull(): LearningProgress | null {
  return getDefaultLearningProgress()
}

/** 教材只读投影与进度共用同一 Worker 连接；未启动时为 null。 */
export function getLearningKnowledgeReaderOrNull(): ProjectKnowledgeReader | null {
  return reader
}

export function getLearningKnowledgeOrNull(): ProjectKnowledge | null {
  return knowledge
}

export function learningDbWorkerPath(): string {
  return join(__dirname, 'learningDbWorker.js')
}

export async function ensureLearningDatabaseReady(): Promise<LearningProgress | null> {
  if (!isLearningModuleAssembled()) {
    return null
  }
  const existing = getDefaultLearningProgress()
  if (existing) {
    return existing
  }
  if (!readyPromise) {
    readyPromise = (async () => {
      const learningRoot = join(app.getPath('userData'), 'learning')
      mkdirSync(learningRoot, { recursive: true })
      const workerJs = learningDbWorkerPath()
      client = new LearningDbWorkerClient(workerJs, learningRoot)
      try {
        await client.start()
        await client.open(join(learningRoot, 'learning.db'))
      } catch (error) {
        await client.close()
        client = null
        throw error
      }
      const progress = new LearningProgress(new LearningProgressRepository(client))
      setDefaultLearningProgress(progress)
      reader = new ProjectKnowledgeReader(client)
      knowledge = new ProjectKnowledge(new ProjectKnowledgeRepository(client))
      return progress
    })().catch(error => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

export async function shutdownLearningDatabase(): Promise<void> {
  if (readyPromise) await readyPromise.catch(() => undefined)
  const active = client
  client = null
  setDefaultLearningProgress(null)
  reader = null
  knowledge = null
  readyPromise = null
  await active?.close()
}
