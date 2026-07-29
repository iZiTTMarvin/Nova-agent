/** chat store 共享常量：steering 队列容量与消息窗口裁剪阈值。 */

/** 单个会话最多保留的挂起消息数。超过后丢弃最早入队的项。 */
export const MAX_PENDING_MESSAGES = 20

/** 消息数组超过此阈值触发裁剪 */
export const MESSAGE_WINDOW_MAX_SIZE = 240
/**
 * 尾部保护参数参与计算可裁剪的头部范围。当前阈值组合会裁掉超出 240 的部分，
 * 不会把窗口直接缩到 80 条；修改裁剪逻辑时必须保持这一语义。
 */
export const MESSAGE_WINDOW_TAIL_PRESERVE = 80
