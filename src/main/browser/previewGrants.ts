/**
 * 已确认预览 origin 的唯一记录。
 * 键是工作区 + 会话 + 确切 origin。关闭页面不终止进程；
 * 外部服务器只连接，Nova 启动的进程仍由 processRegistry 按原归属回收。
 */
import {
  canonicalizePreviewTarget,
  previewHostnameNeedsResolution,
  resolvePreviewAddressClass,
  type PreviewAddressClass
} from '../../shared/browser'

export interface PreviewGrant {
  readonly origin: string
  readonly workspaceKey: string
  readonly sessionId: string
  /** null 表示外部服务器，本模块没有终止权。 */
  readonly processRef: string | null
  readonly addressClass: Extract<PreviewAddressClass, 'loopback' | 'private'>
}

export interface PreviewProcessQuery {
  /**
   * 只读。找不到唯一归属时返回 null。
   * 实现不得终止进程，也不得为了腾端口去结束其它进程。
   */
  findRunning(sessionId: string, origin: string): string | null
}

/** 域名地址解析；返回 null 表示失败或超时，由本模块明确拒绝打开。 */
export type PreviewHostLookup = (hostname: string) => Promise<readonly string[] | null>

export interface PreviewGrantStoreDeps {
  readonly resolveHost?: PreviewHostLookup
}

export interface PreviewGrantStore {
  confirm(input: {
    readonly workspaceKey: string
    readonly sessionId: string
    readonly url: string
  }): Promise<
    | { readonly ok: true; readonly restricted: false }
    | { readonly ok: true; readonly restricted: true; readonly grant: PreviewGrant }
    | { readonly ok: false; readonly code: 'invalid_request'; readonly detail: string }
  >
  grantedOrigins(workspaceKey: string, sessionId: string): readonly string[]
  inspect(): readonly PreviewGrant[]
}

export function createPreviewGrantStore(
  query: PreviewProcessQuery,
  deps: PreviewGrantStoreDeps = {}
): PreviewGrantStore {
  const grants = new Map<string, PreviewGrant>()

  async function confirm(input: {
    readonly workspaceKey: string
    readonly sessionId: string
    readonly url: string
  }): Promise<Awaited<ReturnType<PreviewGrantStore['confirm']>>> {
    const canonical = canonicalizePreviewTarget(input.url)
    if (!canonical || (canonical.protocol !== 'http:' && canonical.protocol !== 'https:')) {
      return { ok: false, code: 'invalid_request', detail: '只允许不含用户信息的 http 或 https 地址' }
    }
    let addressClass = canonical.addressClass
    if (deps.resolveHost && previewHostnameNeedsResolution(canonical.hostname)) {
      const addresses = await deps.resolveHost(canonical.hostname)
      if (addresses === null || addresses.length === 0) {
        return { ok: false, code: 'invalid_request', detail: '无法确认该域名指向的地址，已拒绝打开' }
      }
      addressClass = resolvePreviewAddressClass(addresses)
    }
    if (addressClass === 'metadata') {
      return { ok: false, code: 'invalid_request', detail: '云元数据地址不能作为预览' }
    }
    if (addressClass === 'public') {
      return { ok: true, restricted: false }
    }
    const processRef = query.findRunning(input.sessionId, canonical.origin)
    const grant: PreviewGrant = {
      origin: canonical.origin,
      workspaceKey: input.workspaceKey,
      sessionId: input.sessionId,
      processRef,
      addressClass
    }
    grants.set(grantKey(grant.workspaceKey, grant.sessionId, grant.origin), grant)
    return { ok: true, restricted: true, grant }
  }

  return {
    confirm,
    grantedOrigins(workspaceKey, sessionId) {
      const origins: string[] = []
      for (const grant of grants.values()) {
        if (grant.workspaceKey === workspaceKey && grant.sessionId === sessionId) {
          origins.push(grant.origin)
        }
      }
      return origins
    },
    inspect() {
      return [...grants.values()]
    }
  }
}

function grantKey(workspaceKey: string, sessionId: string, origin: string): string {
  return `${workspaceKey}\n${sessionId}\n${origin}`
}
