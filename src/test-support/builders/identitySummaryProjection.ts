/**
 * 恒等摘要投影：单测默认装配——摘要输入与权威消息逐条一致，
 * 便于断言压缩服务自身的行为（切分、尾部、选项）。
 */
import type { SummaryProjection } from '../../runtime/request-projection'

export const identitySummaryProjection: SummaryProjection = {
  project: async messages => messages
}
