# XForge 上线审查报告

> **审查日期**：2026-07-16
> **审查基线**：工作区未提交改动（基于 `a564028`，含 GPT 最后一轮「阶段与工具权限解耦」修复）
> **对照真源**：`XForge实施方案.md`（M0–M4 已声明完成）
> **验证结果**：`npm run typecheck` 通过；XForge 定向测试 15 个文件、136 个用例全部通过

---

## 一、核心结论

**链路是真的，质量门禁是真的，但「新手一句话」这个产品目标还差最后一公里。**

分三句话说：

1. **能不能跑**：能。从「切到 XForge 模式 → 输一句话 → 自动选阶段 → 探索/计划/Scope/实施/测试/审查/报告全自动推进」的完整链路已真实接通，无断点、无假实现，测试覆盖扎实。质量门禁（真实命令 exitCode、隔离只读 Review、预算上限、写入保护）全部是 Runtime 强制，模型自报绕不过去。
2. **能不能上线**：**不建议现在直接放给新手用户**。有 1 个 P0：起点识别是纯正则、没有模型兜底，中文口语稍一变化就漏判——最危险的是「不要动代码，帮我看看」这类约束漏判后，XForge 会以 auto 权限直接开始写代码，违背用户明确意图。这对信任是毁灭性的。
3. **体验够不够好**：骨架好、叙事弱。进度面板信息齐全（阶段/预算/门禁/暂停原因都有），但运行过程中**消息区几乎静默**（阶段产出的 JSON 刻意不外显，非 thinking 模型下用户只能看到工具调用），没有阶段时间线，收尾只给 4 行摘要 + 一个报告文件路径。用户「感觉不到 XForge 的独特存在」，这个判断成立。

---

## 二、链路走查：一句话之后真实发生了什么

新手用户视角实测路径（代码级确认，非文档推断）：

```
ModeSwitch 选「XForge」(mode='compose')                ModeSwitch.tsx:37-41
  ↓ 输入框输入一句话，回车
SEND_MESSAGE → agentHandler                            agentHandler.ts:339
  ↓ 同 workspace 已有未结束 XForge → 拒绝（保护 ✅）    agentHandler.ts:399-406
  ↓ 同会话有 waiting_user run → 本条消息作为回答恢复 ✅  agentHandler.ts:348-353, 902-909
AgentLoop 检测 compose + passthrough → xforgeRunner    AgentLoop.ts:806-837
  ↓
runXForgeLiveRuntime                                   liveRuntime.ts:115
  ├─ classifyXForgeRequest（⚠️ 纯正则）                 liveRuntime.ts:734-755
  ├─ resolveStartStage（门禁夹紧，纯函数 ✅）            stageResolver.ts:168
  ├─ StageExecutor：brainstorm/plan/scope/implement    stageExecutor.ts
  ├─ DeliveryExecutor：test/review/fix/report          deliveryExecutor.ts
  └─ 每次阶段转移原子落盘 → run:snapshot 推 UI ✅        RunStore.ts:74-99
```

已确认的关键正确性（这些不用再担心）：

| 项 | 结论 | 证据 |
|---|---|---|
| 状态机与方案 §4.2 一致 | ✅ | `stageController.ts:22-33`，终态冻结正确 |
| 预算（Scope 2 / Test-Fix 3 / Review-Fix 2 / 任务 3 次） | ✅ 耗尽正确进 waiting_user | `stageController.ts:159-250`，`stageExecutor.ts` |
| Test Gate 只认 Runtime exitCode，模型自报无效 | ✅ | `deliveryExecutor.ts:249-251`；命令白名单 + 危险命令拒绝 `:543-562` |
| Review 子代理真隔离只读 | ✅ | `liveRuntime.ts:685-695`（plan 模式 + 无工具 + deepFreeze snapshot）；敏感文件/符号链接越界/文件数上限均拦截 `deliveryRuntime.ts:178-204, 304-310` |
| askQuestion 由 Runtime 掌管，三轮上限、决策去重、暂存 | ✅ | `stageExecutor.ts:241-294` |
| 写入安全：Checkpoint + Fingerprint + EffectReceipt | ✅ 冲突正确 waiting_user | `writeSafety.ts:17-60`，`stageExecutor.ts:415-437` |
| 全阶段禁 commit/push/reset/clean/deploy/publish | ✅ | `liveRuntime.ts:584-591` |
| 取消矩阵：parked 直接终态、运行中 abort 句柄 | ✅ 有测试 | `agentHandler.ts:1011+`，`agentHandler.xforgeParking.test.ts` |
| /br-full-dev 与自然语言同一控制器 | ✅ | `AgentLoop.ts:806-812`（explicitFullDev → brainstorm 起点） |
| 真实异常原子写入 failed，不再泛化 | ✅ | `liveRuntime.ts:485-496` |

### 已排除的疑似问题（审查中出现过、经复核为误报）

- ~~「同 workspace 单 run 限制未实现」~~ → 已实现于 `agentHandler.ts:399-406`。
- ~~「XForgeProgressView 未导出导致面板不渲染」~~ → 同文件内使用（`ComposeProgressPanel.tsx:176-178`），无需导出。
- ~~「Review snapshot 符号链接可绕过」~~ → 链接目标已做工作区边界校验（`deliveryRuntime.ts:199-204`）。
- ~~「Scope plan↔scope 循环风险」~~ → 2 轮预算后强制 waiting_user，正是方案定稿行为。

---

## 三、问题清单（按严重度）

### P0 — 上线前必须解决

**P0-1 起点识别没有模型兜底，纯正则漏判会直接违背用户意图**

- 位置：`liveRuntime.ts:734-755`（`classifyXForgeRequest`）
- 现状：方案 §5.1 写明「至多一次模型语义补充；失败 → 保守 brainstorm」，但实现里 `modelSemanticHint` 是**由正则伪造的**（`vague ? 'brainstorm' : 'plan'`），从未调用过模型。
- 为什么致命（举实测反例）：
  - 「**不要动代码**，帮我看看哪里有问题」→ reviewOnly 正则只认「只/仅…审查」「不要**改**代码」，「不要**动**代码」漏判 → 进 plan → implement，**以 auto 权限直接写代码**。用户明确说了别改，XForge 却改了。
  - 「这个页面加载好**卡**」→ 不含「修复/bug/报错」关键词 → 不走修复路径。
  - 「你觉得现在的架构怎么样？」→ 非开发请求 → 被强行生成一份实施计划。
- 中文口语的表达空间靠正则不可能穷举。这是「新手一句话自动选对流程」的**核心能力**，也是 XForge 与默认模式拉开差距的第一印象，不能是碰运气。

### P1 — 严重影响体验（上线窗口内应完成）

**P1-1 运行过程中消息区近乎静默，「XForge 的独特存在感」不成立**

- 位置：`liveRuntime.ts:644-668`（事件转发白名单）
- 现状：主 Agent 的 `text_delta` 刻意不转发（因为阶段输出是 JSON 契约，直接外显会很难看——这个取舍本身是对的），只转发 thinking/工具事件。后果：在 brainstorm 总结、plan 生成、scope 审查这类**纯生成阶段**，非 thinking 模型下消息区完全没有输出，用户只看到面板上阶段名变了。
- 用户要求的「实时感觉到 XForge 独特存在」恰恰要在这里解决，而不是靠面板加花哨动画。

**P1-2 进度面板功能齐全但缺「阶段时间线」，且与 compose 面板样式不统一**

- 位置：`ComposeProgressPanel.tsx:573-630`
- 对照方案 §7 要求逐项核对：runId ✅ / 当前阶段 ✅ / 已完成已跳过 ✅ / 任务 unverified ✅ / 门禁 verdict ✅ / 预算 ✅ / waiting 原因 + Resume Target ✅（文案质量好）/ 侧栏 parked 徽标 ✅ / Review Only ✅ / **证据过期与 Workspace Drift 的安全阻塞展示 ❌**（后端 `runState.ts` 已有 `unverified` 字段，UI 未消费）。
- 阶段进度用两行文字「已完成：…；已跳过：…」表达，没有一眼可读的时间线；`XForgeProgressView` 没有包 `compose-dock` 容器、不支持折叠，与旧 compose 面板视觉行为不一致；暗色模式下部分硬编码色值对比度不足。

**P1-3 收尾体验弱：完成后只有 4 行摘要 + 报告文件路径**

- 位置：`liveRuntime.ts:966-982`（`renderLiveSummary`）
- 报告事实层（测试命令与 exitCode、完成/未验证/跳过任务、技术债、预算消耗）已经完整落盘（`deliveryExecutor.ts:564-592`），但用户在聊天里看不到内容，要自己去开 `.nova/compose/<runId>/report/` 文件。「用户真实感觉到 XForge 任务完成质量高」的最后一步展示缺失。

**P1-4 计划阶段不主动探测验证命令，Test Gate 容易安全暂停打扰新手**

- 位置：`liveRuntime.ts:188`（runPlan 指令）+ `deliveryExecutor.ts:213-216`
- 「无必需命令 → 安全暂停」是方案定稿行为（对，不该改）。但 runPlan 的指令只说「不能猜测仓库全量命令」，没有引导模型**在 plan 阶段用工具读 package.json / CI 配置，把真实存在的安全验证命令明确写进 verificationChecklist**。结果是模型偏保守 → checklist 为空 → 实施完成后卡在 Test Gate 问用户要命令——新手根本不知道该回答什么。
- 这不是放松门禁，而是让计划阶段把「明确的命令」真正生产出来。

**P1-5 应用重启后 waiting_user 的 run 变成 interrupted，无法恢复**

- 位置：`RunCoordinatorHost.ts:55`（`reconcileOnStartup` 全部标 interrupted）+ `agentHandler.ts:348-353`（恢复只认 `waiting_user | resuming`）
- 方案 §4.9 承诺「重启应用可凭 runId 恢复」。现实场景：XForge 提问后用户下班，第二天开机——run 已 interrupted，只能重新发起，探索轮次和已收集决策全部作废（虽然 XForge 状态其实完整持久化在 snapshot 里，恢复的原料都在）。
- 好消息是 interrupted 计入广义终态，**不会**死锁新 run（`types.ts:44-47`）；坏消息是白白丢进度。

**P1-6 非开发输入没有出口**

- XForge 模式下任何一句话都进 pipeline。新手切到 XForge 后顺口问「这个函数是干嘛的」，会得到一份莫名其妙的实施计划。方案 §9 禁止「静默变 default 闲聊」，但「显式一句引导 + 不启动 run」并不违背该条款。

### P2 — 上线后清理/打磨

- **P2-1 双轨残留**：`composeRouter.ts`（quick/plan/full 三档旧路由）+ `AgentLoop.ts:839-873` 降级分支。生产宿主 `agentHandler` 每次都注入 xforgeRunner，这段是**死代码**（自注释「仅供未注入原生 XForge runner 的旧宿主」）。按「不缝缝补补」原则应删除，删除前确认无其它宿主依赖 `workflowRunner` 的 compose 自动路由。
- **P2-2 侧栏「等待你处理」徽标只有停止按钮**，无「去恢复」引导（点会话进去后面板有说明，尚可接受）。
- **P2-3 第二个 XForge 被拒的报错**不提示是哪个会话在占用（`agentHandler.ts:404`）。
- **P2-4 interrupted 的 xforge 面板仍显示旧业务阶段 + 停止按钮**，与实际不可继续的状态有歧义。
- **P2-5 命名双轨**：产品名 XForge，代码/IPC/mode id 全是 compose。可接受（改动面大、收益低），但建议在 `types.ts` 的 Mode 定义处补一行注释说明映射关系。

---

## 四、最优改进方案（不缝补、不冗余）

设计原则：每一项都落在**已有的架构位**上，不新建平行机制；P0/P1 全部做完后，产品即达到「新手一句话可信任交付」的标准。

### 方案 A（P0-1 + P1-6 一并根治）：Resolver 补上「一次模型语义分类」

方案文档本来就是这么设计的（§5.1 第 5 条），补齐即可，不是新发明：

1. 在 `liveRuntime.ts` 的 resolve 阶段，先跑现有正则提取**确定性信号**（引用 .md 路径、用户口头指定起点等保留正则，这些是精确匹配）。
2. 对**语义类信号**（reviewOnly / isBugfix / codeReadyForTest / isVague / **isNonDevRequest**）改为一次结构化模型短调用：复用已有的 `session.runJson`（JSON 校验 + 一次修复轮机制现成），prompt 要求只返回布尔分类。这正是方案「Resolver 最多一次短调用」的额度。
3. 模型调用失败/超时 → 降级回当前正则结果，且语义不明时保守 `brainstorm`（把现在 `modelSemanticHint` 默认 `'plan'` 的伪造值改掉）。
4. 新增 `isNonDevRequest` 一档：resolve 直接产出一句引导语作为 summary、run 正常终态，不进 pipeline。文案示例：「XForge 面向开发任务的完整流程。这个问题更适合在默认模式下问我；如果你想把它变成一个开发需求，再说一句就行。」
5. `reviewOnly` 类约束由模型判定后，仍走现有 `resolveStartStage` 的优先级夹紧，Runtime 门禁一行不动。

改动集中在 `classifyXForgeRequest` 一个函数 + 一个新 prompt，正则测试改为「确定性信号」测试，另补分类降级测试。

### 方案 B（P1-1 + P1-2 + P1-3）：让 XForge 在消息流和面板上「被看见」

三个点共用一个干净的机制，不加新状态源（RunCoordinator 仍是唯一权威）：

1. **阶段叙事进消息流**：在 `hostBase.activateStage`（`liveRuntime.ts:133-139`）里向 `parentEventBus` 发一条轻量文本（如 `▶ Scope Check（第 1/2 轮）`）。阶段完成时由各 host 回调追加一行结果摘要（如 `✔ Scope Check 通过，无 HIGH`）。这样即使模型无 thinking 输出，消息区也有连续的流程叙事——这就是「独特存在感」的主体，成本几乎为零。
2. **面板加阶段时间线**：`XForgeProgressView` 顶部渲染 7 节点 stepper（探索→计划→Scope→实施→测试→审查→报告），数据全部来自现有 snapshot（`completedStages/skippedStages/currentStage`），当前节点微脉冲动画；跳过节点置灰虚线。同时把 `XForgeProgressView` 包进 `compose-dock`、支持与旧面板一致的折叠，硬编码色值换 CSS 变量修暗色模式。**不加进度百分比条**——阶段数是固定小集合，stepper 本身就是进度条，再加一条是冗余。
3. **收尾把报告端进聊天**：`renderLiveSummary` completed 分支扩为读取 reportFacts 渲染完整 Markdown 小结（测试命令+结果、任务三态清单、技术债、预算消耗、未执行 commit/push 声明、报告路径）。数据都在 `state.reportFacts`，纯展示改动。
4. 顺手消费 `evidenceRefs[].unverified` / drift 信息，在面板 waiting 区块以「安全阻塞」样式显示（P1-2 的 ❌ 项）。

### 方案 C（P1-4）：计划阶段生产真实验证命令

`liveRuntime.ts:188` runPlan 指令追加一句：「生成计划前，用只读工具确认仓库真实存在的安全验证命令（如 package.json scripts 中的 test/typecheck/lint），把确认过的命令原样写入 verificationChecklist；确认不了的不要编造。」Test Gate 白名单与安全暂停语义**一律不动**。这让「安全暂停」从常态变成真正的例外。

### 方案 D（P1-5）：interrupted XForge 可凭已持久化状态恢复

`agentHandler.ts:348-353` 的 `resumableXForge` 条件扩展到 `kind === 'xforge' && status === 'interrupted'`；恢复走既有 `interrupted → resuming → running` 转换（`types.ts:283-284` 已定义），XForge 业务状态从 snapshot 原样恢复，`liveRuntime.ts:767-774` 的 `resumeStartStage` 已经会从持久化的 currentStage 续跑。全链路原料都在，只differ一个状态判断。恢复时消息流提示「已从中断处恢复（阶段 X）」。

### 方案 E（P2-1）：删双轨

确认 `agentHandler` 是唯一生产宿主后，删除 `AgentLoop.ts:839-873` 的 composeRouter 降级分支与 `composeRouter.ts`，相关测试同步删除。这是「XForge 只有一条决策链」的收口动作。

### 实施顺序与验证

```
A（P0，含非开发出口）→ B（存在感三件套）→ C（计划命令）→ D（重启恢复）→ E（删双轨）
每步：npm run typecheck → 定向 vitest → 全量 npm test；B 需人工冒烟暗色/折叠/长文本
最后：npm run build + 真实项目一句话冒烟（模糊需求 / 明确需求 / 「不要动代码」/ 闲聊四条路径）
```

---

## 五、上线判定

| 维度 | 判定 |
|---|---|
| 核心链路真实性 | ✅ 通过，无假实现 |
| 质量门禁可信度 | ✅ 通过，Runtime 强制、模型绕不过 |
| 工程质量 | ✅ 通过（typecheck + 136 定向用例绿；有 P2 级双轨待清理） |
| 「一句话自动选流程」 | ❌ **P0-1 未达标**：正则漏判会违背用户明确约束 |
| 「体验优于默认模式」 | ⚠️ 骨架达标、叙事缺失（P1-1/2/3） |
| 「独特的实时存在感」 | ⚠️ 有面板但弱，方案 B 后达标 |

**结论：完成方案 A 后可灰度上线（默认模式仍为 default，XForge 需手动切换本身就是天然灰度）；A+B 完成后才建议把 XForge 作为卖点主推。** C/D/E 可在灰度期间并行完成。

---

## 附：本次审查方法

- 3 路并行深度审查（runtime 状态机与门禁 / 入口链路与主进程接线 / UI 展示层），全部结论经主审逐条代码复核，4 项误报已剔除（见第二节）。
- 本地实测：`npm run typecheck` 通过；`npx vitest run tests/unit/runtime/workflow/xforge tests/unit/runtime/run/RunCoordinator.xforge.test.ts tests/unit/runtime/agent/AgentLoop.xforge.test.ts tests/unit/main/agentHandler.xforgeParking.test.ts` → 15 文件 136 用例全绿。
- 未执行：`npm run build` 全量与 NSIS 安装态冒烟（GPT 上一轮已声明通过，本轮未重复）。
