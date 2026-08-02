import type { Session } from '../../../shared/session/types'

export interface SessionTreeNode {
  session: Session
  children: SessionTreeNode[]
}

export interface FlattenedSessionNode {
  session: Session
  depth: number
}

/** lineage 是唯一父子来源；损坏的孤儿/cycle 会退化为根节点，避免会话从 UI 消失。 */
export function buildSessionForest(sessions: Session[]): SessionTreeNode[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const childrenByParent = new Map<string, Session[]>()
  const roots: Session[] = []

  for (const session of sessions) {
    if (
      session.kind === 'subagent' &&
      session.subagent.lineage.parentSessionId !== session.id &&
      byId.has(session.subagent.lineage.parentSessionId)
    ) {
      const children = childrenByParent.get(session.subagent.lineage.parentSessionId) ?? []
      children.push(session)
      childrenByParent.set(session.subagent.lineage.parentSessionId, children)
    } else {
      roots.push(session)
    }
  }

  const rendered = new Set<string>()
  const build = (session: Session, ancestry: ReadonlySet<string>): SessionTreeNode => {
    rendered.add(session.id)
    const nextAncestry = new Set(ancestry)
    nextAncestry.add(session.id)
    const children = (childrenByParent.get(session.id) ?? [])
      .filter((child) => !nextAncestry.has(child.id) && !rendered.has(child.id))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((child) => build(child, nextAncestry))
    return { session, children }
  }

  const forest = roots.map((session) => build(session, new Set()))
  for (const session of sessions) {
    if (!rendered.has(session.id)) {
      forest.push(build(session, new Set()))
    }
  }
  return forest
}

export function flattenSessionForest(nodes: SessionTreeNode[]): FlattenedSessionNode[] {
  const result: FlattenedSessionNode[] = []
  const visit = (node: SessionTreeNode, depth: number): void => {
    result.push({ session: node.session, depth })
    node.children.forEach((child) => visit(child, depth + 1))
  }
  nodes.forEach((node) => visit(node, 0))
  return result
}

export function sessionTreeContains(node: SessionTreeNode, sessionId: string | null): boolean {
  if (!sessionId) return false
  return node.session.id === sessionId || node.children.some((child) => sessionTreeContains(child, sessionId))
}
