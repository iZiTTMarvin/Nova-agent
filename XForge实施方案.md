# XForge 实施方案（定稿）

> **状态**：M0–M4 已实现；NSIS 安装态 npm Test Gate 冒烟已通过  
> **基线**：`a564028`（已回溯并丢弃错误的「动态 DAG 编排」与「护栏单 loop」实验）  
> **蓝本**：`D:\visual_ProgrammingSoftware\A_Projects\xdev-main\BuildRail`  
> **需求对照**：`.kiro/specs/xforge-implementation-plan-review/requirements.md`（验收级约束；若冲突以**本文件产品定稿**为准并回写 requirements）  
> **唯一产品定义**：见 §1。凡与本文件冲突的旧文档（任意 DAG / Capability 市场 / 「XForge=护栏聊天」）一律作废。

---

## 1. 产品定义（不可再漂）

### 1.1 一句话

> **XForge = BuildRail 工作流 + 自然语言阶段识别 + 单主 Agent 自动推进 + Runtime 状态与质量门禁。**

### 1.2 完整定义

XForge 是基于 BuildRail 开发生命周期设计的**单主 Agent 自动工作流**。

用户只需输入自然语言目标。XForge 会结合：

- 输入内容  
- 已有计划 / 设计文档  
- 工作区 diff  
- 测试状态  
- 用户明确限制（如「不要改代码」）

判断应从 **需求探索 / 计划 / 实现 / 测试 / 审查** 中的哪个阶段开始，并**自动向后**执行完整流程。

硬约束：

- 计划生成后必须经过 **Scope Check**（审的是**实施计划**，不是只扫设计文）  
- 实现后运行**真实测试**（Runtime 受控命令 + 真实 exitCode；模型自报不算过）  
- 最终由**隔离的只读 Review 子代理**审查实际改动  
- 测试或审查失败时，由**主 Agent**自动修复并重新测试、重新审查  
- 直到完成，或遇到真正无法自行解决的阻塞（`waiting_user` / `failed`）  
- **不自动** `git commit` / `push` / deploy；report 后可**可选询问**是否 ship  

### 1.3 与 BuildRail 的关系

| | BuildRail | XForge |
|---|---|---|
| 入口 | `/br-full-dev`、`/br-bugfix`、分步 `/idea → /br-plan → /run…` | 自然语言（隐藏斜杠选择） |
| 工作流 | Markdown 命令串联 Skill | 同一套生命周期，由 Runtime 阶段控制器推进 |
| 角色 | 工作流设计蓝本 | BuildRail 在 Nova 中的**原生执行形态** |

XForge **不是**重新发明另一套复杂架构，而是把 BuildRail **产品化、原生化、自动化**。

### 1.4 明确不是什么

| 不是 | 说明 |
|---|---|
| 通用 DAG / 动态任意工作流引擎 | 模型不得随意生成任意图 |
| Capability Marketplace | 不搞能力市场、不按元数据自由拼拓扑 |
| 「default + 护栏」换皮 | 护栏可做底层能力，但不是产品本体 |
| 每阶段一个长期 Agent | 只有一个主 Agent；Review 是唯一隔离子代理 |

### 1.5 动态性的准确含义

```text
识别当前起点
+
按情况跳过不需要的前置阶段
+
自动推进后续标准开发流程
```

这叫：**阶段自适应的顺序工作流**，不是通用工作流引擎。

### 1.6 刻意偏离 BuildRail 路径 A（写死，禁止缝回）

| 点 | BuildRail 路径 A | XForge 定稿 |
|---|---|---|
| Scope 第 2 轮仍 HIGH | 可记 tradeoff 继续实现 | **必须** `waiting_user`，禁止「带风险继续」 |
| 测试是否通过 | skill 叙事可能混入自报 | **仅** Runtime 受控命令的 exitCode / timeout |
| Scope 审查对象 | 偏设计文档 | **Validated 实施计划**（含任务与验证清单） |
| 实现 Agent | 常按 skill 另开会话 | **同一主 Agent 上下文链** |

---

## 2. 用户体验契约

### 2.1 完整生命周期

```text
需求探索（brainstorm / office-hours）
  ↓
方案/需求定稿
  ↓
生成实施计划（Validated Plan）
  ↓
Scope Check 对抗审查计划
  ↓
修正计划（必要时，≤2 轮）
  ↓
按任务实施代码（任务内可验收/修复）
  ↓
交付级真实测试与验证
  ↓
Review 子代理独立审查
  ↓
Blocking → 主 Agent 修复 → 测试 → 再审查
  ↓
汇报完成
  ↓
（可选）询问用户是否 ship / commit——默认不执行
```

### 2.2 不同输入如何进入

| 用户输入 | 起点 | 路径 |
|---|---|---|
| 需求模糊 | `brainstorm`（内部分流 office-hours / brainstorming，见 §3.3） | 探索 → Plan → Scope → Implement → Test → Review → Report |
| 仅有产品设计、实施计划不完整 | `plan` | 先补全 Validated Plan，再 Scope… |
| 已有 **Validated Plan**（见 §5.3）且尚无有效 Scope Pass | `scope_check` | 跳过探索；Scope → … |
| 已有 Validated Plan + 绑定当前版本的 Scope Pass | `implement` | 跳过探索/计划/scope |
| 明确 Bug（未声称已改完） | `plan`（修复计划路径） | 跳过产品探索问卷 → Scope → … |
| 代码已改好，请求测试/检查 | `test` | Test →（失败 Fix）→ Review → Report |
| 只审查、不要修改 | `review` + `reviewOnly=true` | Review → Report（禁止 Fix / 写入） |

### 2.3 何时打扰用户

- **探索澄清**：走 `br-office-hours` / `br-brainstorming` 需要向用户提问时，**必须**调用 `askQuestion`（禁止只在 assistant 正文里「假装提问」后自行继续）。  
- 全自动推进是默认（对齐 BuildRail 路径 A 的「开发阶段少打断」）。  
- Scope 修正预算耗尽、交付测试修复预算耗尽、Review 修复预算耗尽 → `waiting_user`。  
- 高影响未知且无法从仓库推断 → `waiting_user`。  
- 写入与用户既有改动冲突、恢复不安全 → `waiting_user`。  
- Report 之后：可弹出**一次**「是否记录后续 ship 交接」；回答只写入 `shipRequested`，不执行 commit、push、deploy 或 publish。  

---

## 3. Agent 模型

### 3.1 只要一个主 Agent

```text
一个主 Agent（Main Agent Session = 逻辑上下文链）
├── 探索：按 §3.3 加载 br-office-hours 或 br-brainstorming
├── 计划：加载 br-task-breakdown（产出 Validated Plan）
├── Scope：加载 br-scope-check（审实施计划）
├── 实现：主 Agent 按 Validated Plan 直接实施（不另开 br-implement Agent）
├── 测试：br-verify 只做清单/映射；命令执行与判定交给 Test Gate
├── 修复：加载 br-debug 方法（不得用自报替代 Test Gate）
└── Review：每轮新建隔离只读子代理 + br-review
```

说明：

- **逻辑连续性**不等于必须复用同一个 `AgentLoop` 对象；等待 / 压缩 / 重启后可从 RunCoordinator 恢复 Goal、计划版本、产物与证据。  
- **不**把 `br-inspect` / `br-implement` / `br-report` 当作阶段必绑 skill（implement/report 由主 Agent + Runtime 事实层完成）。  

### 3.2 Review 子代理

```text
Test Gate 对最新 Workspace Revision 通过
        ↓
新建只读 Review 子代理（禁止 shell/test/build/write/edit/network/task/invoke-skill）
        ↓
只消费 Runtime 预生成的 Review Input Snapshot
        ↓
返回结构化 Findings（含 severity / 位置 / 依据 / unverified）
        ↓
Blocking → 主 Agent fix → test → 再 review
Non-blocking → 记入报告技术债（见 §6.3）；不进入 fix 预算
```

`reviewOnly`：跳过 test（若无新鲜测试证据，依赖运行验证的结论标 `unverified`）；完成后直接 report；全程禁止工作区业务写入。

### 3.3 探索内路由（brainstorm 阶段）

在 `brainstorm` 阶段开始时，主 Agent / Runtime 按 BuildRail 规则二选一：

| 条件 | 方法 | 典型产物 |
|---|---|---|
| 全新项目或系统级大重构 | `br-office-hours` | `.nova/compose/idea/*-design.md` |
| 已有系统上新增/增强功能 | `br-brainstorming` | `.nova/compose/idea/*-requirement.md` |

- 路由结果须对用户可见一句说明，然后由主 Agent 基于 request、已有决策和当前方法生成 1–3 条具体 `askQuestion`。  
- 每轮回答都会持久化为用户决策；最多三轮。仍缺少关键约束时转 `waiting_user`，不得伪造设计产物或重复同一固定问题。用户可选择「暂存本轮 XForge」，保存已收集决策并从 `brainstorm` 恢复。  
- 信息足够后落盘设计/需求文档；XForge **不等待**用户「APPROVED」口头确认（路径 A），直接进入 `plan`。  

---

## 4. Runtime 架构

### 4.1 阶段枚举

```ts
type XForgeStage =
  | 'resolve'
  | 'brainstorm'
  | 'plan'
  | 'scope_check'
  | 'implement'
  | 'test'
  | 'review'
  | 'fix'
  | 'report'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

### 4.2 合法转换（摘要）

```text
resolve → brainstorm | plan | scope_check | implement | test | review
brainstorm → plan
plan → scope_check
scope_check → plan | implement | waiting_user
implement → test
test → fix | review | waiting_user
review → fix | report
fix → test | plan   # 扩大范围的修复须回 plan → scope_check
report → completed   # 可选 ship 交互不改变「未自动 commit」事实
任意非终态 → waiting_user | failed | cancelled
```

### 4.3 阶段控制器伪代码

```ts
while (!run.isTerminal()) {
  switch (run.currentStage) {
    case 'resolve':
      run.currentStage = await resolveStartStage(context)
      break

    case 'brainstorm':
      // 内部分流 office-hours / brainstorming；提问必须 askQuestion
      await mainAgent.runStage('brainstorm', context)
      run.currentStage = 'plan'
      break

    case 'plan':
      await mainAgent.runStage('plan', context) // → Validated Plan + Plan Version
      run.currentStage = 'scope_check'
      break

    case 'scope_check': {
      const scope = await runScopeCheck(run.plan) // 审实施计划
      if (scope.hasHigh) {
        if (run.scopeCorrectionUsed < 2) {
          run.scopeCorrectionUsed++
          run.currentStage = 'plan'
        } else {
          run.currentStage = 'waiting_user' // 禁止 tradeoff 硬闯
        }
      } else {
        run.currentStage = 'implement'
      }
      break
    }

    case 'implement':
      // 任务级子循环：见 §4.4
      await mainAgent.runImplementWithTaskLoop(context)
      run.currentStage = 'test'
      break

    case 'test': {
      const testResult = await runRuntimeControlledTests()
      run.currentStage = testResult.passed ? 'review' : 'fix'
      break
    }

    case 'review': {
      const review = await reviewSubagent.review(snapshot)
      if (run.reviewOnly) {
        run.currentStage = 'report'
      } else if (review.hasBlockingFindings) {
        run.currentStage = 'fix'
      } else {
        run.currentStage = 'report' // non-blocking → 技术债进报告
      }
      break
    }

    case 'fix':
      await mainAgent.runStage('fix', context)
      run.currentStage = 'test' // 扩大范围则先 plan
      break

    case 'report':
      await createFinalReportFromRuntimeFacts(run)
      // 可选：askQuestion 是否 ship；默认否
      run.currentStage = 'completed'
      break
  }

  await atomicStageCommit(run)
}
```

### 4.4 Implement 阶段：任务级子循环（定稿）

`implement` 是**一个业务阶段**，内部按 Validated Plan 的任务做子循环（对齐 BuildRail `/run`，但仍是同一主 Agent）：

```text
for each task in plan.tasks:
  实现该任务
  只从该任务 acceptanceMap 提取安全的定向验证命令
  没有定向命令 → 标记 UNVERIFIED，记录证据并继续（不消耗三次重试预算）
  命令被环境、凭据或安全策略阻断 → waiting_user
  命令失败或 timeout → 主 Agent 带 br-debug 修复；同一任务最多 3 次，第 3 次仍失败 → SKIPPED
全部任务结束后 → 进入交付级 `test` 阶段（仅运行 Validated Plan 显式列出的安全命令）
```

预算区分：

| 预算 | 上限 | 触发 |
|---|---|---|
| 任务内验收修复 | 每任务 3 次 | implement 子循环 |
| Scope 修正 | 每 run 2 轮 | scope_check ↔ plan |
| 交付 Test-Fix | 每 run 3 轮 | 交付级 `test` 失败 → `fix` |
| Review Remediation | 每 run 2 轮 | Blocking Findings → `fix` |

任务被 SKIPPED 或 UNVERIFIED 不自动失败整个 run；最终报告单列未定向验证任务。交付级 `test` 仍必须跑；无显式安全命令时安全暂停，不以仓库全量脚本兜底。

### 4.5 模块落点

| 模块 | 职责 | 建议路径 |
|---|---|---|
| StageResolver | NL + 仓库状态 → 起点 | `src/runtime/workflow/xforge/stageResolver.ts` |
| StageController | 阶段转移、门禁、预算、原子提交 | `src/runtime/workflow/xforge/stageController.ts` |
| StageBinding | stage → 方法 / Runtime 执行语义 | `src/runtime/workflow/xforge/stageBinding.ts` |
| MainAgentSession | 逻辑主上下文链 | 改造 compose / `agentHandler` |
| ReviewSubagent | 只读 fork + Findings | 复用 subAgent，收紧权限 |
| Test Gate | Runtime 受控命令 | 复用 verification runner |
| UI Projection | 唯一从 RunCoordinator 投影 | ModeSwitch + compose 进度 |

复用：`RunCoordinator`、`InteractionInbox`、fencing、既有 BuildRail skills、compose UI 骨架。  
首版同步具备：**EffectReceipt + Checkpoint + Workspace Fingerprint**（用户改动保护与安全恢复，不做「以后再说」）。

废弃：任意 DAG Orchestrator、CapabilityCatalog、Planner 生成拓扑、「compose=自由 Agent+verify」产品语义、旧动态编排文档。

### 4.6 与斜杠命令的关系（单决策链）

| 入口 | 行为 |
|---|---|
| XForge / compose 自然语言 | `resolveStartStage` → StageController |
| `/br-full-dev <需求>` | 同一控制器；显式入口偏向 `brainstorm`，仍过全部门禁 |
| `/br-bugfix`、`/br-review`、分步 `/idea`… | **基础版**：不另建决策链；能映射的映射到同一控制器对应起点，否则提示改用 XForge 或暂保持「仅 skill、非 XForge Stage Run」并在里程碑中标明 |

禁止：slash 一张图 + NL 另一套闲聊/护栏。

现有 `brFullDev.ts`（多段 `callAgent` + 每任务 worktree）仅作行为参考，**不能**当最终形态。

### 4.7 阶段与工具权限解耦

XForge Stage 只表达工作进度、方法绑定和质量门禁，不再按阶段名二次裁剪主 Agent 的基础工具。`read/write/bash/task/invoke_skill` 等统一沿用 AgentLoop + PermissionManager 的既有权限语义，避免模型在正常工作中收到“当前阶段禁止工具”并进入无效 fallback 循环。

安全边界改为与阶段无关的系统不变量：所有阶段均禁止 `commit/push/reset/clean/deploy/publish`；Test Gate 仍只接受 Runtime Controlled Commands；Review 仍由无工具的隔离子代理消费不可变 snapshot。阶段方法只提供领域判断，`askQuestion` 协议、产物持久化路径和结构化返回契约由 Runtime 唯一管理。

### 4.8 产物落盘约定

统一根目录：`.nova/compose/<runId>/`（或项目约定的 compose 根下按 runId 隔离）。

| 路径 | 内容 |
|---|---|
| `idea/` | 探索产物（design / requirement） |
| `plans/` | 实施计划正文 + 结构化计划快照 |
| `evidence/` | Test Evidence、Scope/Review 摘要引用 |
| `report/` | 最终报告（事实层由 Runtime 生成） |

上下文只保留摘要 + 路径；权威状态在 RunCoordinator。不强制兼容 `.buildrail/` 作为写入根（只读识别用户已有 BuildRail 产物可作为 Resolver 信号）。

### 4.9 并发与会话

- **同 workspace 同时仅一个非终态 XForge Stage Run**；第二个 XForge 请求拒绝，避免 parked run 被覆盖。  
- `waiting_user` 没有未收敛执行句柄时不阻塞其他会话的普通消息；用户切换会话 / 重启应用可凭 `runId` 恢复，UI 展示挂起原因与 Resume Target。  
- 取消按 `runId` 定向：parked run 直接取消交互并原子写入 `cancelled`；运行中 run 只取消其执行句柄，迟到事件丢弃。  

---

## 5. StageResolver 规则

### 5.1 优先级（高 → 低）

1. Review Only 约束（与其它信号冲突时，**以 review + reviewOnly 为准**）  
2. 强制门禁前置（无 Validated Plan 不能 implement；无 Scope Pass 不能 implement）  
3. 用户明确起点（「从测试开始」）提升到**满足门禁后的最早合法阶段**  
4. 仓库确定性事实（已有 plan/spec、Scope Pass、证据是否绑定当前 Workspace Revision）  
5. 至多**一次**模型语义补充；失败 → 保守 `brainstorm`（或明确可解析时的 `plan`），**禁止**静默变 default 闲聊  

仅 dirty 工作区、用户未声称「已改完」→ **不**因此改入口。

### 5.2 映射表

| 信号 | startStage | 备注 |
|---|---|---|
| 模糊新需求且无 Validated Plan | `brainstorm` | 内部分流见 §3.3 |
| 引用文档但是**设计-only**（无完整任务+验证清单） | `plan` | 不得直接 scope |
| 文档/产物已是 Validated Plan，无 Scope Pass | `scope_check` | 跳过探索 |
| Validated Plan + 有效 Scope Pass | `implement` | Pass 绑定 Plan Version + Workspace Revision |
| 明确 bugfix，未声称已完成 | `plan`（修复路径） | **不**跳过 Scope |
| 「已改好，帮测/查」 | `test` | |
| 「只审查，别改」 | `review` + reviewOnly | |
| 用户口头纠正起点 | 覆盖后仍受门禁夹紧 | 逃生舱 |

### 5.3 Validated Plan 定义

同时满足才算 Validated Plan（否则只能进 `plan`，不能 `scope_check` / `implement`）：

- Goal、约束、非目标  
- 当前仓库事实（带证据或明确 unverified）  
- 变更范围  
- **有序任务**（可执行）  
- 验收映射  
- **验证清单**（可为空；仅包含计划已明确的安全命令）  
- 风险处置  

路径/模块/命令/依赖须与当前仓库一致。  
每次创建或实质修改 → 新 **Plan Version**；Scope Pass 绑定该版本 + Workspace Revision；任一变更则 Pass 失效。

---

## 6. 质量门禁（代码强制）

### 6.1 Scope Check

- 审查**当前实施计划**，不是只扫设计文。  
- HIGH 且预算未用尽 → `plan` 修正（计数 +1，新 Plan Version）→ 再完整 scope。  
- **第 2 轮后仍有 HIGH → `waiting_user`**。  
- **取消**「记录 tradeoff 后继续实现」分支。  
- 无 HIGH → 生成 Scope Pass（绑定 Plan Version + Workspace Revision）。  

### 6.2 Test Gate

- 只执行 Validated Plan 显式列出的安全命令；不得自动把仓库的 typecheck、test、lint、build 设为必需项。  
- 每个命令必须有针对改动行为的理由；无必需命令时安全暂停，等待用户补充，不猜测全量命令。  
- **仅** Runtime Controlled Command 的结果为权威；模型 pass/fail JSON 非权威。  
- 通过：必需命令 exitCode=0、未 timeout、证据绑定当前 Workspace Revision/Fingerprint。  
- lint/typecheck 默认预算 120 秒；test/build 默认预算 180 秒，均可由受控命令覆盖。  
- 任一必需失败或 timeout → 未通过 → `fix`（计入交付 Test-Fix）。  
- 环境/凭据缺失无法跑 → `waiting_user`，不得判通过。  
- 任意工作区写入后，旧 Test Evidence **全部失效**。  

### 6.3 Review

- Blocking（critical/high）→ 非 reviewOnly 时进入 `fix`（计入 Review Remediation）。  
- **Non-blocking（medium/low/nit）**：写入最终报告「技术债」；**不**进入 fix 预算。允许主 Agent 在**不扩大 Validated Plan 范围**的前提下顺手极小修复，一旦有写入必须重新走 Test Gate，再决定是否重跑 Review。  
- reviewOnly：禁止 fix 与业务写入。  

### 6.4 Ship / 写入安全

- Report 事实层只读 RunCoordinator；模型只可润色措辞，不可改事实。  
- 明确列出未执行的 commit/push/deploy/publish，以及 `shipRequested` 交接意图。  
- Report 后可选一次 ship 交接确认；无论回答如何都保持工作区改动不提交。  
- implement/fix 首次写入前：完整 Checkpoint + Workspace Fingerprint；每次写入 EffectReceipt；冲突 → `waiting_user`。  

---

## 7. UI / 文案

- ModeSwitch：`XForge：自然语言驱动 BuildRail 开发流程（自动选阶段并推进）`  
- 进度：runId、当前阶段、已完成/已跳过、任务 `unverified`、门禁 verdict、预算、waiting 原因与 Resume Target；侧栏 parked 徽标可定向停止对应 run。  
- Review Only 标识  
- 证据过期、Workspace Drift、Pending Side Effect 须显示为**安全阻塞**，禁止暗示「可盲目继续」  
- 禁止文案：动态 DAG、Capability Marketplace、多长期 Agent、护栏自由发挥  

---

## 8. 实施里程碑

### M0 — 定稿与清场

- [x] 回溯错误 XForge commit，丢掉脏工作区（基线 `a564028`）  
- [x] 本文件作为施工真源（本轮已补齐缺口）  
- [x] 旧 DAG 方案标注作废；ModeSwitch / modeInstruction 文案对齐 §7  

**验收**：读本文件能唯一说出「BuildRail 阶段自适应 + 单主 Agent」。

### M1 — StageController + Resolver

- [x] 阶段状态机 + 原子提交（挂 RunCoordinator）  
- [x] Resolver 覆盖 §2.2 / §5（含 Validated Plan 判定、Review Only 优先）  
- [x] compose NL 进控制器；`/br-full-dev` 同链  
- [x] 产物目录按 §4.8  

**验收**：五类入口起点正确；「只审查」无写入；设计-only 文档不会直接 scope。

### M2 — 单主 Agent + 探索/计划/Scope/任务实施

- [x] 主路径单上下文链；探索路由 + 强制 askQuestion  
- [x] Validated Plan + Scope（无 tradeoff 硬闯）  
- [x] implement 任务级子循环 + EffectReceipt/Checkpoint/Fingerprint  
- [x] 阶段与工具权限解耦，保留全局副作用禁令（§4.7）  

**验收**：office-hours/brainstorm 生成具体 askQuestion，支持三轮澄清与暂存；scope 2 轮仍 HIGH → waiting；无定向命令任务为 UNVERIFIED，任务命令 3 次失败可 SKIPPED。

### M3 — Test / Review / Fix / Report

- [x] Runtime Test Gate + 证据新鲜度  
- [x] Review 隔离子代理 + Blocking/Non-blocking 分流  
- [x] 预算与修复闭环；报告事实层；可选 ship 询问  

**验收**：模型自报不能冒充测试通过；交付门禁不自动兜底全量脚本；Blocking 修完必再测再审；non-blocking 进技术债；ship 只记录意图。

### M4 — 收口

- [x] 删双轨与死代码；并发单 run；取消/恢复矩阵  
- [x] 验收矩阵自动化 + 五条人工路径 + 真实项目冒烟  
- [x] `default` / `plan` / 非 XForge compose 行为不被破坏  

**完成验证（2026-07-15）**：自然语言与 `/br-full-dev` 原生入口、模糊需求、完整实施计划、设计-only 文档、Bug 修复、已完成待测试、Review Only 均有自动化路径覆盖；多任务中行为验收标 UNVERIFIED、定向命令通过且交付门禁独立执行；完整计划在真实临时 Git 仓库中跑通 Scope → Implement → Runtime Test Gate → 隔离 Review → Report。最终 NSIS 安装态通过受控 `npm test` Test Gate 冒烟；该入口仅在显式环境变量下启用，正常主程序启动不会执行它。  

---

## 9. 明确不做

- 模型生成任意 DAG / Capability 市场  
- 每阶段长期 Agent  
- 基础版并行 worktree 编排（可后置）  
- Scope「tradeoff 后继续实现」  
- Resolver / 阶段失败后静默变 default 闲聊  
- 自动 commit / push / deploy  
- 为显得智能每轮乱打无关大模型（Resolver 最多一次短调用）  
- 同 workspace 双 XForge 并行写入  

---

## 10. 验收矩阵（基础版）

| 用户一句话 | 期望 |
|---|---|
| 「我想给 Nova 加浏览器能力，还没想清楚」 | `brainstorm` 起；探索用 askQuestion；完整向后跑 |
| 「按 `docs/browser-agent-plan.md` 实现」（任务、验收、范围、风险完整，命令可缺失） | 跳过探索；`scope_check` 或已有 Pass 则 `implement`；无交付命令则 Test Gate 安全暂停 |
| 「按某设计文实现」（无任务/验证清单） | `plan` 补全，不得直接 implement |
| 「修复切换会话后显示上一会话消息」 | `plan` 修复路径；不跳过 Scope |
| 「代码已经改好了，帮我测试并检查」 | 从 `test` 起；真命令 |
| 「审查当前工作区改动，不要修改」 | `review→report`；无业务写入；无自动 fix |

另测：Scope 2 轮仍 HIGH → waiting；交付 test 3 轮仍红 → waiting；Review Blocking 2 轮仍在 → waiting；parked run 不阻塞其他会话但同 workspace 第二个 XForge 被拒绝；指定 runId 取消不误伤其他 run；写入使旧证据失效。

---

## 11. 风险

1. 现有 `brFullDev` 多 Agent + worktree 与定稿冲突 → M2 必须改主路径。  
2. StageResolver 误判 → 用户纠正起点 + 门禁夹紧。  
3. 单主 Agent 上下文膨胀 → 产物落盘 + 摘要引用。  
4. 任务 SKIPPED 与交付测试的关系处理不当 → 假完成；须在报告中显式列出 SKIPPED。  
5. 实施期间禁止再引入第三条「临时智能方案」。  

---

## 12. 决策记录

| 日期 | 决策 |
|---|---|
| 2026-07-15 | 确认定稿：阶段自适应顺序工作流，非 DAG，非护栏聊天 |
| 2026-07-15 | 回溯 `3c3a4a9`～`24a55be`；工作区重置到 `a564028` |
| 2026-07-15 | 本文件成为 XForge 唯一施工真源 |
| 2026-07-15 | 补齐：探索路由与 askQuestion、Validated Plan、任务级 implement 子循环、预算表、非 Blocking 处置、权限/落盘/并发、刻意偏离 BuildRail、取消 tradeoff 硬闯 |
| 2026-07-15 | M0：旧 DAG/编排方案文档标注作废；ModeSwitch / modeInstruction 文案对齐 §7 |
| 2026-07-15 | M1–M4：原生 Stage Pipeline、单主 Agent、写入协议、Test/Review/Fix/Report、恢复与 UI 闭环完成；全量门禁及 NSIS 冒烟通过 |
