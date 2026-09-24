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

export const ASK_QUESTION_DESCRIPTION = `Ask the user when you need their explicit choice, preference, or extra information to move the task forward. Unlike a plain text follow-up, this tool supports multiple options, single/multi-select switching, recommended-option marking, and custom input. Use it when the user must decide among several predefined options, or when you need them to supply additional information.

## questions structure

Pass a questions array; each question object contains:

- question (required): the question text
- header (optional): a small label / context above the question
- options (required): the option list; each option contains:
  - label (required): the option's display text
  - description (optional): the option's description
  - recommended (optional): whether this option is recommended; the UI marks it "(Recommended)"
- multiple (optional): whether multiple selection is allowed; when omitted, false = single select
- custom (optional): whether the user may type a custom answer; when true the UI shows a "Type your own answer" input; defaults to true

## Answer format

The tool returns a formatted string:

User has answered your questions: "question1"="optionA, optionB"; "question2"="custom content".

When the user clicks "Dismiss all" / Dismiss, it returns:

User dismissed the question.

## Example

<example>
User: I want to add a dark mode to this project
Assistant: A few preferences need to be pinned down:
*Calls askQuestion with questions:*
[{"question": "Which dark theme do you want to use?", "options": [{"label": "Dark gray background + light text", "recommended": true}, {"label": "Pure black background + high-contrast text"}]}, {"question": "How should images be handled in dark mode?", "options": [{"label": "Auto reduce saturation"}, {"label": "Keep as-is"}], "multiple": true}]
*The user picks "Dark gray background" and "reduce saturation"*
User has answered your questions: "Which dark theme do you want to use?"="Dark gray background + light text"; "How should images be handled in dark mode?"="Auto reduce saturation".
*Implements dark mode according to the user's preferences*
</example>

## When to use

1. The user must choose among several predefined options
2. You need the user's preferences or settings
3. The user must decide between several approaches
4. You need the user to confirm or supply extra information

## When not to use

1. Simple yes/no confirmation → use the permission_request mechanism
2. Information you can infer from code/files → infer it directly; don't ask
3. The user has already expressed their choice → don't ask again
4. Plan approval or "should implementation start / how to proceed" decisions → after save_plan, immediately call switch_mode(default) and let the plan-review interaction handle approval, revision, or ignoring; this does not apply when the user explicitly asks you to ask about revising content (e.g. "please ask me which parts I want adjusted")`