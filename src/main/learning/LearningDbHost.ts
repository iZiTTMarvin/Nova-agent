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
import { setConfiguredUserLearningRoot } from '../../runtime/learning/storage/dbPathPolicy'
import { isLearningModuleAssembled } from '../agent/runtime/learningModuleGate'

let client: LearningDbWorkerClient | null = null
let readyPromise: Promise<LearningProgress | null> | null = null

export function getLearningProgressOrNull(): LearningProgress | null {
  return getDefaultLearningProgress()
}

export function learningDbWorkerPath(): string {
  return join(__dirname, '..', 'learningDbWorker.js')
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
      setConfiguredUserLearningRoot(learningRoot)
      const workerJs = learningDbWorkerPath()
      client = new LearningDbWorkerClient(workerJs)
      await client.start()
      await client.open(join(learningRoot, 'learning.db'))
      const progress = new LearningProgress(new LearningProgressRepository(client))
      setDefaultLearningProgress(progress)
      return progress
    })().catch(error => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

export async function shutdownLearningDatabaseForTests(): Promise<void> {
  if (client) {
    await client.close()
    client = null
  }
  setDefaultLearningProgress(null)
  readyPromise = null
}
