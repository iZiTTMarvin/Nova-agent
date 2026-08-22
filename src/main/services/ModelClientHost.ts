import type { ModelClient } from '../../runtime/model/ModelClient'

let modelClient: ModelClient | null = null

export function getModelClient(): ModelClient | null {
  return modelClient
}

export function setModelClient(client: ModelClient | null): void {
  modelClient = client
}
