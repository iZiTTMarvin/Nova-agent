export const meta = {
  name: "br-full-dev",
  description: "一句话跑完开发全流程",
  whenToUse: "用户输入 /br-full-dev <需求>",
  phases: [
    { title: "探索" },
    { title: "计划" },
    { title: "执行" },
    { title: "审查" },
    { title: "发布" },
  ],
};

// ── 常量 ──────────────────────────────────────────────
const MAX_TDD_ATTEMPTS = 3;
const MAX_SCOPE_FIX_ROUNDS = 2;
const MAX_REVIEW_FIX_ROUNDS = 2;

// ── 结构化返回 schema（agent schema 选项） ─────────────
const DESIGN_SHAPE = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    route: { type: "string" },
  },
  required: ["title", "body"],
};

const ROUTE_SHAPE = {
  type: "object",
  properties: {
    route: { type: "string" },
    reason: { type: "string" },
  },
  required: ["route"],
};

const SCOPE_SHAPE = {
  type: "object",
  properties: {
    highCount: { type: "number" },
    highs: { type: "array", items: { type: "object" } },
    summary: { type: "string" },
  },
  required: ["highCount"],
};

const PLAN_SHAPE = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          size: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          verify: { type: "string" },
        },
        required: ["id", "title"],
      },
    },
  },
  required: ["title", "tasks"],
};

const IMPL_SHAPE = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
  },
};

const VERIFY_SHAPE = {
  type: "object",
  properties: {
    allPassed: { type: "boolean" },
    pass: { type: "number" },
    fail: { type: "number" },
    evidence: { type: "string" },
    failures: { type: "array", items: { type: "string" } },
    timeout: { type: "boolean" },
  },
  required: ["allPassed"],
};

const DEBUG_SHAPE = {
  type: "object",
  properties: {
    status: { type: "string" },
    summary: { type: "string" },
    evidence: { type: "string" },
    root_cause_guess: { type: "string" },
    tried: { type: "array", items: { type: "string" } },
    next_steps: { type: "array", items: { type: "string" } },
  },
  required: ["status"],
};

const REVIEW_SHAPE = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    criticalCount: { type: "number" },
    highCount: { type: "number" },
    criticals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          file: { type: "string" },
          severity: { type: "string" },
        },
      },
    },
    issues: { type: "array", items: { type: "object" } },
  },
  required: ["verdict", "criticalCount"],
};

const FIX_SHAPE = {
  type: "object",
  properties: {
    summary: { type: "string" },
    fixed: { type: "boolean" },
  },
};

const INTEGRATE_SHAPE = {
  type: "object",
  properties: {
    merged: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

const SHIP_SHAPE = {
  type: "object",
  properties: {
    committed: { type: "boolean" },
    pushed: { type: "boolean" },
    summary: { type: "string" },
  },
};

// ── 工具函数 ──────────────────────────────────────────
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function slug(s) {
  const t = String(s || "feature")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return t || "feature";
}

function parseArgs(raw) {
  let obj;
  if (typeof raw === "object" && raw !== null) {
    obj = raw;
  } else if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      obj = { requirement: raw };
    }
  } else {
    obj = {};
  }
  const requirement =
    typeof obj.requirement === "string"
      ? obj.requirement
      : typeof obj.task === "string"
        ? obj.task
        : "";
  return { requirement, projectId: obj.projectId, workspaceRoot: obj.workspaceRoot };
}

/** 快捷判断：新项目 / 大方向 → office-hours；否则 brainstorming */
function isNewProject(requirement) {
  const r = String(requirement || "").toLowerCase();
  const keywords = [
    "新项目",
    "从零",
    "脚手架",
    "greenfield",
    "new project",
    "搭建",
    "初始化项目",
    "大重构",
    "重写整个",
  ];
  return keywords.some((k) => r.includes(k));
}

function normalizeTasks(rawTasks) {
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks.map((t, i) => ({
    id: t.id || "task-" + String(i + 1).padStart(3, "0"),
    title: t.title || "task-" + (i + 1),
    size: t.size || "S",
    deps: Array.isArray(t.deps) ? t.deps : [],
    verify: t.verify || t.verifyCriteria || "",
    status: "pending",
    attempts: 0,
  }));
}

function nowIso() {
  return new Date().toISOString();
}

// ── 主流程 ────────────────────────────────────────────
const { requirement } = parseArgs(args);

if (!requirement) {
  return { error: "no-requirement", message: "Pass /br-full-dev <需求>" };
}

const ctx = { failures: [], results: [] };

// 记录编排开始时的 HEAD，供「放弃本次改动」回滚到此基线
let gitBaseline = null;
{
  const head = await bash("git rev-parse HEAD");
  if (head && head.passed) {
    const sha = String(head.stdout || "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) gitBaseline = sha;
  }
}

// ===== 阶段 1：探索 =====
phase("探索");
log("br-full-dev start", { requirement, gitBaseline });

let routeSkill;
let routeReason;

// 优先 br-idea 分流；失败则脚本内快捷判断
const ideaRoute = await agent("根据需求分流到 br-office-hours 或 br-brainstorming：" + requirement, {
  skill: "br-idea",
  schema: ROUTE_SHAPE,
  label: "br-idea",
});

if (ideaRoute && (ideaRoute.route === "br-office-hours" || ideaRoute.route === "br-brainstorming")) {
  routeSkill = ideaRoute.route;
  routeReason = ideaRoute.reason || "br-idea 分流";
} else {
  routeSkill = isNewProject(requirement) ? "br-office-hours" : "br-brainstorming";
  routeReason = isNewProject(requirement)
    ? "脚本快捷判断：新项目/大方向"
    : "脚本快捷判断：小功能增强";
}

updateState({
  auto_decisions: [
    { phase: "explore", decision: "路由到 " + routeSkill, reason: routeReason, auto: true },
  ],
});

const design = await agent("执行 " + routeSkill + "，产出设计文档正文。需求：" + requirement, {
  skill: routeSkill,
  schema: DESIGN_SHAPE,
  label: "explore-design",
});

if (!design || !design.body) {
  updateState({
    auto_decisions: [
      {
        phase: "explore",
        decision: "探索失败，终止编排",
        reason: "设计 agent 未产出有效正文",
        auto: true,
      },
    ],
  });
  return { error: "brainstorm-failed" };
}

const designTitle = design.title || requirement.slice(0, 30);
const specPath = ".nova/compose/specs/" + today() + "-" + slug(designTitle) + "-design.md";
await write(specPath, design.body);
updateState({ artifacts: { spec: specPath } });
log("design written", { specPath, route: routeSkill });

// ===== 阶段 2：计划 =====
phase("计划");

let scope = await agent("执行 br-scope-check，审查设计文档：" + specPath, {
  skill: "br-scope-check",
  schema: SCOPE_SHAPE,
  label: "scope-check",
});

for (let i = 0; i < MAX_SCOPE_FIX_ROUNDS && scope && scope.highCount > 0; i++) {
  log("scope-check HIGH，修复轮次", i + 1, scope.highCount);
  const fixed = await agent(
    "修复 scope-check 的 HIGH 问题并重写设计文档正文。当前设计路径：" +
      specPath +
      "\nHIGH 问题：" +
      JSON.stringify(scope.highs || []),
    { skill: routeSkill, schema: DESIGN_SHAPE, label: "scope-fix-" + i }
  );
  if (!fixed || !fixed.body) break;
  await write(specPath, fixed.body);
  updateState({
    auto_decisions: [
      {
        phase: "plan",
        decision: "自动修复 scope HIGH（轮次 " + (i + 1) + "）",
        reason: "highCount=" + scope.highCount,
        auto: true,
      },
    ],
  });
  scope = await agent("执行 br-scope-check，审查设计文档：" + specPath, {
    skill: "br-scope-check",
    schema: SCOPE_SHAPE,
    label: "scope-check-r" + (i + 1),
  });
}

const plan = await agent("执行 br-task-breakdown，基于设计文档拆分任务：" + specPath, {
  skill: "br-task-breakdown",
  schema: PLAN_SHAPE,
  label: "task-breakdown",
});

if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
  return { error: "plan-failed" };
}

const planTitle = plan.title || designTitle;
const planPath = ".nova/compose/plans/" + today() + "-" + slug(planTitle) + "-plan.md";
const planBody = plan.body || JSON.stringify(plan.tasks, null, 2);
await write(planPath, planBody);

const tasks = normalizeTasks(plan.tasks);
updateState({
  artifacts: { plan: planPath },
  tasks: tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: "pending",
    size: t.size,
    deps: t.deps,
    verifyCriteria: t.verify,
    attempts: 0,
  })),
});
log("plan written", { planPath, taskCount: tasks.length });

// ===== 阶段 3：执行 =====
phase("执行");

const batches = topoSort(tasks);
const skippedIds = new Set();
/** 用户在 3 次失败后选择停止编排 */
let userAborted = false;

/**
 * 可选停顿：连续验收失败跳过任务后，询问是否继续后续任务。
 * 选「停止编排」则不再跑后续 batch / 审查 / 发布。
 */
async function confirmContinueAfterSkip(task) {
  if (userAborted) return;
  const cont = await askUser({
    question:
      "任务「" +
      task.title +
      "」连续 3 次验收失败，已标记跳过。是否继续后续任务？",
    options: ["跳过并继续", "停止编排"],
  });
  if (cont !== "跳过并继续") {
    userAborted = true;
    updateState({
      auto_decisions: [
        {
          phase: "execute",
          decision: "用户停止编排",
          reason: "任务 " + task.id + " 验收失败后选择停止",
          auto: false,
        },
      ],
    });
  }
}

/**
 * 依赖被跳过时级联标记本任务 skipped。
 * @returns {boolean} true 表示已跳过，调用方应直接 return
 */
function skipIfMissingDep(task) {
  const missingDep = (task.deps || []).find((d) => skippedIds.has(d));
  if (!missingDep) return false;
  updateState({
    failure: {
      taskId: task.id,
      reason: "dependency_missing",
      summary: "依赖任务 " + missingDep + " 已跳过",
      evidence: "deps=" + JSON.stringify(task.deps),
      status: "skipped",
    },
  });
  skippedIds.add(task.id);
  return true;
}

/**
 * verify + TDD 循环。directory 有值时在同一 worktree 内验收/修复（不新建）。
 * @returns {object|null} 通过时返回 verify 结果，失败返回 null
 */
async function runVerifyTdd(task, opts) {
  const dirOpt = opts.directory ? { directory: opts.directory } : {};
  const onFail = opts.onFail;

  let verify = await agent(
    "执行 br-verify：验收标准「" +
      (task.verify || task.title) +
      "」。必须跑真实命令，返回结构化结果。",
    {
      skill: "br-verify",
      schema: VERIFY_SHAPE,
      label: "verify-" + task.id,
      ...dirOpt,
    }
  );

  let attempts = 0;
  const tried = [];

  while (verify && !verify.allPassed && attempts < MAX_TDD_ATTEMPTS) {
    if (verify.timeout) {
      updateState({
        failure: {
          taskId: task.id,
          reason: "test_timeout",
          summary: "验收命令超时",
          evidence: verify.evidence || "",
          status: "skipped",
          attempts: attempts + 1,
        },
      });
      skippedIds.add(task.id);
      if (onFail) await onFail();
      return null;
    }

    attempts += 1;
    const failText = (verify.failures || []).join("\n") || verify.evidence || "无输出";
    // debug 必须与 impl/verify 同一 directory，禁止 isolation:worktree 另开目录
    const debug = await agent(
      "执行 br-debug 修复验收失败（内层最多 2 次重试）。失败信息：\n" + failText,
      {
        skill: "br-debug",
        schema: DEBUG_SHAPE,
        label: "debug-" + task.id + "-" + attempts,
        ...dirOpt,
      }
    );

    tried.push(
      "第" + attempts + "次：" + (debug && debug.summary ? debug.summary : "debug 无结果")
    );

    if (!debug || debug.status === "unresolved") {
      if (attempts >= MAX_TDD_ATTEMPTS) {
        updateState({
          failure: {
            taskId: task.id,
            reason: "verify_failed_3x",
            summary: (debug && debug.summary) || "连续验收失败",
            evidence: failText,
            root_cause_guess: (debug && debug.root_cause_guess) || "",
            tried: tried,
            next_steps: (debug && debug.next_steps) || [],
            status: "skipped",
            attempts: attempts,
          },
        });
        skippedIds.add(task.id);
        ctx.failures.push({ taskId: task.id, evidence: failText });
        if (onFail) await onFail();
        await confirmContinueAfterSkip(task);
        return null;
      }
      continue;
    }

    verify = await agent(
      "执行 br-verify：验收标准「" +
        (task.verify || task.title) +
        "」。必须跑真实命令。",
      {
        skill: "br-verify",
        schema: VERIFY_SHAPE,
        label: "verify-" + task.id + "-r" + attempts,
        ...dirOpt,
      }
    );
  }

  if (!verify || !verify.allPassed) {
    updateState({
      failure: {
        taskId: task.id,
        reason: "verify_failed_3x",
        summary: "验收连续 " + MAX_TDD_ATTEMPTS + " 次失败",
        evidence:
          (verify && (verify.evidence || (verify.failures || []).join("\n"))) || "",
        tried: tried,
        status: "skipped",
        attempts: attempts || MAX_TDD_ATTEMPTS,
      },
    });
    skippedIds.add(task.id);
    ctx.failures.push({
      taskId: task.id,
      evidence: (verify && verify.evidence) || "verify failed",
    });
    if (onFail) await onFail();
    await confirmContinueAfterSkip(task);
    return null;
  }

  updateState({
    task: {
      id: task.id,
      status: "done",
      attempts: attempts,
      verify: {
        pass: verify.pass != null ? verify.pass : 1,
        fail: verify.fail != null ? verify.fail : 0,
        evidence: verify.evidence || "passed",
      },
      finished_at: nowIso(),
    },
  });
  return verify;
}

async function runImplementTask(task, isolate) {
  if (userAborted) return null;
  if (skipIfMissingDep(task)) return null;

  const started = nowIso();
  updateState({
    task: { id: task.id, status: "in_progress", started_at: started },
  });

  const prevFailText = ctx.failures
    .map((f) => f.taskId + ": " + f.evidence)
    .join("\n");

  const impl = await agent(
    "实现任务「" +
      task.title +
      "」\n验收标准：" +
      (task.verify || "无") +
      (prevFailText ? "\n前置失败：\n" + prevFailText : ""),
    {
      schema: IMPL_SHAPE,
      isolation: isolate ? "worktree" : "none",
      label: "impl-" + task.id,
      timeoutMs: 600000,
    }
  );

  if (!impl) {
    updateState({
      failure: {
        taskId: task.id,
        reason: "agent_failed",
        summary: "实现 agent 返回空",
        status: "failed",
        attempts: 0,
      },
    });
    skippedIds.add(task.id);
    return null;
  }

  // 多任务隔离：verify/debug 必须落在同一 worktree，不能回主仓或另开目录
  const wt = impl._worktree;
  const wtDir = wt && wt.directory ? wt.directory : undefined;
  const verify = await runVerifyTdd(task, {
    directory: wtDir,
    onFail: async () => {
      if (wt) await cleanupWorktree(wt);
    },
  });
  if (!verify) return null;

  return { ...impl, taskId: task.id };
}

async function runBatch(batch) {
  const ISOLATE = batch.length > 1;

  const thunks = batch.map((t) => () => runImplementTask(t, ISOLATE));
  const outs = await parallel(thunks);

  if (ISOLATE) {
    const kept = outs.filter((o) => o && o._worktree && o._worktree.changed);
    if (kept.length) {
      await agent(
        "执行 integrate：将以下 worktree 合并到主工作目录（git merge / fetch+ff-only）。" +
          "trivial 冲突可自动解，真实冲突原样报告。\n" +
          JSON.stringify(
            kept.map((o) => o._worktree),
            null,
            2
          ),
        { schema: INTEGRATE_SHAPE, label: "integrate" }
      );
    }
    for (const o of outs) {
      if (o && o._worktree) await cleanupWorktree(o._worktree);
    }
  }

  // 批次后全量验证（有 package.json 时）
  const hasPkg = await exists("package.json");
  if (hasPkg) {
    const fullVerify = await bash("npm test");
    updateState({
      global_check: {
        test: {
          status: fullVerify && fullVerify.passed ? "pass" : "fail",
          evidence:
            (fullVerify && (fullVerify.stdout || fullVerify.stderr)) || "no output",
        },
      },
    });
    if (fullVerify && !fullVerify.passed) {
      for (const t of batch) {
        if (!skippedIds.has(t.id)) {
          ctx.failures.push({
            taskId: t.id,
            evidence: (fullVerify.stderr || fullVerify.stdout || "").slice(0, 500),
          });
        }
      }
    }
  }

  return outs;
}

for (const batch of batches) {
  if (userAborted) break;
  const batchOut = await runBatch(batch);
  ctx.results.push(...batchOut.filter(Boolean));
}

if (userAborted) {
  return {
    status: "completed",
    userAborted: true,
    summary: "用户在验收失败后停止编排",
    artifacts: { spec: specPath, plan: planPath },
  };
}

// ===== 阶段 4：审查 =====
phase("审查");

let review = await agent("执行 br-review 五轴审查（正确性/可读性/架构/安全/性能）", {
  skill: "br-review",
  schema: REVIEW_SHAPE,
  label: "review",
});

for (
  let i = 0;
  i < MAX_REVIEW_FIX_ROUNDS &&
  review &&
  (review.criticalCount > 0 || (review.highCount && review.highCount > 0));
  i++
) {
  const toFix = []
    .concat(review.criticals || [])
    .concat(
      (review.issues || []).filter(
        (x) => x.severity === "critical" || x.severity === "high"
      )
    );
  if (!toFix.length) break;

  log("review fix round", i + 1, "issues=", toFix.length);
  const fixThunks = toFix.map((c, idx) => () =>
    agent("修复审查问题：" + (c.summary || JSON.stringify(c)), {
      isolation: "worktree",
      schema: FIX_SHAPE,
      label: "review-fix-" + i + "-" + idx,
    })
  );
  const fixOuts = await parallel(fixThunks);
  const kept = fixOuts.filter((o) => o && o._worktree && o._worktree.changed);
  if (kept.length) {
    await agent(
      "执行 integrate：合并审查修复 worktree\n" +
        JSON.stringify(
          kept.map((o) => o._worktree),
          null,
          2
        ),
      { schema: INTEGRATE_SHAPE, label: "integrate-review-" + i }
    );
  }
  for (const o of fixOuts) {
    if (o && o._worktree) await cleanupWorktree(o._worktree);
  }

  review = await agent("执行 br-review 五轴审查（复审）", {
    skill: "br-review",
    schema: REVIEW_SHAPE,
    label: "review-r" + (i + 1),
  });
}

if (review) {
  updateState({
    review: {
      verdict: review.verdict || "pass",
      critical_count: review.criticalCount || 0,
      high_count: review.highCount || 0,
      issues: review.issues || review.criticals || [],
    },
  });
}

// ===== 阶段 5：发布 =====
phase("发布");

const reportPath =
  ".nova/compose/reports/" + today() + "-" + slug(planTitle) + ".md";
const reportBody = [
  "# 编排运行报告",
  "",
  "- 需求：" + requirement,
  "- 设计：" + specPath,
  "- 计划：" + planPath,
  "- 任务完成：" + JSON.stringify(loadState().stats || {}),
  "- 审查：" + JSON.stringify(review || {}),
  "",
].join("\n");
await write(reportPath, reportBody);
updateState({ artifacts: { report: reportPath } });

log("汇报本次成果", {
  results: ctx.results.length,
  review: review,
  stats: loadState().stats,
});

// 唯一 human-in-the-loop：必须停下等用户，不得自动推进
const proceed = await askUser({
  question: "以上改动都还在工作区。是否提交并推送？",
  options: ["提交并推送", "暂不提交，继续微调", "放弃本次改动"],
});

if (proceed === null) {
  return { status: "cancelled", pendingCommit: true, summary: "用户中止或取消" };
}

if (proceed === "提交并推送") {
  const ship = await agent("执行 br-ship：用户已确认提交并推送。请 commit 并 push。", {
    skill: "br-ship",
    schema: SHIP_SHAPE,
    label: "ship",
  });
  return {
    status: "completed",
    pendingCommit: false,
    ship: ship,
    artifacts: { spec: specPath, plan: planPath, report: reportPath },
  };
}

if (proceed === "放弃本次改动") {
  // 禁止 git reset --hard / git clean：会删除用户无关修改与未跟踪文件。
  // 工作区改动保留；用户可用消息回退 / checkpoint / 后续 RollbackService 安全恢复。
  const revertError =
    "自动 Git 硬回滚已禁用（会误删无关改动）。工作区改动已保留，请用消息回退或逐文件 checkpoint 恢复。" +
    (gitBaseline ? " 编排基线 SHA=" + gitBaseline : "");
  updateState({
    auto_decisions: [
      {
        phase: "ship",
        decision: "放弃改动但未自动回滚工作区",
        reason: revertError,
        auto: false,
      },
    ],
  });
  return {
    status: "completed",
    pendingCommit: false,
    abandoned: true,
    reverted: false,
    gitBaseline: gitBaseline,
    revertError: revertError,
    artifacts: { spec: specPath, plan: planPath, report: reportPath },
  };
}

// 暂不提交
return {
  status: "completed",
  pendingCommit: true,
  summary: ctx.results,
  artifacts: { spec: specPath, plan: planPath, report: reportPath },
};
