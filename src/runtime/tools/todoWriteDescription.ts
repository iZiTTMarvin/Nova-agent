/**
 * todo_write 工具描述（模型合同）
 *
 * 这段文本是模型行为的唯一规约。结构沿用 kilocode
 * packages/opencode/src/tool/todowrite.txt，按 nova-agent 语境裁剪。
 *
 * 关键设计：
 * - 首段明确"用途 + 价值"：复杂多步任务时把计划外化为稳定状态
 * - "应该用"列 7 条具体触发场景，覆盖多步任务 / 用户给列表 / 收到新指令 / 刚完成一步 / 开始新任务
 * - "不要用"列 4 条反例护栏（**不能省**）：防止模型把 todo 当成礼貌用语
 * - 给出 3-4 个完整示例（含 reasoning 解释）
 * - 状态机与维护规则：同时只一个 in_progress、完成后立刻标 completed
 */

export const TODO_WRITE_DESCRIPTION = `Create a structured todo list to track progress in the current session.

Externalizing the plan as explicit session state avoids forgotten details, repeated checks, and improvisation in multi-step tasks.

## When to use

Proactively call this tool (passing the **complete** latest list every time) when any of the following applies:

1. Complex multi-step tasks: 3 or more distinct operations are needed
2. Non-trivial tasks: careful planning or several related operations are needed
3. The user explicitly asks for a todo list (e.g. "write the plan down first")
4. The user gives a set of tasks (a numbered list or comma-separated multiple items)
5. A new instruction arrives: capture the new requirement in a todo immediately
6. You just finished a step: mark it completed and add the follow-up steps
7. Starting a new task: mark the corresponding todo in_progress (only **one** in_progress at a time)

## When not to use

Do **not** call this tool in the following cases, to avoid pointless overhead and noise:

1. There is only one simple, direct task
2. The task is too trivial for tracking to add organizational value
3. The task can be finished in fewer than 3 inconsequential steps
4. The task is inherently pure Q&A or an information lookup

> Note: when there is only one small thing to do, **just do it** — do not create a todo for it.

## Examples: when to use

<example>
User: I want to add a dark mode toggle in the app settings. When it's done, run the tests and the build!
Assistant: Sure, I'll add the dark mode toggle. Let me set up a todo to track progress.
*Creates todo list:*
1. Create the dark mode toggle component in the Settings page
2. Add dark mode state management (context/store)
3. Implement CSS-in-JS dark theme styles
4. Update existing components to support theme switching
5. Run tests and build, fixing whatever turns up
*Starts on the first item*

<reasoning>
1. Dark mode is a multi-step feature spanning UI / state management / styles
2. The user explicitly asked to run tests and the build
3. Putting "run tests and build" as the last todo ensures it is not forgotten
</reasoning>
</example>

<example>
User: Help me rename all getCwd occurrences in the project to getCurrentWorkingDirectory
Assistant: Let me first search the project for everywhere getCwd is used.
*Uses the grep / search tools to locate all occurrences*
Assistant: 15 places across 8 files. I'll create a todo list and fix them file by file.
*Creates todo list:*
1. Fix src/utils/path.ts
2. Fix src/services/process.ts
3. Fix src/commands/clone.ts
... (listed one entry per file)

<reasoning>
1. Search first to pin down the scope, so nothing gets missed
2. Many files and many call sites → todos are needed to track progress
3. Splitting per file → every entry is concrete and executable
</reasoning>
</example>

<example>
User: I want this set of features: user registration, product catalog, shopping cart, checkout flow
Assistant: I'll break this feature set into todos first, then start.
*Creates todo list breaking down the work*

<reasoning>
The user gave 4 independent features at once; breaking them into todos lets each be finished without omission.
</reasoning>
</example>

## Examples: when not to use

<example>
User: How do I print Hello World in Python?
Assistant: Use print:

\`\`\`python
print("Hello World")
\`\`\`

<reasoning>
This is a one-off, single-step, informational answer; no todo needed.
</reasoning>
</example>

<example>
User: Add a one-line comment to the calculateTotal function
Assistant: Sure, adding the comment.
* Calls the edit tool directly to add the comment *

<reasoning>
A single one-line edit; tracking it adds no organizational value.
</reasoning>
</example>

## State machine and maintenance rules

1. **Status values**: pending (not started) / in_progress (in progress) / completed (done) / cancelled (no longer needed)
2. **Only one in_progress at a time**. When starting a new task, first mark the next one in_progress
3. **Mark completed the moment a step finishes** — do not batch the marks at the end
4. **Mark cancelled** for steps that are no longer needed (the user changed their mind / the path switched / the task was cancelled overall)
5. **Any status change must call this tool again with the complete latest list** — this is the only maintenance entry point
6. **Every content entry must be concrete and executable**: "fix the login bug" beats "fix some code"; "add input validation in auth.ts" beats "improve validation"
7. **Do not write overly long lists**: more than 8 entries means the granularity is too fine — merge adjacent steps
8. **Start a fresh list for a new task**: when the user starts a task unrelated to the current list, replace the whole thing with a brand-new list — completed/cancelled entries from the previous task do **not** carry over; keep unfinished entries and append new steps only when continuing the same task. The list is the current task's working set, not session history — history lives in the conversation itself
`
