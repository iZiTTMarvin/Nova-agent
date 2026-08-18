/**
 * NovaMemEval 确定性数据集：种子记忆 + 查询用例。
 * 词表设计约束：每个用例的 query 与目标 content 共享 ≥3 字符的区分性词元，
 * 且不与禁止记忆/他项目记忆共享该词元，保证 lexical 信号可分。
 */
import type { MemoryRecordDraft } from '@runtime/memory/repository/MemoryRepository'
import type { EvalCase, EvalCategory, EvalPerspective } from './evalHarness'

/** 种子构造入参：scope 由 harness 依 id 前缀分配（si_b* 属项目 B，其余项目 A / global） */
interface SeedSpec {
  id: string
  scope: 'project-a' | 'project-b' | 'global'
  kind: MemoryRecordDraft['kind']
  memoryKey: string | null
  content: string
  status?: MemoryRecordDraft['status']
  explicitness?: MemoryRecordDraft['explicitness']
  supersedesId?: string | null
}

// ── 种子记忆 ────────────────────────────────────────────────────────

export const SEED_SPECS: readonly SeedSpec[] = [
  // 全局显式偏好（user_explicit · active）
  { id: 'ge_01', scope: 'global', kind: 'convention', memoryKey: 'commit.message.language', content: '用户要求 commit 提交信息一律用中文书写', explicitness: 'user_explicit' },
  { id: 'ge_02', scope: 'global', kind: 'preference', memoryKey: 'comment.language', content: '代码注释语言统一使用中文', explicitness: 'user_explicit' },
  { id: 'ge_03', scope: 'global', kind: 'convention', memoryKey: 'pr.title.style', content: 'PR 标题使用 Conventional Commits 风格前缀', explicitness: 'user_explicit' },
  { id: 'ge_04', scope: 'global', kind: 'preference', memoryKey: 'test.framework', content: '单元测试偏好使用 vitest 运行器', explicitness: 'user_explicit' },
  { id: 'ge_05', scope: 'global', kind: 'preference', memoryKey: 'package.manager', content: '依赖安装偏好使用 pnpm 工具', explicitness: 'user_explicit' },
  { id: 'ge_06', scope: 'global', kind: 'preference', memoryKey: 'ui.approach', content: '界面组件实现优先用 React 写法', explicitness: 'user_explicit' },
  { id: 'ge_07', scope: 'global', kind: 'workflow', memoryKey: 'git.history.style', content: '整理提交历史时喜欢用 rebase 方式', explicitness: 'user_explicit' },
  { id: 'ge_08', scope: 'global', kind: 'preference', memoryKey: 'docs.format', content: '项目文档格式偏好 Markdown 手册', explicitness: 'user_explicit' },
  { id: 'ge_09', scope: 'global', kind: 'convention', memoryKey: 'error.message.style', content: '报错提示必须给出可执行的修复建议', explicitness: 'user_explicit' },
  { id: 'ge_10', scope: 'global', kind: 'preference', memoryKey: 'naming.style', content: '变量命名用完整英文单词不使用缩写', explicitness: 'user_explicit' },

  // 全局观察偏好（observed · active，advisory）
  { id: 'go_01', scope: 'global', kind: 'preference', memoryKey: 'language.primary', content: '用户平时开发经常使用 TypeScript', explicitness: 'observed' },
  { id: 'go_02', scope: 'global', kind: 'preference', memoryKey: 'frontend.framework', content: '用户前端技术栈经常使用 React 生态', explicitness: 'observed' },
  { id: 'go_03', scope: 'global', kind: 'preference', memoryKey: 'script.language', content: '用户经常使用 Python 写自动化脚本', explicitness: 'observed' },
  { id: 'go_04', scope: 'global', kind: 'preference', memoryKey: 'server.framework', content: '用户经常使用 FastAPI 搭建服务端', explicitness: 'observed' },
  { id: 'go_05', scope: 'global', kind: 'workflow', memoryKey: 'deploy.style', content: '用户经常使用 Docker 容器部署应用', explicitness: 'observed' },
  { id: 'go_06', scope: 'global', kind: 'preference', memoryKey: 'hosting.platform', content: '用户经常使用 GitHub 托管仓库', explicitness: 'observed' },
  { id: 'go_07', scope: 'global', kind: 'preference', memoryKey: 'proto.storage', content: '用户经常使用 SQLite 做原型存储', explicitness: 'observed' },
  { id: 'go_08', scope: 'global', kind: 'preference', memoryKey: 'css.solution', content: '用户经常使用 TailwindCSS 写界面样式', explicitness: 'observed' },

  // 项目决策与约定（project A · active）
  { id: 'pd_01', scope: 'project-a', kind: 'decision', memoryKey: 'database.primary', content: '项目主数据库选型为 PostgreSQL 并沿用至今' },
  { id: 'pd_02', scope: 'project-a', kind: 'decision', memoryKey: 'state.management', content: '状态管理选择 Zustand 因为其模型简单轻量' },
  { id: 'pd_03', scope: 'project-a', kind: 'project_fact', memoryKey: 'build.tool', content: '构建工具链使用 electron-vite 驱动' },
  { id: 'pd_04', scope: 'project-a', kind: 'convention', memoryKey: 'ipc.naming', content: 'IPC 通道命名统一使用 kebab-case 形式' },
  { id: 'pd_05', scope: 'project-a', kind: 'convention', memoryKey: 'test.layers', content: '测试分层约定为 unit 与 integration 两级' },
  { id: 'pd_06', scope: 'project-a', kind: 'convention', memoryKey: 'release.checklist', content: '发布前必须跑完整回归清单核对' },
  { id: 'pd_07', scope: 'project-a', kind: 'convention', memoryKey: 'adr.location', content: '架构决策记录统一放在 docs 目录归档' },
  { id: 'pd_08', scope: 'project-a', kind: 'convention', memoryKey: 'deps.upgrade.policy', content: '依赖升级策略为每季度集中处理一次' },
  { id: 'pd_09', scope: 'project-a', kind: 'convention', memoryKey: 'error.codes.location', content: '错误码统一定义在 shared 层集中维护' },
  { id: 'pd_10', scope: 'project-a', kind: 'project_fact', memoryKey: 'repo.url', content: '远程仓库地址为 github.com/example/nova' },

  // 项目踩坑与流程（project A · active）
  { id: 'gw_01', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: 'Electron 初始化顺序写错会导致 IPC handler 未注册失效' },
  { id: 'gw_02', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: 'Windows 路径大小写差异曾造成测试偶发失败' },
  { id: 'gw_03', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: 'better-sqlite3 原生模块必须按 Electron ABI 重编译才能加载' },
  { id: 'gw_04', scope: 'project-a', kind: 'workflow', memoryKey: 'verify.flow', content: '修改功能后的固定流程是先跑单测再跑界面回归' },
  { id: 'gw_05', scope: 'project-a', kind: 'workflow', memoryKey: 'compaction.precheck', content: '上下文压缩前必须先保存 checkpoint 保护现场' },
  { id: 'gw_06', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: '缓存断点位置移动会击穿 prompt cache 命中率' },
  { id: 'gw_07', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: 'WAL 模式下数据库并发读不会阻塞写入事务' },
  { id: 'gw_08', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: '打包后 asar 内的 skill 资源必须走 unpacked 路径读取' },
  { id: 'gw_09', scope: 'project-a', kind: 'workflow', memoryKey: 'release.script.flow', content: '发布脚本执行顺序为先构建产物再跑打包验证' },
  { id: 'gw_10', scope: 'project-a', kind: 'gotcha', memoryKey: null, content: '渲染进程内存泄漏多半源于事件 listener 未清理' },

  // 冲突链：同 key 旧新事实（旧 superseded / 新 active）
  { id: 'cf_1_old', scope: 'project-a', kind: 'project_fact', memoryKey: 'db.engine.history', content: '项目早期主库引擎使用 SQLite 存储', status: 'superseded' },
  { id: 'cf_1_new', scope: 'project-a', kind: 'project_fact', memoryKey: 'db.engine.history', content: '主库引擎已从 SQLite 迁移到 PostgreSQL', supersedesId: 'cf_1_old' },
  { id: 'cf_2_old', scope: 'project-a', kind: 'decision', memoryKey: 'state.library.history', content: '状态管理最初采用 Redux 方案', status: 'superseded' },
  { id: 'cf_2_new', scope: 'project-a', kind: 'decision', memoryKey: 'state.library.history', content: '状态管理已从 Redux 换成 Zustand 实现', supersedesId: 'cf_2_old' },
  { id: 'cf_3_old', scope: 'project-a', kind: 'project_fact', memoryKey: 'bundler.history', content: '构建打包早期依赖 webpack 配置', status: 'superseded' },
  { id: 'cf_3_new', scope: 'project-a', kind: 'project_fact', memoryKey: 'bundler.history', content: '构建打包已从 webpack 切到 electron-vite', supersedesId: 'cf_3_old' },
  { id: 'cf_4_old', scope: 'project-a', kind: 'project_fact', memoryKey: 'test.runner.history', content: '测试运行器过去使用 jest 驱动', status: 'superseded' },
  { id: 'cf_4_new', scope: 'project-a', kind: 'project_fact', memoryKey: 'test.runner.history', content: '测试运行器已从 jest 迁到 vitest 体系', supersedesId: 'cf_4_old' },
  { id: 'cf_5_old', scope: 'project-a', kind: 'project_fact', memoryKey: 'style.solution.history', content: '样式方案最初采用 less 预处理', status: 'superseded' },
  { id: 'cf_5_new', scope: 'project-a', kind: 'project_fact', memoryKey: 'style.solution.history', content: '样式方案已从 less 迁到 TailwindCSS', supersedesId: 'cf_5_old' },
  { id: 'cf_6_old', scope: 'project-a', kind: 'project_fact', memoryKey: 'deploy.mode.history', content: '部署方式曾经依赖虚拟机镜像交付', status: 'superseded' },
  { id: 'cf_6_new', scope: 'project-a', kind: 'project_fact', memoryKey: 'deploy.mode.history', content: '部署方式已迁移到容器化镜像交付', supersedesId: 'cf_6_old' },
  { id: 'cf_7_old', scope: 'project-a', kind: 'decision', memoryKey: 'api.style.history', content: '接口风格原先设计为 REST 形式', status: 'superseded' },
  { id: 'cf_7_new', scope: 'project-a', kind: 'decision', memoryKey: 'api.style.history', content: '接口风格已重构为 GraphQL 形式', supersedesId: 'cf_7_old' },

  // 撤回链：retracted 旧偏好 + active 新偏好
  { id: 'cfr_1', scope: 'project-a', kind: 'convention', memoryKey: 'commit.decorator', content: '以前 commit 标题都追加 emoji 装饰符号', status: 'retracted' },
  { id: 'cfr_1n', scope: 'project-a', kind: 'convention', memoryKey: 'commit.decorator', content: 'commit 标题不再追加 emoji 装饰保持朴素' },
  { id: 'cfr_2', scope: 'project-a', kind: 'convention', memoryKey: 'comment.density', content: '曾经要求每个函数都写大段说明注释', status: 'retracted' },
  { id: 'cfr_2n', scope: 'project-a', kind: 'convention', memoryKey: 'comment.density', content: '注释密度改为只在必要处写简短说明' },
  { id: 'cfr_3', scope: 'global', kind: 'convention', memoryKey: 'pr.title.decorator', content: '曾经 PR 标题统一加 rocket emoji 前缀', status: 'retracted' },
  { id: 'cfr_3n', scope: 'global', kind: 'convention', memoryKey: 'pr.title.decorator', content: 'PR 标题前缀已改为 Conventional Commits 类型词' },

  // 项目隔离：同 key 双项目对照（si_b* 属项目 B）
  { id: 'si_a1', scope: 'project-a', kind: 'convention', memoryKey: 'commit.prefix', content: '本项目 commit 前缀统一用 emoji 标记模块' },
  { id: 'si_b1', scope: 'project-b', kind: 'convention', memoryKey: 'commit.prefix', content: '本项目 commit 前缀统一用 scope 标记模块' },
  { id: 'si_a2', scope: 'project-a', kind: 'project_fact', memoryKey: 'orm.migrator', content: '本项目数据库迁移工具选用 drizzle kit' },
  { id: 'si_b2', scope: 'project-b', kind: 'project_fact', memoryKey: 'orm.migrator', content: '本项目数据库迁移工具选用 knex cli' },
  { id: 'si_a3', scope: 'project-a', kind: 'convention', memoryKey: 'lint.config', content: '本项目 lint 规则用 eslint flat 配置' },
  { id: 'si_b3', scope: 'project-b', kind: 'convention', memoryKey: 'lint.config', content: '本项目 lint 规则用 biome 工具链' },
  { id: 'si_a4', scope: 'project-a', kind: 'project_fact', memoryKey: 'node.version', content: '本项目 Node 版本锁定 22 LTS' },
  { id: 'si_b4', scope: 'project-b', kind: 'project_fact', memoryKey: 'node.version', content: '本项目 Node 版本锁定 20 LTS' },
  { id: 'si_a5', scope: 'project-a', kind: 'convention', memoryKey: 'indent.width', content: '本项目代码缩进使用 2 空格宽度' },
  { id: 'si_b5', scope: 'project-b', kind: 'convention', memoryKey: 'indent.width', content: '本项目代码缩进使用 4 空格宽度' },
  { id: 'si_a6', scope: 'project-a', kind: 'project_fact', memoryKey: 'dev.port', content: '本项目本地开发端口固定 5173' },
  { id: 'si_b6', scope: 'project-b', kind: 'project_fact', memoryKey: 'dev.port', content: '本项目本地开发端口固定 3000' }
]

// ── 查询用例 ────────────────────────────────────────────────────────

interface CaseSpec {
  id: string
  category: EvalCategory
  perspective?: EvalPerspective
  query: string
  expected?: readonly string[]
  forbidden?: readonly string[]
  history?: boolean
  behavior?: EvalCase['expectedBehavior']
}

const CASE_SPECS: readonly CaseSpec[] = [
  // 全局显式偏好 ×10
  { id: 'ge-q01', category: 'global-explicit-preference', query: '提交信息语言要求是什么', expected: ['ge_01'] },
  { id: 'ge-q02', category: 'global-explicit-preference', query: '注释语言偏好是什么', expected: ['ge_02'] },
  { id: 'ge-q03', category: 'global-explicit-preference', query: 'PR 标题格式约定怎么写', expected: ['ge_03'] },
  { id: 'ge-q04', category: 'global-explicit-preference', query: '单元测试运行器用什么', expected: ['ge_04'] },
  { id: 'ge-q05', category: 'global-explicit-preference', query: '依赖安装用什么工具', expected: ['ge_05'] },
  { id: 'ge-q06', category: 'global-explicit-preference', query: '界面组件写法倾向是什么', expected: ['ge_06'] },
  { id: 'ge-q07', category: 'global-explicit-preference', query: '整理提交历史用什么方式', expected: ['ge_07'] },
  { id: 'ge-q08', category: 'global-explicit-preference', query: '文档格式偏好是什么', expected: ['ge_08'] },
  { id: 'ge-q09', category: 'global-explicit-preference', query: '报错提示要怎么写', expected: ['ge_09'] },
  { id: 'ge-q10', category: 'global-explicit-preference', query: '变量命名习惯是什么', expected: ['ge_10'] },

  // 全局观察偏好 ×8
  { id: 'go-q01', category: 'global-observed-preference', query: '我平时开发用什么语言', expected: ['go_01'] },
  { id: 'go-q02', category: 'global-observed-preference', query: '前端技术栈习惯用什么', expected: ['go_02'] },
  { id: 'go-q03', category: 'global-observed-preference', query: '自动化脚本常用什么写', expected: ['go_03'] },
  { id: 'go-q04', category: 'global-observed-preference', query: '服务端框架习惯用什么', expected: ['go_04'] },
  { id: 'go-q05', category: 'global-observed-preference', query: '容器部署习惯用什么方式', expected: ['go_05'] },
  { id: 'go-q06', category: 'global-observed-preference', query: '托管仓库习惯用什么平台', expected: ['go_06'] },
  { id: 'go-q07', category: 'global-observed-preference', query: '做原型存储习惯用什么', expected: ['go_07'] },
  { id: 'go-q08', category: 'global-observed-preference', query: '界面样式习惯用什么方案', expected: ['go_08'] },

  // 项目决策与约定 ×10
  { id: 'pd-q01', category: 'project-decision-convention', query: '现在数据库选型是什么', expected: ['pd_01'] },
  { id: 'pd-q02', category: 'project-decision-convention', query: '状态管理为什么这么选', expected: ['pd_02'] },
  { id: 'pd-q03', category: 'project-decision-convention', query: '构建用什么工具链', expected: ['pd_03'] },
  { id: 'pd-q04', category: 'project-decision-convention', query: '通道命名有什么约定', expected: ['pd_04'] },
  { id: 'pd-q05', category: 'project-decision-convention', query: '测试分层是怎么约定的', expected: ['pd_05'] },
  { id: 'pd-q06', category: 'project-decision-convention', query: '发布前要核对什么', expected: ['pd_06'] },
  { id: 'pd-q07', category: 'project-decision-convention', query: '决策记录归档在哪里', expected: ['pd_07'] },
  { id: 'pd-q08', category: 'project-decision-convention', query: '依赖升级策略是什么', expected: ['pd_08'] },
  { id: 'pd-q09', category: 'project-decision-convention', query: '错误码定义在哪个位置', expected: ['pd_09'] },
  { id: 'pd-q10', category: 'project-decision-convention', query: '远程仓库地址是什么', expected: ['pd_10'] },

  // 踩坑与流程 ×10
  { id: 'gw-q01', category: 'gotcha-workflow', query: 'IPC handler 注册失败是什么坑', expected: ['gw_01'] },
  { id: 'gw-q02', category: 'gotcha-workflow', query: '测试偶发失败遇到过吗', expected: ['gw_02'] },
  { id: 'gw-q03', category: 'gotcha-workflow', query: '原生模块加载失败怎么处理', expected: ['gw_03'] },
  { id: 'gw-q04', category: 'gotcha-workflow', query: '改完功能后的验证流程', expected: ['gw_04'] },
  { id: 'gw-q05', category: 'gotcha-workflow', query: '压缩前要做什么准备', expected: ['gw_05'] },
  { id: 'gw-q06', category: 'gotcha-workflow', query: '缓存命中率下降什么原因', expected: ['gw_06'] },
  { id: 'gw-q07', category: 'gotcha-workflow', query: '数据库并发读写表现如何', expected: ['gw_07'] },
  { id: 'gw-q08', category: 'gotcha-workflow', query: '打包后资源读不到的问题', expected: ['gw_08'] },
  { id: 'gw-q09', category: 'gotcha-workflow', query: '发布脚本按什么顺序执行', expected: ['gw_09'] },
  { id: 'gw-q10', category: 'gotcha-workflow', query: '内存泄漏常见原因有哪些', expected: ['gw_10'] },

  // 冲突：默认检索只回新事实，禁止旧事实 ×10
  { id: 'cf-q01', category: 'conflict-supersede-retract', query: '现在主库引擎是什么', expected: ['cf_1_new'], forbidden: ['cf_1_old'] },
  { id: 'cf-q02', category: 'conflict-supersede-retract', query: '状态管理现在用什么实现', expected: ['cf_2_new'], forbidden: ['cf_2_old'] },
  { id: 'cf-q03', category: 'conflict-supersede-retract', query: '现在构建打包用什么', expected: ['cf_3_new'], forbidden: ['cf_3_old'] },
  { id: 'cf-q04', category: 'conflict-supersede-retract', query: '现在测试用什么运行器', expected: ['cf_4_new'], forbidden: ['cf_4_old'] },
  { id: 'cf-q05', category: 'conflict-supersede-retract', query: '现在样式方案是什么', expected: ['cf_5_new'], forbidden: ['cf_5_old'] },
  { id: 'cf-q06', category: 'conflict-supersede-retract', query: '现在部署方式是什么', expected: ['cf_6_new'], forbidden: ['cf_6_old'] },
  { id: 'cf-q07', category: 'conflict-supersede-retract', query: '现在接口风格是什么', expected: ['cf_7_new'], forbidden: ['cf_7_old'] },
  { id: 'cfr-q1', category: 'conflict-supersede-retract', query: 'commit 标题装饰现在什么要求', expected: ['cfr_1n'], forbidden: ['cfr_1'] },
  { id: 'cfr-q2', category: 'conflict-supersede-retract', query: '注释密度现在什么要求', expected: ['cfr_2n'], forbidden: ['cfr_2'] },
  { id: 'cfr-q3', category: 'conflict-supersede-retract', query: 'PR 标题前缀现在怎么写', expected: ['cfr_3n'], forbidden: ['cfr_3'] },

  // 项目隔离 ×6（A 视角不得见 B 记录）
  { id: 'si-q1', category: 'project-scope-isolation', query: '本项目 commit 前缀怎么写', expected: ['si_a1'], forbidden: ['si_b1'] },
  { id: 'si-q2', category: 'project-scope-isolation', query: '本项目迁移工具用什么', expected: ['si_a2'], forbidden: ['si_b2'] },
  { id: 'si-q3', category: 'project-scope-isolation', query: '本项目 lint 用什么配置', expected: ['si_a3'], forbidden: ['si_b3'] },
  { id: 'si-q4', category: 'project-scope-isolation', query: '本项目 Node 版本是多少', expected: ['si_a4'], forbidden: ['si_b4'] },
  { id: 'si-q5', category: 'project-scope-isolation', query: '本项目缩进多少空格', expected: ['si_a5'], forbidden: ['si_b5'] },
  { id: 'si-q6', category: 'project-scope-isolation', query: '本项目开发端口是多少', expected: ['si_a6'], forbidden: ['si_b6'] },

  // 无关查询 ×6（应无命中）
  { id: 'ir-q01', category: 'irrelevant-abstention', query: '今天午饭吃什么好呢', expected: [], behavior: 'abstain' },
  { id: 'ir-q02', category: 'irrelevant-abstention', query: '帮我写一首关于夏天的诗', expected: [], behavior: 'abstain' },
  { id: 'ir-q03', category: 'irrelevant-abstention', query: '下周天气预报怎么样', expected: [], behavior: 'abstain' },
  { id: 'ir-q04', category: 'irrelevant-abstention', query: '最近哪部电影好看', expected: [], behavior: 'abstain' },
  { id: 'ir-q05', category: 'irrelevant-abstention', query: '怎么学好一门外语', expected: [], behavior: 'abstain' },
  { id: 'ir-q06', category: 'irrelevant-abstention', query: '附近哪家咖啡好喝', expected: [], behavior: 'abstain' },

  // 历史追溯 ×4（history=true 找回旧事实）
  { id: 'hi-q01', category: 'history-query', query: '主库引擎以前是不是用过 SQLite', history: true, expected: ['cf_1_old', 'cf_1_new'], behavior: 'return_history' },
  { id: 'hi-q02', category: 'history-query', query: '状态管理以前是不是用 Redux', history: true, expected: ['cf_2_old', 'cf_2_new'], behavior: 'return_history' },
  { id: 'hi-q03', category: 'history-query', query: '构建工具以前是不是 webpack', history: true, expected: ['cf_3_old', 'cf_3_new'], behavior: 'return_history' },
  { id: 'hi-q04', category: 'history-query', query: '部署方式以前是不是虚拟机', history: true, expected: ['cf_6_old', 'cf_6_new'], behavior: 'return_history' }
]

/** 种子草稿（scope id 由运行期哈希填充） */
export function buildSeedDrafts(scopeIds: { projectA: string; projectB: string; global: string }): MemoryRecordDraft[] {
  return SEED_SPECS.map((spec) => {
    const scopeId =
      spec.scope === 'project-a' ? scopeIds.projectA
        : spec.scope === 'project-b' ? scopeIds.projectB
          : scopeIds.global
    return {
      id: spec.id,
      scope: { scopeKind: spec.scope === 'global' ? 'global' : 'project', scopeId },
      kind: spec.kind,
      memoryKey: spec.memoryKey,
      content: spec.content,
      status: spec.status ?? 'active',
      confidence: spec.explicitness === 'user_explicit' ? 0.95 : spec.explicitness === 'observed' ? 0.7 : 0.9,
      explicitness: spec.explicitness ?? 'workspace_verified',
      sourceType: spec.explicitness === 'user_explicit' ? 'user_message' : spec.explicitness === 'observed' ? 'tool_result' : 'workspace',
      supersedesId: spec.supersedesId ?? null,
      evidence: [
        {
          evidenceType: spec.explicitness === 'user_explicit' ? 'user_message' : spec.explicitness === 'observed' ? 'tool_result' : 'workspace',
          excerpt: '评测种子'
        }
      ]
    }
  })
}

export const EVAL_CASES: readonly EvalCase[] = CASE_SPECS.map((spec) => ({
  id: spec.id,
  category: spec.category,
  perspective: spec.perspective ?? 'project-a',
  query: spec.query,
  history: spec.history,
  expectedMemoryIds: spec.expected ?? [],
  forbiddenMemoryIds: spec.forbidden ?? [],
  expectedBehavior: spec.behavior ?? (spec.history ? 'return_history' : 'return_current')
}))

export const EVAL_CATEGORY_COUNTS: Readonly<Record<EvalCategory, number>> = Object.freeze(
  EVAL_CASES.reduce(
    (acc, c) => {
      acc[c.category] = (acc[c.category] ?? 0) + 1
      return acc
    },
    {
      'global-explicit-preference': 0,
      'global-observed-preference': 0,
      'project-decision-convention': 0,
      'gotcha-workflow': 0,
      'conflict-supersede-retract': 0,
      'project-scope-isolation': 0,
      'irrelevant-abstention': 0,
      'history-query': 0
    } as Record<EvalCategory, number>
  )
)
