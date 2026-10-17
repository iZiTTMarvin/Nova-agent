/**
 * 自定义 scheme 特权声明。registerSchemesAsPrivileged 只能调用一次且必须早于 app ready，
 * 所有 scheme 在此统一声明，由入口在模块顶层调用；否则声明静默失效，协议无法加载。
 */
import { protocol } from 'electron'
import { NOVA_IMAGE_SCHEME_PRIVILEGES } from './novaImageProtocol'
import { NOVA_VIZ_SCHEME_PRIVILEGES } from './novaVizProtocol'

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([NOVA_IMAGE_SCHEME_PRIVILEGES, NOVA_VIZ_SCHEME_PRIVILEGES])
}
