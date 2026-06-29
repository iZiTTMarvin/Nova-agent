/**
 * askQuestion 工具描述（模型合同）
 *
 * 这段文本是模型行为的唯一规约：明确工具用途、入参结构、返回格式与适用边界。
 * 内容严格对应 docs/askQuestion-落地方案.md §七，覆盖 questions 结构、答案格式、
 * 示例与"何时使用 / 何时不要使用"四节。
 *
 * 关键设计：
 * - 明确"多选项 / 单选多选切换 / 推荐项 / 自定义输入"四项能力，让模型按场景组织 questions
 * - 给出"已回答"和"用户跳过"两种返回形态，让模型提前知道 dismiss 后如何继续
 * - 反例护栏（permission_request / 已明确表达的选项 / 可推断的信息）防止滥用
 */

export const ASK_QUESTION_DESCRIPTION = `当需要用户的明确选择、偏好或额外信息来推进任务时，向用户提问。不同于简单的文本追问，本工具支持多选项、单选/多选切换、推荐项标记和自定义输入。适合需要用户在多个预定义选项中做决策，或需要用户补充额外信息的场景。

## questions 结构

传入 questions 数组，每个问题对象包含：

- question（必填）：问题正文
- header（可选）：问题上方的小标题/上下文
- options（必填）：选项列表，每个选项含：
  - label（必填）：选项显示文本
  - description（可选）：选项说明
  - recommended（可选）：是否为推荐项；UI 会标记 "(Recommended)"
- multiple（可选）：是否允许多选；不填为 false = 单选
- custom（可选）：是否允许用户自定义输入；true 时 UI 显示 "Type your own answer" 输入框；默认 true

## 答案格式

工具返回格式化的字符串：

User has answered your questions: "问题1"="选项A, 选项B"; "问题2"="自定义内容".

用户点击"跳过全部"/Dismiss 时返回：

User dismissed the question.

## 示例

<example>
User: 我想给这个项目加个暗色模式
Assistant: 需要确定几个偏好：
*Calls askQuestion with questions:*
[{"question": "你想使用哪种暗色主题？", "options": [{"label": "深灰背景 + 浅色文字", "recommended": true}, {"label": "纯黑背景 + 高对比度文字"}]}, {"question": "暗色模式下图片如何处理？", "options": [{"label": "自动降低饱和度"}, {"label": "保持原样"}], "multiple": true}]
*用户选择"深灰背景"和"降低饱和度"*
User has answered your questions: "你想使用哪种暗色主题？"="深灰背景 + 浅色文字"; "暗色模式下图片如何处理？"="自动降低饱和度".
*根据用户偏好实现暗色模式*
</example>

## 何时使用

1. 需要用户在多个预定义选项中做选择
2. 需要获取用户的偏好或设置项
3. 需要用户在几个方案中做决策
4. 需要用户确认或补充额外信息

## 何时不要使用

1. 简单的是/否确认 → 使用 permission_request 机制
2. 可以直接从代码/文件推断的信息 → 直接推断，不要问
3. 用户已经明确表达了选择 → 不要重复问`