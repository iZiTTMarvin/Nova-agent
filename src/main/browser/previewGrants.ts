/**
 * 已确认预览 origin 的唯一记录。确认地址不写授权；页面创建后才激活。
 * 授权按页面隔离，关闭页面不终止进程；
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
  /**
   * Nova 自身界面占用的 origin（开发模式下的渲染服务）。
   * 同端口的任何 loopback 写法都拒绝：Windows 上 127.0.0.1 与 :: 可同时监听同一端口而不报错，
   * 项目服务"启动成功"后，访问仍可能落到 Nova 自己的界面上。
   */
  readonly reservedOrigins?: readonly string[]
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
  activate(browserId: string, grant: PreviewGrant): void
  release(browserId: string): void
  grantedOrigins(browserId: string, workspaceKey: string, sessionId: string): readonly string[]
  inspect(): readonly PreviewGrant[]
}

export function createPreviewGrantStore(
  query: PreviewProcessQuery,
  deps: PreviewGrantStoreDeps = {}
): PreviewGrantStore {
  const grants = new Map<string, Map<string, PreviewGrant>>()
  const reservedLoopbackPorts = new Map<string, string>()
  for (const origin of deps.reservedOrigins ?? []) {
    const reserved = canonicalizePreviewTarget(origin)
    if (reserved?.addressClass === 'loopback') reservedLoopbackPorts.set(reserved.port, reserved.origin)
  }

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
    const reservedOrigin = addressClass === 'loopback' ? reservedLoopbackPorts.get(canonical.port) : undefined
    if (reservedOrigin !== undefined) {
      return {
        ok: false,
        code: 'invalid_request',
        detail: `本机端口 ${canonical.port} 被 Nova 自身界面服务（${reservedOrigin}）占用，打开的不会是项目页面。` +
          '同端口再启动的服务可能不报错却收不到请求；请让项目服务换一个未被占用的端口，确认启动成功后再打开'
      }
    }
    const processRef = query.findRunning(input.sessionId, canonical.origin)
    const grant: PreviewGrant = {
      origin: canonical.origin,
      workspaceKey: input.workspaceKey,
      sessionId: input.sessionId,
      processRef,
      addressClass
    }
    return { ok: true, restricted: true, grant }
  }

  return {
    confirm,
    activate(browserId, grant) {
      const pageGrants = grants.get(browserId) ?? new Map<string, PreviewGrant>()
      pageGrants.set(grant.origin, grant)
      grants.set(browserId, pageGrants)
    },
    release(browserId) {
      grants.delete(browserId)
    },
    grantedOrigins(browserId, workspaceKey, sessionId) {
      const origins: string[] = []
      for (const grant of grants.get(browserId)?.values() ?? []) {
        if (grant.workspaceKey === workspaceKey && grant.sessionId === sessionId) {
          origins.push(grant.origin)
        }
      }
      return origins
    },
    inspect() {
      return [...grants.values()].flatMap((pageGrants) => [...pageGrants.values()])
    }
  }
}
