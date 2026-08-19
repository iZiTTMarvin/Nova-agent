/**
 * Code Mode SDK 绑定解析（§24 顺序：Mode Visibility → Availability → Nesting Filter）。
 * 只有同时满足「Catalog 标记 nestable-readonly」且「当前激活」的工具才进入 SDK；
 * 未激活的 deferred 工具不能通过 SDK 偷偷出现。输出按 Catalog 声明顺序稳定。
 */
import { listCatalogEntries } from '../tools/catalog'
import { isToolVisibleInMode } from '../../shared/session/toolVisibility'
import type { Mode } from '../../shared/session/types'

export function resolveCodeModeToolBindings(
  mode: Mode,
  activeToolNames: ReadonlySet<string>
): readonly string[] {
  const bindings: string[] = []
  for (const entry of listCatalogEntries()) {
    if (entry.codeMode !== 'nestable-readonly') continue
    if (!activeToolNames.has(entry.name)) continue
    if (!isToolVisibleInMode(mode, entry.name)) continue
    bindings.push(entry.name)
  }
  return bindings
}
