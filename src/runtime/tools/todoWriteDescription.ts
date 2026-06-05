/**
 * todo_write 工具描述（模型合同）
 *
 * 这段文本是模型行为的唯一规约，比代码本身更重要。逐字翻译自
 * kilocode packages/opencode/src/tool/todowrite.txt，结合 nova-agent 的中文语境裁剪。
 *
 * 关键设计：
 * - 首段明确"用途 + 价值"：复杂多步任务时把计划外化为稳定状态
 * - "应该用"列 7 条具体触发场景，覆盖多步任务 / 用户给列表 / 收到新指令 / 刚完成一步 / 开始新任务
 * - "不要用"列 4 条反例护栏（**不能省**）：防止模型把 todo 当成礼貌用语
 * - 给出 3-4 个完整示例（含 reasoning 解释）
 * - 状态机与维护规则：同时只一个 in_progress、完成后立刻标 completed
 *
 * 中文化 reason：nova 的工具描述目前是中文（参 bashTool.ts），模型用中文系统提示；
 * 中文化的描述能让模型更好理解约束。保留英文示例是为了让 reasoning 段更"原汁原味"。
 */

export const TODO_WRITE_DESCRIPTION = `创建一个结构化的待办列表，用于追踪当前会话的进度。

把"计划"作为显式状态写进会话里，能避免多步任务中遗忘细节、重复检查、即兴发挥。

## 何时应该使用

满足以下任一情况时，主动调用本工具（每次都传**完整**最新列表）：

1. 复杂多步任务：需要 3 步或更多不同操作
2. 非平凡任务：需要仔细规划或多个相关操作
3. 用户明确要求使用 todo list（例如"先把计划写下来"）
4. 用户给了一组任务（编号列表或逗号分隔的多项）
5. 收到新指令：立刻把新要求落进 todo
6. 刚完成一步：把它标 completed，并补上后续步骤
7. 开始新任务时：把对应 todo 标 in_progress（同一时刻**只能有一个** in_progress）

## 何时不要使用

以下情况**不要**调用本工具，避免无意义的开销和噪音：

1. 只有一个简单直接的任务
2. 任务琐碎到跟踪它没有组织价值
3. 任务能在少于 3 个无关紧要的步骤内完成
4. 任务本质是纯问答或信息查询

> 注意：如果只有一件小事要做，**直接做就行**，不要为它建 todo。

## 示例：什么时候该用

<example>
User: 我想在应用设置里加一个暗色模式切换。完成后跑一下测试和构建！
Assistant: 好，我来加暗色模式切换。先建个 todo 跟踪进度。
*Creates todo list:*
1. 在 Settings 页面创建暗色模式切换组件
2. 添加暗色模式状态管理（context/store）
3. 实现 CSS-in-JS 暗色主题样式
4. 更新现有组件支持主题切换
5. 跑测试和构建，修复发现的问题
*开始处理第一项*

<reasoning>
1. 加暗色模式是个多步功能，需要 UI / 状态管理 / 样式
2. 用户明确要求跑测试和构建
3. 把"跑测试和构建"放进 todo 最后一项，保证不漏
</reasoning>
</example>

<example>
User: 帮我把项目里的 getCwd 全部改名成 getCurrentWorkingDirectory
Assistant: 先搜一下项目里有哪些地方用了 getCwd。
*用 grep / search 工具定位所有出现位置*
Assistant: 一共 15 处，分布在 8 个文件里。我建个 todo 按文件逐个改。
*Creates todo list:*
1. 改 src/utils/path.ts
2. 改 src/services/process.ts
3. 改 src/commands/clone.ts
... (按文件逐条列)

<reasoning>
1. 先搜确定范围，避免漏改
2. 多文件多调用点 → 必须有 todo 跟踪进度
3. 按文件拆分 → 每条都具体可执行
</reasoning>
</example>

<example>
User: 我要做用户注册、商品目录、购物车、结算流程这一组功能
Assistant: 我先把这一组功能拆成 todo，然后再开始。
*Creates todo list breaking down the work*

<reasoning>
用户一次给了 4 个独立功能，拆成 todo 才能逐个推进不漏。
</reasoning>
</example>

## 示例：什么时候不要用

<example>
User: 怎么用 Python 打印 Hello World？
Assistant: 用 print：

\`\`\`python
print("Hello World")
\`\`\`

<reasoning>
这是一次性、单步、信息性回答，不需要建 todo。
</reasoning>
</example>

<example>
User: 帮我给 calculateTotal 函数加一行注释
Assistant: 好，加注释。
* 直接调用 edit 工具加注释 *

<reasoning>
只有一处单行编辑，跟踪它没有组织价值。
</reasoning>
</example>

## 状态机与维护规则

1. **状态值**：pending（未开始） / in_progress（正在做） / completed（完成） / cancelled（不再需要）
2. **同一时刻只能有一个 in_progress**。开始新任务时先标下一个为 in_progress
3. **完成一步立刻标 completed**，不要攒到最后一起标
4. **不再需要的步骤标 cancelled**（用户改主意 / 路径切换 / 任务整体取消时）
5. **状态变化必须再次调用本工具，传完整最新列表**——这是唯一维护入口
6. **每条 content 都要具体可执行**："修复登录 bug"比"修一下代码"好；"在 auth.ts 加 input 校验"比"完善校验"好
7. **不要写太长的列表**：超过 8 条说明拆分粒度太细，合并相邻步骤
`
