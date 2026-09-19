/**
 * 紧凑时间戳格式化工具
 * 对标现代开发工具高密度列表（如 20m、3h、8d、51d）
 */

/**
 * 将时间戳格式化为紧凑相对时间
 * - < 1m: 刚刚
 * - < 60m: Nm (如 20m)
 * - < 24h: Nh (如 3h)
 * - >= 24h: Nd (如 8d, 51d)
 */
export function formatCompactRelativeTime(timestamp: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) {
    return '刚刚'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `${days}d`
}
