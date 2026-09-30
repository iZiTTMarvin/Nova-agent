/**
 * 学习投递文本：把一条 outbox 交付意图确定性地拆成「用户看到的一句话」和「发给模型的指令」。
 * displayText 落盘、显示并作为会话标题来源；modelInput 只进入本轮请求与投递事实。
 */
import { parseLearningAction, type LearningAction } from '../../shared/learning/command'

export interface LearningDeliveryText {
  readonly displayText: string
  readonly modelInput: string
}

/** 投递时需要查询的主进程上下文；由宿主注入，便于脱离 Electron 测试。 */
export interface LearningDeliveryPorts {
  /** 当前已发布大纲中主题的标题；取不到时返回 null。 */
  readonly loadTopicTitle: (nodeId: string) => Promise<string | null>
  /** 校验并读取开发会话里的一次改动；来源不合法时返回失败原因。 */
  readonly loadDevChange: (devSessionId: string, devMessageId: string) => LearningDevChangeResult
}

export type LearningDevChangeResult =
  | {
      readonly ok: true
      readonly sessionTitle: string | null
      readonly files: readonly string[]
      readonly excerpt: string
    }
  | { readonly ok: false; readonly message: string }

const FALLBACK_TOPIC_DISPLAY = '开始学习新主题'

async function describeAction(
  action: LearningAction,
  ports: LearningDeliveryPorts
): Promise<LearningDeliveryText> {
  switch (action.type) {
    case 'message':
      return { displayText: action.text, modelInput: action.text }
    case 'answer':
      return { displayText: action.text, modelInput: `[学习回答]\n${action.text}` }
    case 'select_node': {
      const title = (await ports.loadTopicTitle(action.nodeId).catch(() => null))?.trim()
      return {
        displayText: title ? `开始学习「${title}」` : FALLBACK_TOPIC_DISPLAY,
        modelInput: `[学习选点] 用户想学${title ? `「${title}」` : '一个新主题'}。先读 learning_context 拿到这个主题的内容，再开讲。`
      }
    }
    case 'hint':
      return {
        displayText: '给点提示',
        modelInput: '[学习提示] 用户想要提示。读 learning_context 里的当前问题，给一个能往前推一步的小提示；不说答案，不换题。'
      }
    case 'explain':
      return {
        displayText: '直接讲讲吧',
        modelInput: '[学习讲解] 用户想直接听讲解。读 learning_context 里的当前问题，把答案和原因讲清楚并给出代码位置；这次不算用户自己答出来的。'
      }
    case 'skip':
      return {
        displayText: '先跳过这题',
        modelInput: '[学习跳过] 用户跳过了当前问题。读 learning_context，用两三句收住这个机制，再建议下一步学什么。'
      }
    case 'resume':
      return {
        displayText: '再评估一次我的回答',
        modelInput: '[继续学习] 读 learning_context，完成还没提交的评估；没有待评估的回答就继续当前主题。'
      }
    case 'explain_change': {
      const change = ports.loadDevChange(action.devSessionId, action.devMessageId)
      if (!change.ok) throw new Error(change.message)
      const title = change.sessionTitle?.trim()
      return {
        displayText: title ? `帮我搞懂「${title}」里的这次改动` : '帮我搞懂这次改动',
        modelInput: [
          '[学习改动] 用户想搞懂开发会话里这次改动背后的机制和设计考虑。',
          '先说它解决了什么实际问题，再讲数据和控制怎么流转、为什么这样取舍；不要复述测试或验证过程。先读当前代码核对，再给出关键代码位置。',
          change.files.length > 0 ? `改动文件:\n${change.files.map(file => `- ${file}`).join('\n')}` : '改动文件: 无',
          '开发回复摘录（只用于定位，可能已过时）:',
          change.excerpt || '（无）'
        ].join('\n')
      }
    }
    case 'dispute': {
      const reason = action.reason.trim()
      return {
        displayText: reason ? `我不同意这次判断：${reason}` : '我觉得我答对了，请再看看',
        modelInput: [
          `[学习复核] 用户不同意最新一次评估。理由：${reason || '未说明'}`,
          '读 learning_context 里的原回答、原评估和判据，先说明判断依据，再提交新的评估。'
        ].join('\n')
      }
    }
  }
}

/** 解析 outbox payload；payload 由学习 worker 写入，格式不对时 fail closed。 */
export async function resolveLearningDelivery(
  payloadJson: string,
  ports: LearningDeliveryPorts
): Promise<LearningDeliveryText> {
  const payload = JSON.parse(payloadJson) as { kind?: unknown; text?: unknown; action?: unknown }
  if (payload.kind === 'deliver_command') {
    return describeAction(parseLearningAction(payload.action), ports)
  }
  if (payload.kind === 'deliver_answer' && typeof payload.text === 'string') {
    return { displayText: payload.text, modelInput: `[学习回答]\n${payload.text}` }
  }
  throw new Error('学习交付意图无效')
}
