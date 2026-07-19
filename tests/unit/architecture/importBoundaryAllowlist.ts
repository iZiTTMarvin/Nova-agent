/**
 * 精确历史债务 allowlist。
 * 每项必须同时约束 from、to、rule；禁止目录通配。
 * 债务消除后必须同步删除对应条目（stale 也会失败）。
 *
 * reason 说明这条边为什么暂时存在、消债时应把什么迁到哪里。
 */

import type { AllowedBoundaryDebt } from './importBoundaryRules'

export const IMPORT_BOUNDARY_ALLOWLIST: AllowedBoundaryDebt[] = []
