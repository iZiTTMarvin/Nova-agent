import type { KnowledgeEdgeKind } from '../../../shared/learning/knowledgeProjection'
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
    edges?: readonly {
      fromNodeId: string
      toNodeId: string
      edgeKind: KnowledgeEdgeKind
    }[]
    sourceReceipts?: readonly {
      receiptId: string
      filePath: string
      startLine: number
      endLine: number
      contentHash: string
      snippetHash: string
      symbolLabel: string | null
      strategyVersion: string
      collectedAt: number
    }[]
    nodeSources?: readonly {
      nodeId: string
      nodeRevision: string
      receiptId: string
    }[]
  }): Promise<{ knowledgeRevision: string }> {
    const command: LearningDbWorkerOp = {
      domain: 'knowledge',
      op: 'publish_version',
      ...params,
      edges: params.edges ?? [],
      sourceReceipts: params.sourceReceipts ?? [],
      nodeSources: params.nodeSources ?? []
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
