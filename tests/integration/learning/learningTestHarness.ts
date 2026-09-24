import { join } from 'path'
import { LearningDbWorkerClient } from '../../../src/runtime/learning/storage/LearningDbWorkerClient'
import { LearningProgressRepository } from '../../../src/runtime/learning/progress/LearningProgressRepository'
import { LearningProgress } from '../../../src/runtime/learning/progress/LearningProgress'
import { ProjectKnowledgeRepository } from '../../../src/runtime/learning/knowledge/ProjectKnowledgeRepository'
import { ProjectKnowledge } from '../../../src/runtime/learning/knowledge/ProjectKnowledgeRepository'

export const learningWorkerJs = join(process.cwd(), 'out', 'main', 'learningDbWorker.js')

export async function createLearningDbHarness(dbPath: string): Promise<{
  client: LearningDbWorkerClient
  progress: LearningProgress
  knowledge: ProjectKnowledge
  close: () => Promise<void>
}> {
  const client = new LearningDbWorkerClient(learningWorkerJs)
  await client.start()
  await client.open(dbPath)
  const progressRepo = new LearningProgressRepository(client)
  const knowledgeRepo = new ProjectKnowledgeRepository(client)
  return {
    client,
    progress: new LearningProgress(progressRepo),
    knowledge: new ProjectKnowledge(knowledgeRepo),
    close: async () => {
      await client.close()
    }
  }
}
