import type { LearningDbWorkerClient } from '../storage/LearningDbWorkerClient'
import type { LearningDbWorkerOp } from '../storage/workerCommand'

export class ProjectKnowledgeRepository {
  constructor(private readonly client: LearningDbWorkerClient) {}

  publishVersion(params: {
    workspaceRoot: string
    knowledgeRevision: string
    parentRevision: string | null
    inputFingerprint: string
    expectedCurrentRevision: string | null
    nodes: readonly {
      nodeId: string
      nodeRevision: string
      title: string
      bodyJson: string
    }[]
    members: readonly { nodeId: string; nodeRevision: string }[]
  }): Promise<{ knowledgeRevision: string }> {
    const command: LearningDbWorkerOp = {
      domain: 'knowledge',
      op: 'publish_version',
      ...params
    }
    return this.client.invoke(command)
  }
}

export class ProjectKnowledge {
  constructor(private readonly repo: ProjectKnowledgeRepository) {}

  publishVersion(
    params: Parameters<ProjectKnowledgeRepository['publishVersion']>[0]
  ): Promise<{ knowledgeRevision: string }> {
    return this.repo.publishVersion(params)
  }
}
