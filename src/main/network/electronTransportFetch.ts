/**
 * 主进程出网传输：走 Chromium 网络栈（electron.net）。
 *
 * Node 全局 fetch 直连且不读系统代理，在只允许经代理出网的网络里会在 TLS 握手前被重置，
 * 且只信任内置 CA。Chromium 栈与用户浏览器行为一致：遵循系统代理 / PAC、代理认证与操作系统证书库。
 * 模型请求不需要 Cookie 与 HTTP 缓存，显式关闭以免会话状态泄漏进第三方 API。
 */
import { net } from 'electron'
import type { TransportFetchImpl } from '../../runtime/model/types'

// net 只存在于 Electron 进程内；单元测试等纯 Node 环境退回全局 fetch，
// 使传输保持可替换、测试可 stub，生产主进程不受影响。
export const electronTransportFetch: TransportFetchImpl = (url, init) =>
  (net?.fetch ?? fetch)(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    credentials: 'omit',
    cache: 'no-store'
  })
