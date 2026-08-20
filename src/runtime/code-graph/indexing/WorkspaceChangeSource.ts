export type WorkspaceChange =
  | Readonly<{ type: 'add'; path: string }>
  | Readonly<{ type: 'change'; path: string }>
  | Readonly<{ type: 'unlink'; path: string }>

export type WorkspaceChangeListener = (change: WorkspaceChange) => void
export type WorkspaceChangeErrorListener = (error: Error) => void

export interface WorkspaceChangeSource {
  subscribe(listener: WorkspaceChangeListener): () => void
  subscribeError(listener: WorkspaceChangeErrorListener): () => void
  whenReady(): Promise<void>
  close(): Promise<void>
}
