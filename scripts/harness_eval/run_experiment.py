from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlsplit

try:
    from scripts.harness_eval.harbor_egress import ensure_harbor_egress_compatibility
except ModuleNotFoundError as error:
    if error.name != "scripts":
        raise
    from harbor_egress import ensure_harbor_egress_compatibility


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = Path(__file__).with_name("experiment.json")
HARNESS_SOURCE_FILES = (
    "scripts/harness_eval/run_experiment.py",
    "scripts/harness_eval/nova_agent.py",
    "scripts/harness_eval/install_network.py",
    "scripts/harness_eval/harbor_egress.py",
    "scripts/harness_eval/report.py",
    "scripts/harness_eval/experiment.json",
)
CSV_FIELDS = [
    "run_id",
    "task",
    "difficulty",
    "agent",
    "admission",
    "selected",
    "recovered",
    "passed",
    "reward",
    "failure_class",
    "budget_exhausted",
    "uncached_input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "estimated_cost_usd",
    "reported_cost_usd",
    "duration_seconds",
    "exception_type",
    "exception_message",
    "job_path",
]

INFRA_RETRYABLE = {
    "AgentSetupTimeoutError",
    "ApiConnectionClosedError",
    "ApiInternalServerError",
    "ApiOverloadedError",
    "ApiRateLimitError",
    "ApiResponseStalledError",
    "EnvironmentBuildTimeoutError",
    "EnvironmentStartTimeoutError",
    "NetworkConnectionError",
    "SandboxBuildFailedError",
    "VerifierTimeoutError",
    "VerifierInvalidRewardError",
    "HarborProcessError",
    "HarborIncompleteResultError",
    "HarborMissingResultError",
}

BUDGET_PATTERNS = re.compile(
    r"maximum (tool )?(rounds|steps|turns)|max[_ -]?turns|budget exhausted|"
    r"reached the maximum|agent timed out",
    re.IGNORECASE,
)

_APPEND_LOCK = Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_dataset_config(config: dict[str, Any]) -> dict[str, Any]:
    """dataset.manifest 引用 DeepSWE 冻结清单时，合并 repo/revision/task_ids/label。

    终端评测（terminal-bench）无需 manifest，直接使用 dataset 内联字段。
    """
    dataset = dict(config.get("dataset", {}))
    manifest_name = dataset.pop("manifest", None)
    if manifest_name is None:
        return dataset
    manifest_path = Path(__file__).with_name(manifest_name)
    if not manifest_path.is_file():
        raise RuntimeError(f"dataset manifest not found: {manifest_path}")
    manifest = read_json(manifest_path)
    merged = {**manifest, **dataset}
    return merged


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def node_runtime_archive_path(config: dict[str, Any], paths: Paths) -> Path:
    return paths.root / "cache" / config["node_runtime"]["archive_filename"]


def ensure_node_runtime_archive(config: dict[str, Any], paths: Paths) -> Path:
    runtime = config["node_runtime"]
    archive = node_runtime_archive_path(config, paths)
    expected_sha256 = str(runtime["archive_sha256"]).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise RuntimeError("node_runtime.archive_sha256 must be a SHA256 hex digest")
    if Path(str(runtime["archive_url"])).name != archive.name:
        raise RuntimeError("Node runtime URL and archive filename do not match")
    if archive.is_file():
        actual_sha256 = file_sha256(archive)
        if actual_sha256 != expected_sha256:
            raise RuntimeError(
                f"cached Node runtime checksum mismatch: expected {expected_sha256}, "
                f"got {actual_sha256}"
            )
        return archive

    archive.parent.mkdir(parents=True, exist_ok=True)
    partial = archive.with_suffix(archive.suffix + ".part")
    last_error: BaseException | None = None
    for attempt in range(1, 6):
        offset = partial.stat().st_size if partial.is_file() else 0
        headers = {"User-Agent": "nova-harness/1"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(str(runtime["archive_url"]), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                append = offset > 0 and response.status == 206
                mode = "ab" if append else "wb"
                expected_bytes = int(response.headers.get("Content-Length") or 0)
                written = 0
                with partial.open(mode) as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                        written += len(chunk)
                if expected_bytes and written != expected_bytes:
                    raise OSError(
                        f"incomplete Node runtime download: {written}/{expected_bytes} bytes"
                    )
            if file_sha256(partial) == expected_sha256:
                partial.replace(archive)
                return archive
            partial.unlink(missing_ok=True)
            last_error = RuntimeError("downloaded Node runtime checksum mismatch")
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        if attempt < 5:
            time.sleep(min(2**attempt, 10))
    raise RuntimeError("failed to download the pinned Node runtime after 5 attempts") from last_error


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    with _APPEND_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())


def log_progress(paths: Paths, event: str, **fields: Any) -> None:
    entry = {"at": utc_now(), "event": event, **fields}
    append_jsonl(paths.run / "progress.jsonl", entry)
    print(json.dumps(entry, ensure_ascii=False, sort_keys=True), flush=True)


def write_progress_snapshot(
    paths: Paths,
    rows: list[dict[str, Any]],
    total_cells: int,
) -> None:
    scored = [row for row in rows if str(row.get("passed", "")).strip()]
    passed = sum(csv_bool(row.get("passed")) for row in scored)
    snapshot = {
        "updated_at": utc_now(),
        "completed_cells": len(rows),
        "total_cells": total_cells,
        "scored_cells": len(scored),
        "passed_cells": passed,
        "pass_rate": passed / len(scored) if scored else None,
        "estimated_cost_usd": sum(
            float(row.get("estimated_cost_usd") or 0) for row in rows
        ),
        "uncached_input_tokens": sum(
            int(row.get("uncached_input_tokens") or 0) for row in rows
        ),
        "cache_read_tokens": sum(
            int(row.get("cache_read_tokens") or 0) for row in rows
        ),
        "output_tokens": sum(int(row.get("output_tokens") or 0) for row in rows),
        "last_result": rows[-1] if rows else None,
    }
    temporary = paths.run / "progress.json.tmp"
    temporary.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(paths.run / "progress.json")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def sha256_git_tree(repo: Path, revision: str, subdir: str) -> str:
    listing = subprocess.run(
        ["git", "-C", str(repo), "ls-tree", "-r", revision, "--", subdir],
        capture_output=True,
        check=True,
    ).stdout
    return hashlib.sha256(listing).hexdigest()


def command_version(command: list[str]) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
        return (result.stdout or result.stderr).strip().splitlines()[0]
    except (OSError, subprocess.SubprocessError, IndexError):
        return "unavailable"


def default_eval_root() -> Path:
    configured = os.environ.get("NOVA_EVAL_ROOT")
    return Path(configured).expanduser().resolve() if configured else Path.home() / ".nova" / "evals"


@dataclass(frozen=True)
class Paths:
    root: Path
    run: Path
    dataset: Path
    jobs: Path
    ledger: Path
    selected_csv: Path
    admissions_csv: Path


@dataclass(frozen=True)
class PendingCell:
    task: str
    agent: str
    next_admission: int
    max_admissions: int


def validate_execution_shape(config: dict[str, Any]) -> int:
    concurrency = config.get("pair_concurrency")
    if type(concurrency) is not int or not 1 <= concurrency <= 16:
        raise RuntimeError("pair_concurrency must be an integer between 1 and 16")
    if config.get("arms_parallel") is not False:
        raise RuntimeError("arms_parallel must remain false for paired pass@1")
    agents = list(config.get("active_agents") or config.get("agents", {}).keys())
    if concurrency > 1 and len(agents) != 1:
        raise RuntimeError(
            "pair_concurrency > 1 requires exactly one active agent; paired arms stay sequential"
        )
    return concurrency


def provider_hostname(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.query)
        or bool(parsed.fragment)
    ):
        raise RuntimeError(
            "base_url must be an HTTPS URL without embedded credentials, query, or fragment"
        )
    return parsed.hostname


def resolve_paths(config: dict[str, Any], eval_root: Path) -> Paths:
    run = eval_root / config["run_id"]
    revision = config["dataset"]["revision"]
    dataset_slug = config["dataset"].get("slug", "terminal-bench-2.1")
    dataset = eval_root / "datasets" / dataset_slug / revision
    return Paths(
        root=eval_root,
        run=run,
        dataset=dataset,
        jobs=run / "jobs",
        ledger=run / "admissions.jsonl",
        selected_csv=run / "results.csv",
        admissions_csv=run / "admissions.csv",
    )


def ordered_task_names(tasks_dir: Path, selected_ids: list[str] | None = None) -> list[str]:
    """按 agent timeout 升序排列任务名；selected_ids 非空时只保留子集。"""
    tasks: list[tuple[float, str]] = []
    for path in tasks_dir.iterdir():
        if not path.is_dir():
            continue
        if selected_ids is not None and path.name not in selected_ids:
            continue
        task_config = tomllib.loads(
            (path / "task.toml").read_text(encoding="utf-8")
        )
        tasks.append((float(task_config["agent"]["timeout_sec"]), path.name))
    missing = [name for name in (selected_ids or []) if not (tasks_dir / name).is_dir()]
    if missing:
        raise RuntimeError(f"task id(s) not found in dataset: {', '.join(missing)}")
    return [name for _timeout, name in sorted(tasks)]


def prepare(config: dict[str, Any], paths: Paths) -> list[str]:
    if config.get("task_attempts") != 1:
        raise RuntimeError("paired pass@1 requires task_attempts=1")
    validate_execution_shape(config)
    provider_hostname(config["base_url"])
    harbor_egress_policy = ensure_harbor_egress_compatibility()
    paths.run.mkdir(parents=True, exist_ok=True)
    if not paths.dataset.exists():
        paths.dataset.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "clone", "--filter=blob:none", config["dataset"]["repo"], str(paths.dataset)],
            check=True,
        )
    subprocess.run(
        ["git", "-C", str(paths.dataset), "checkout", "--detach", config["dataset"]["revision"]],
        check=True,
    )
    actual_revision = subprocess.run(
        ["git", "-C", str(paths.dataset), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if actual_revision != config["dataset"]["revision"]:
        raise RuntimeError(f"dataset revision mismatch: {actual_revision}")

    tasks_dir = paths.dataset / "tasks"
    selected_ids = config["dataset"].get("task_ids")
    if selected_ids is not None:
        if not isinstance(selected_ids, list) or not all(isinstance(x, str) for x in selected_ids):
            raise RuntimeError("dataset.task_ids must be a list of task id strings")
    task_names = ordered_task_names(tasks_dir, selected_ids)
    if len(task_names) != int(config["dataset"]["task_count"]):
        raise RuntimeError(f"expected {config['dataset']['task_count']} tasks, found {len(task_names)}")

    tree_hash = sha256_git_tree(paths.dataset, actual_revision, "tasks")
    expected_hash = config["dataset"].get("task_tree_sha256")
    hash_status = "verified" if tree_hash == expected_hash else "mismatch"
    if expected_hash and hash_status == "mismatch":
        raise RuntimeError(f"task tree fingerprint mismatch: expected {expected_hash}, got {tree_hash}")

    node_archive = ensure_node_runtime_archive(config, paths)
    subprocess.run(["npm", "run", "build:headless"], cwd=ROOT, check=True)
    bundle = ROOT / "out" / "headless" / "nova-headless.cjs"
    prompt = ROOT / "out" / "headless" / "prompts" / "base-rules.md"
    if not bundle.is_file() or not prompt.is_file():
        raise RuntimeError("headless build did not produce the expected bundle and prompt")

    frozen = {
        **config,
        "prepared_at": utc_now(),
        "dataset_path": str(paths.dataset),
        "actual_dataset_revision": actual_revision,
        "actual_task_tree_sha256": tree_hash,
        "task_tree_hash_status": hash_status,
        "tasks": task_names,
        "source_revision": command_version(["git", "-C", str(ROOT), "rev-parse", "HEAD"]),
        "source_dirty": bool(command_version(["git", "-C", str(ROOT), "status", "--porcelain"])),
        "nova_bundle_sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
        "nova_prompt_sha256": hashlib.sha256(prompt.read_bytes()).hexdigest(),
        "node_runtime": {
            **config["node_runtime"],
            "archive_path": str(node_archive),
            "actual_archive_sha256": file_sha256(node_archive),
        },
        "harness_sha256": {
            relative: file_sha256(ROOT / relative) for relative in HARNESS_SOURCE_FILES
        },
        "harbor_egress_policy": harbor_egress_policy,
        "versions": {
            "python": sys.version.split()[0],
            "node": command_version(["node", "--version"]),
            "harbor": command_version(["harbor", "--version"]),
            "docker": command_version(["docker", "--version"]),
            "opencode_pin": config["agents"]["opencode"]["version"],
            "claude_code_pin": config["agents"]["claude_code"]["version"],
        },
    }
    (paths.run / "frozen_setup.json").write_text(
        json.dumps(frozen, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    render_design_document(frozen, paths.run / "experiment-design.md")
    render_reproduction_document(frozen, paths.run / "REPRODUCING.md")
    return task_names


def render_design_document(config: dict[str, Any], output: Path) -> None:
    price = config["pricing_usd_per_million"]
    active_agents = list(config.get("active_agents") or config["agents"].keys())
    agents = ", ".join(active_agents)
    design = "paired pass@1" if len(active_agents) > 1 else "single-agent pass@1"
    text = f"""# Coding agent harness 实验设计

## Frozen setup

- Dataset: {config['dataset'].get('label', 'Terminal-Bench 2.1')} {config['dataset']['task_count']} 题，revision `{config['dataset']['revision']}`。
- Task tree SHA256: `{config['dataset']['task_tree_sha256']}`。
- Active arms: {agents}；每题每臂一次有效 model attempt，{design}。
- Model: `{config['model']}`；provider endpoint: `{config['base_url']}`；reasoning effort: `{config['reasoning_effort']}`。
- Agent budget: {config['max_tool_rounds']} turns/steps；task-native timeout × {config['timeout_multiplier']}；外层安全上限 {config['outer_timeout_seconds']} 秒。
- Execution order: `{config['task_order']}`；只改变运行先后，不改变题目、预算或判分。
- Agent setup timeout × {config['agent_setup_timeout_multiplier']}；只作用于 harness 安装，不改变解题时间。
- Runtime: Node.js `{config['node_runtime']['version']}` 从宿主机缓存的固定归档注入容器，SHA256 `{config['node_runtime']['archive_sha256']}`；每题不再联网安装 Node 或 sharp。模型请求使用容器代理 `{config['install_network']['proxy_url']}`。
- Network isolation: Harbor no-network sidecar 使用 loopback-only 本地豁免，policy SHA256 `{config['harbor_egress_policy']['policy_sha256']}`。
- Concurrency: {config['pair_concurrency']} task cell；arms_parallel={str(config['arms_parallel']).lower()}。多臂模式按题号轮换顺序。
- Retry: 模型失败、任务超时、budget exhaustion 不重试；只对预注册的 infrastructure-invalid cell 最多重试 {config['infra_retry_limit']} 次，保留全部 admission。
- Verifier: 仅以官方 verifier reward 判定 pass/fail。
- Cost circuit breaker: 累计统一估算超过 ${config['max_total_estimated_cost_usd']:.2f} 时停止新 cell。

## Failure taxonomy

`pass`；`verifier_fail`；`budget_exhausted`；`agent_timeout`；`agent_error`；
`provider_auth`；`provider_model`；`provider_transient`；`context_exhausted`；
`environment_infra`；`agent_setup_infra`；`verifier_infra`；`runner_outer_timeout`；`unclassified_infra`。

`budget_exhausted` 是与 pass/fail 正交的诊断字段；达到 task deadline 或 harness turn/step 上限即为 true。

## Cost formula

价格快照日期 {price['snapshot_date']}，USD / 1M tokens：未命中输入 {price['uncached_input']}，缓存命中输入 {price['cached_input']}，输出 {price['output']}，系数 {price['multiplier']}。

`estimated_cost = multiplier × (uncached_input × {price['uncached_input']} + cache_read × {price['cached_input']} + output × {price['output']}) / 1,000,000`

主报告使用这一统一公式；CLI 自报成本只保留为 `reported_cost_usd` 诊断列。

## Recovery policy

每个 admission 先写 append-only `admissions.jsonl` 的 started 记录，结束后再写 completed 记录。
只有白名单基础设施异常可以替换 cell；原始产物不覆盖。不自动执行 verifier-only replay。
"""
    output.write_text(text, encoding="utf-8")


def render_reproduction_document(config: dict[str, Any], output: Path) -> None:
    run_id = config["run_id"]
    text = f"""# Reproducing the harness comparison

## Dependencies

- Git, Python 3.12+, Node.js 22+, npm, uv, Docker with a running Linux daemon.
- Harbor 0.20.0: `uv tool install harbor==0.20.0`.
- Nova bundle and a SHA256-pinned Node.js runtime are injected into each Harbor task container; per-task package installation is not required.
- DeepSeek API access. Never put the key in a command argument or tracked file.

## Commands (PowerShell)

```powershell
$env:DEEPSEEK_API_KEY = Read-Host -MaskInput "DeepSeek API key"
uv run python scripts/harness_eval/run_experiment.py prepare
uv run python scripts/harness_eval/run_experiment.py run
uv run --with-requirements scripts/harness_eval/requirements.txt python scripts/harness_eval/report.py --run-dir "$HOME/.nova/evals/{run_id}"
```

Use `--task-limit 1` on the `run` command for a paid one-task smoke across the active arms before the full suite. Resume uses the same command; completed task/arm cells in `results.csv` are skipped.

## Results

Default directory: `$HOME/.nova/evals/{run_id}`.

- Submit/share `results.csv`, `report.md`, `per_task_comparison.csv`, plots, `frozen_setup.json`, and `SHA256SUMS` as appropriate.
- Keep `jobs/`, trajectories, provider logs, verifier logs, `admissions.csv`, and `admissions.jsonl` locally for audit. They can contain full prompts and task output.
- Repository policy for this project prohibits committing documentation; these run artifacts are deliberately outside the repository by default.

## Verification

```powershell
Get-Content "$HOME/.nova/evals/{run_id}/SHA256SUMS"
Get-FileHash -Algorithm SHA256 "$HOME/.nova/evals/{run_id}/results.csv"
```

The frozen setup also records the dataset revision, stable git-tree SHA256, tool versions, model, effort, timeouts, budgets, retry policy, and price snapshot.
"""
    output.write_text(text, encoding="utf-8")


def ensure_preflight() -> None:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    if not shutil.which("harbor"):
        raise RuntimeError("harbor is not installed")
    if not shutil.which("docker"):
        raise RuntimeError("docker is not installed")
    try:
        docker = subprocess.run(
            ["docker", "info"], capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Docker daemon did not respond within 30 seconds") from error
    if docker.returncode != 0:
        raise RuntimeError("Docker daemon is not available")


def agent_command(
    agent: str,
    task: str,
    admission: int,
    config: dict[str, Any],
    paths: Paths,
) -> tuple[list[str], Path]:
    job_dir = paths.jobs / task / agent / f"admission-{admission}"
    job_dir.mkdir(parents=True, exist_ok=True)
    common = [
        "harbor",
        "run",
        "-p",
        str(paths.dataset / "tasks"),
        "-i",
        task,
        "-n",
        "1",
        "-k",
        "1",
        "-r",
        "0",
        "--timeout-multiplier",
        str(config["timeout_multiplier"]),
        "--agent-setup-timeout-multiplier",
        str(config["agent_setup_timeout_multiplier"]),
        "--jobs-dir",
        str(job_dir),
        "--job-name",
        f"{task}-{agent}-a{admission}",
        "--allow-agent-host",
        provider_hostname(config["base_url"]),
        "--quiet",
    ]
    model = config["model"]
    effort = config["reasoning_effort"]
    rounds = str(config["max_tool_rounds"])
    install_network = config["install_network"]
    install_kwargs = [
        "--ak",
        f"install_proxy_url={install_network['proxy_url']}",
        "--ak",
        f"ubuntu_archive_mirror={install_network['ubuntu_archive_mirror']}",
    ]
    if agent == "nova":
        task_config = tomllib.loads(
            (paths.dataset / "tasks" / task / "task.toml").read_text(encoding="utf-8")
        )
        task_timeout = float(task_config["agent"]["timeout_sec"])
        scaled_timeout = task_timeout * float(config["timeout_multiplier"])
        deadline_seconds = scaled_timeout - float(config["agent_deadline_grace_seconds"])
        if deadline_seconds <= 0:
            raise RuntimeError(f"Nova deadline is not positive for task {task}")
        return (
            common
            + [
                "-a",
                "scripts.harness_eval.nova_agent:NovaHeadless",
                "-m",
                f"deepseek/{model}",
                "--ak",
                f"bundle_path={ROOT / 'out' / 'headless' / 'nova-headless.cjs'}",
                "--ak",
                f"prompt_path={ROOT / 'out' / 'headless' / 'prompts' / 'base-rules.md'}",
                "--ak",
                f"node_archive_path={config['node_runtime'].get('archive_path') or node_runtime_archive_path(config, paths)}",
                "--ak",
                f"base_url={config['base_url']}",
                "--ak",
                f"reasoning_effort={effort}",
                "--ak",
                f"max_tool_rounds={rounds}",
                "--ak",
                f"deadline_seconds={deadline_seconds:g}",
                "--ak",
                f"version={config['agents']['nova']['version']}",
                "--ak",
                f"install_proxy_url={install_network['proxy_url']}",
            ],
            job_dir,
        )
    if agent == "opencode":
        opencode_config = json.dumps({"agent": {"build": {"steps": int(rounds)}}}, separators=(",", ":"))
        return (
            common
            + [
                "-a",
                "scripts.harness_eval.comparison_agents:OpenCodeComparison",
                "-m",
                f"deepseek/{model}",
                "--ak",
                f"version={config['agents']['opencode']['version']}",
                "--ak",
                f"variant={effort}",
                "--ak",
                f"opencode_config={opencode_config}",
            ]
            + install_kwargs,
            job_dir,
        )
    if agent == "claude_code":
        return (
            common
            + [
                "-a",
                "scripts.harness_eval.comparison_agents:ClaudeCodeComparison",
                "-m",
                model,
                "--ak",
                f"version={config['agents']['claude_code']['version']}",
                "--ak",
                f"reasoning_effort={effort}",
                "--ak",
                f"max_turns={rounds}",
            ]
            + install_kwargs,
            job_dir,
        )
    raise ValueError(f"unknown agent: {agent}")


def safe_command(command: list[str]) -> list[str]:
    return ["<redacted>" if "KEY=" in value or "TOKEN=" in value else value for value in command]


def harbor_environment(
    agent: str,
    config: dict[str, Any],
    source: dict[str, str] | None = None,
) -> dict[str, str]:
    env = dict(os.environ if source is None else source)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    python_path = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(ROOT) + (os.pathsep + python_path if python_path else "")
    if agent == "claude_code":
        env["ANTHROPIC_BASE_URL"] = "https://api.deepseek.com/anthropic"
        env["ANTHROPIC_AUTH_TOKEN"] = env["DEEPSEEK_API_KEY"]
        env["CLAUDE_CODE_EFFORT_LEVEL"] = config["reasoning_effort"]
    return env


def newest_result(job_dir: Path) -> Path | None:
    candidates = list(job_dir.rglob("result.json"))
    if not candidates:
        return None
    trial_results: list[Path] = []
    for path in candidates:
        try:
            if trial_from_result(read_json(path)) is not None:
                trial_results.append(path)
        except (OSError, json.JSONDecodeError):
            continue
    if trial_results:
        return max(trial_results, key=lambda path: path.stat().st_mtime)
    return min(candidates, key=lambda path: len(path.relative_to(job_dir).parts))


def result_is_complete(result_path: Path) -> bool:
    try:
        trial = trial_from_result(read_json(result_path))
        return trial is not None and trial.get("finished_at") is not None
    except (OSError, json.JSONDecodeError):
        return False


def trial_from_result(result: dict[str, Any]) -> dict[str, Any] | None:
    trials = result.get("trial_results")
    if isinstance(trials, list) and trials:
        return trials[0]
    if "task_name" in result and "agent_info" in result:
        return result
    return None


def reward_value(trial: dict[str, Any]) -> float | None:
    verifier = trial.get("verifier_result") or {}
    rewards = verifier.get("rewards")
    if not isinstance(rewards, dict) or not rewards:
        return None
    if "reward" in rewards:
        return float(rewards["reward"])
    if len(rewards) == 1:
        return float(next(iter(rewards.values())))
    return min(float(value) for value in rewards.values())


def scan_budget_exhaustion(job_dir: Path, trial: dict[str, Any]) -> bool:
    exception = (trial.get("exception_info") or {}).get("exception_type", "")
    if exception == "AgentTimeoutError":
        return True
    metadata = (trial.get("agent_result") or {}).get("metadata") or {}
    if metadata.get("budget_exhausted") is True:
        return True
    for path in job_dir.rglob("*"):
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        if path.name not in {"summary.json", "nova-headless.txt", "opencode.txt", "claude-code.txt"}:
            continue
        try:
            if BUDGET_PATTERNS.search(path.read_text(encoding="utf-8", errors="replace")):
                return True
        except OSError:
            continue
    return False


def classify_failure(trial: dict[str, Any], reward: float | None, budget: bool) -> str:
    if reward is not None and reward >= 1.0:
        return "pass"
    if budget:
        return "budget_exhausted"
    exception = (trial.get("exception_info") or {}).get("exception_type", "")
    if exception and trial.get("agent_setup") is not None and trial.get("agent_execution") is None:
        return "agent_setup_infra"
    if not exception and reward is not None:
        return "verifier_fail"
    if exception == "AgentTimeoutError":
        return "agent_timeout"
    if exception == "RunnerOuterTimeoutError":
        return "runner_outer_timeout"
    if exception in {"AgentAuthenticationError", "ApiUsageLimitError"}:
        return "provider_auth"
    if exception in {"ModelNotFoundError", "ApiProviderResourceNotFoundError"}:
        return "provider_model"
    if exception in {
        "ApiConnectionClosedError",
        "ApiInternalServerError",
        "ApiOverloadedError",
        "ApiRateLimitError",
        "ApiResponseStalledError",
        "NetworkConnectionError",
    }:
        return "provider_transient"
    if exception in {"ContextWindowExceededError", "OutputTokenExceededError"}:
        return "context_exhausted"
    if exception.startswith("Environment") or exception == "SandboxBuildFailedError":
        return "environment_infra"
    if exception == "AgentSetupTimeoutError":
        return "agent_setup_infra"
    if exception.startswith("Verifier"):
        return "verifier_infra"
    if exception in {"HarborProcessError", "HarborIncompleteResultError", "HarborMissingResultError"}:
        return "unclassified_infra"
    if exception:
        return "agent_error"
    return "unclassified_infra"


def event_usage(job_dir: Path) -> tuple[int, int, int, int]:
    uncached = 0
    cached = 0
    cache_write = 0
    output = 0
    for path in job_dir.rglob("events.jsonl"):
        try:
            with path.open(encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") != "usage":
                        continue
                    usage = event.get("usage") or {}
                    uncached += int(usage.get("uncachedInputTokens") or 0)
                    cached += int(usage.get("cacheReadTokens") or 0)
                    cache_write += int(usage.get("cacheWriteTokens") or 0)
                    output += int(usage.get("outputTokens") or 0)
        except OSError:
            continue
    return uncached, cached, cache_write, output


def token_fields(
    trial: dict[str, Any],
    job_dir: Path | None = None,
) -> tuple[int, int, int, int, float | None]:
    contexts: list[dict[str, Any]] = []
    if isinstance(trial.get("agent_result"), dict):
        contexts.append(trial["agent_result"])
    for step in trial.get("step_results") or []:
        if isinstance(step.get("agent_result"), dict):
            contexts.append(step["agent_result"])
    total_input = sum(int(item.get("n_input_tokens") or 0) for item in contexts)
    cache = sum(int(item.get("n_cache_tokens") or 0) for item in contexts)
    output = sum(int(item.get("n_output_tokens") or 0) for item in contexts)
    reported_values = [item.get("cost_usd") for item in contexts if item.get("cost_usd") is not None]
    reported = sum(float(value) for value in reported_values) if reported_values else None
    cache_write = sum(int(((item.get("metadata") or {}).get("cache_write_tokens") or 0)) for item in contexts)
    uncached = max(0, total_input - cache)
    if job_dir is not None and uncached == 0 and cache == 0 and cache_write == 0 and output == 0:
        uncached, cache, cache_write, output = event_usage(job_dir)
    return uncached, cache, cache_write, output, reported


def duration_seconds(trial: dict[str, Any], fallback: float) -> float:
    try:
        started = datetime.fromisoformat(trial["started_at"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(trial["finished_at"].replace("Z", "+00:00"))
        return max(0.0, (finished - started).total_seconds())
    except (KeyError, TypeError, ValueError):
        return fallback


def estimated_cost(tokens: tuple[int, int, int, int, float | None], config: dict[str, Any]) -> float:
    uncached, cached, cache_write, output, _ = tokens
    price = config["pricing_usd_per_million"]
    raw = (
        uncached * price["uncached_input"]
        + cached * price["cached_input"]
        + cache_write * price.get("cache_write", 0)
        + output * price["output"]
    ) / 1_000_000
    return raw * price.get("multiplier", 1.0)


def build_row(
    config: dict[str, Any],
    task: str,
    agent: str,
    admission: int,
    selected: bool,
    recovered: bool,
    result_path: Path | None,
    elapsed: float,
    runner_exception: tuple[str, str] | None = None,
) -> dict[str, Any]:
    if result_path:
        result = read_json(result_path)
        trial = trial_from_result(result) or {}
    else:
        trial = {}
    exception_info = trial.get("exception_info") or {}
    exception_type = runner_exception[0] if runner_exception else exception_info.get("exception_type", "")
    exception_message = runner_exception[1] if runner_exception else exception_info.get("exception_message", "")
    if runner_exception:
        trial["exception_info"] = {"exception_type": exception_type, "exception_message": exception_message}
    reward = reward_value(trial)
    if (
        reward is not None
        and config.get("dataset", {}).get("slug") == "deep-swe"
        and reward not in {0.0, 1.0}
    ):
        exception_type = "VerifierInvalidRewardError"
        exception_message = f"DeepSWE verifier returned non-binary reward: {reward:g}"
        trial["exception_info"] = {
            "exception_type": exception_type,
            "exception_message": exception_message,
        }
        reward = None
    budget = (
        exception_type == "RunnerOuterTimeoutError"
        or (scan_budget_exhaustion(result_path.parent, trial) if result_path else False)
    )
    failure = classify_failure(trial, reward, budget)
    tokens = token_fields(trial, result_path.parent if result_path else None)
    uncached, cached, cache_write, output, reported = tokens
    return {
        "run_id": config["run_id"],
        "task": task,
        "difficulty": task_difficulty(task),
        "agent": agent,
        "admission": admission,
        "selected": selected,
        "recovered": recovered,
        "passed": "" if reward is None else reward >= 1.0,
        "reward": "" if reward is None else reward,
        "failure_class": failure,
        "budget_exhausted": budget,
        "uncached_input_tokens": uncached,
        "cache_read_tokens": cached,
        "cache_write_tokens": cache_write,
        "output_tokens": output,
        "estimated_cost_usd": round(estimated_cost(tokens, config), 10),
        "reported_cost_usd": "" if reported is None else reported,
        "duration_seconds": round(duration_seconds(trial, elapsed), 3),
        "exception_type": exception_type,
        "exception_message": exception_message,
        "job_path": str(result_path.parent if result_path else ""),
    }


def task_difficulty(task: str) -> str:
    setup = getattr(task_difficulty, "setup", None)
    if setup is None:
        return "unknown"
    task_file = Path(setup) / "tasks" / task / "task.toml"
    try:
        value = tomllib.loads(task_file.read_text(encoding="utf-8"))
        return str((value.get("metadata") or {}).get("difficulty") or "unknown")
    except (OSError, tomllib.TOMLDecodeError):
        return "unknown"


def is_retryable(row: dict[str, Any]) -> bool:
    return (
        row["exception_type"] in INFRA_RETRYABLE
        or row.get("failure_class") == "agent_setup_infra"
    ) and not csv_bool(row["budget_exhausted"])


def read_csv_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def csv_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes"}


def reconcile_csv(config: dict[str, Any], path: Path) -> int:
    rows = read_csv_rows(path)
    reconciled: list[dict[str, Any]] = []
    changed = 0
    for row in rows:
        job_path = Path(row.get("job_path") or "")
        result_path = newest_result(job_path) if job_path.is_dir() else None
        if result_path is None or not result_is_complete(result_path):
            reconciled.append(row)
            continue
        rebuilt = build_row(
            config,
            str(row["task"]),
            str(row["agent"]),
            int(row["admission"]),
            selected=csv_bool(row.get("selected")),
            recovered=csv_bool(row.get("recovered")),
            result_path=result_path,
            elapsed=float(row.get("duration_seconds") or 0),
        )
        reconciled.append(rebuilt)
        changed += 1
    if rows:
        write_csv(path, reconciled)
    return changed


def reconcile(config: dict[str, Any], paths: Paths) -> None:
    task_difficulty.setup = paths.dataset
    admissions_changed = reconcile_csv(config, paths.admissions_csv)
    selected_changed = reconcile_csv(config, paths.selected_csv)
    append_jsonl(
        paths.ledger,
        {
            "event": "reconciled",
            "at": utc_now(),
            "admissions_changed": admissions_changed,
            "selected_changed": selected_changed,
        },
    )
    print(
        f"reconciled {admissions_changed} admission rows and "
        f"{selected_changed} selected rows"
    )


def next_admission_for_cell(
    task: str,
    agent: str,
    admissions: list[dict[str, Any]],
    selected_by_key: dict[tuple[str, str], dict[str, Any]],
    max_admissions: int,
) -> int | None:
    key = (task, agent)
    previous_attempts = [
        row for row in admissions if (row["task"], row["agent"]) == key
    ]
    next_admission = 1 + max(
        (int(row["admission"]) for row in previous_attempts),
        default=0,
    )
    previous_selected = selected_by_key.get(key)
    if previous_selected is not None and (
        not is_retryable(previous_selected) or next_admission > max_admissions
    ):
        return None
    return next_admission


def run_cell(config: dict[str, Any], paths: Paths, task: str, agent: str, admission: int) -> dict[str, Any]:
    command, job_dir = agent_command(agent, task, admission, config, paths)
    job_dir.mkdir(parents=True, exist_ok=True)
    append_jsonl(paths.ledger, {
        "event": "started",
        "at": utc_now(),
        "task": task,
        "agent": agent,
        "admission": admission,
        "command": safe_command(command),
        "harness_sha256": config.get("harness_sha256", {}),
    })
    log_progress(
        paths,
        "cell_started",
        task=task,
        agent=agent,
        admission=admission,
        job_path=str(job_dir),
    )
    env = harbor_environment(agent, config)
    started = time.monotonic()
    runner_exception: tuple[str, str] | None = None
    try:
        with (job_dir / "harbor.stdout.log").open("w", encoding="utf-8", errors="replace") as stdout, (
            job_dir / "harbor.stderr.log"
        ).open("w", encoding="utf-8", errors="replace") as stderr:
            process = subprocess.Popen(
                command,
                cwd=ROOT,
                env=env,
                stdout=stdout,
                stderr=stderr,
            )
            outer_timeout = int(config["outer_timeout_seconds"])
            while process.poll() is None:
                remaining = outer_timeout - (time.monotonic() - started)
                if remaining <= 0:
                    process.kill()
                    process.wait()
                    raise subprocess.TimeoutExpired(command, outer_timeout)
                try:
                    process.wait(timeout=min(30, remaining))
                except subprocess.TimeoutExpired:
                    log_progress(
                        paths,
                        "cell_heartbeat",
                        task=task,
                        agent=agent,
                        admission=admission,
                        elapsed_seconds=round(time.monotonic() - started, 1),
                        job_path=str(job_dir),
                    )
        result_path = newest_result(job_dir)
        if process.returncode != 0:
            runner_exception = ("HarborProcessError", f"harbor exited with {process.returncode}")
        elif result_path is None:
            runner_exception = ("HarborMissingResultError", "harbor exited without a result")
        elif not result_is_complete(result_path):
            runner_exception = ("HarborIncompleteResultError", "harbor exited with an incomplete result")
    except subprocess.TimeoutExpired:
        runner_exception = ("RunnerOuterTimeoutError", "runner outer timeout expired")
    elapsed = time.monotonic() - started
    result_path = newest_result(job_dir)
    row = build_row(
        config,
        task,
        agent,
        admission,
        selected=False,
        recovered=admission > 1,
        result_path=result_path,
        elapsed=elapsed,
        runner_exception=runner_exception,
    )
    append_jsonl(paths.ledger, {"event": "completed", "at": utc_now(), **row})
    log_progress(
        paths,
        "cell_completed",
        task=task,
        agent=agent,
        admission=admission,
        passed=row["passed"],
        reward=row["reward"],
        failure_class=row["failure_class"],
        budget_exhausted=row["budget_exhausted"],
        duration_seconds=row["duration_seconds"],
        estimated_cost_usd=row["estimated_cost_usd"],
        uncached_input_tokens=row["uncached_input_tokens"],
        cache_read_tokens=row["cache_read_tokens"],
        output_tokens=row["output_tokens"],
        exception_type=row["exception_type"],
        job_path=row["job_path"],
    )
    return row


def run_cell_admissions(
    config: dict[str, Any],
    paths: Paths,
    cell: PendingCell,
) -> list[dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    for admission in range(cell.next_admission, cell.max_admissions + 1):
        row = run_cell(config, paths, cell.task, cell.agent, admission)
        attempts.append(row)
        if not is_retryable(row):
            break
        log_progress(
            paths,
            "infrastructure_retry",
            task=cell.task,
            agent=cell.agent,
            completed_admission=admission,
            next_admission=admission + 1,
            failure_class=row["failure_class"],
            exception_type=row["exception_type"],
        )
    return attempts


def execute(config: dict[str, Any], paths: Paths, task_limit: int | None) -> None:
    ensure_preflight()
    frozen_path = paths.run / "frozen_setup.json"
    if not frozen_path.is_file():
        prepare(config, paths)
    frozen = read_json(frozen_path)
    config = frozen
    harbor_egress_policy = ensure_harbor_egress_compatibility()
    if (
        harbor_egress_policy["policy_sha256"]
        != frozen["harbor_egress_policy"]["policy_sha256"]
    ):
        raise RuntimeError("Harbor egress policy changed after setup was frozen")
    bundle = ROOT / "out" / "headless" / "nova-headless.cjs"
    prompt = ROOT / "out" / "headless" / "prompts" / "base-rules.md"
    if not bundle.is_file() or hashlib.sha256(bundle.read_bytes()).hexdigest() != frozen["nova_bundle_sha256"]:
        raise RuntimeError("Nova headless bundle changed after setup was frozen; prepare a new run")
    if not prompt.is_file() or hashlib.sha256(prompt.read_bytes()).hexdigest() != frozen["nova_prompt_sha256"]:
        raise RuntimeError("Nova prompt changed after setup was frozen; prepare a new run")
    for relative, expected in frozen.get("harness_sha256", {}).items():
        if file_sha256(ROOT / relative) != expected:
            raise RuntimeError(f"Harness source changed after setup was frozen: {relative}")
    node_archive = Path(frozen["node_runtime"]["archive_path"])
    if (
        not node_archive.is_file()
        or file_sha256(node_archive) != frozen["node_runtime"]["archive_sha256"]
    ):
        raise RuntimeError("Pinned Node runtime archive is missing or changed after setup was frozen")
    task_difficulty.setup = paths.dataset
    tasks = list(frozen["tasks"])
    if task_limit is not None:
        tasks = tasks[:task_limit]

    admissions = read_csv_rows(paths.admissions_csv)
    selected = read_csv_rows(paths.selected_csv)
    selected_by_key = {(row["task"], row["agent"]): row for row in selected}
    spent = sum(float(row.get("estimated_cost_usd") or 0) for row in admissions)
    agents = list(config.get("active_agents") or config["agents"].keys())
    unknown_agents = set(agents) - set(config["agents"])
    if not agents or unknown_agents:
        raise RuntimeError(f"invalid active_agents: {agents}")
    concurrency = validate_execution_shape(config)
    total_cells = len(tasks) * len(agents)
    write_progress_snapshot(paths, selected, total_cells)
    log_progress(
        paths,
        "run_started",
        completed_cells=len(selected),
        total_cells=total_cells,
        agents=agents,
        task_limit=task_limit,
    )

    cell_order: list[tuple[str, str]] = []
    pending_cells: list[PendingCell] = []
    for index, task in enumerate(tasks):
        order = agents[index % len(agents):] + agents[:index % len(agents)]
        for agent in order:
            cell_order.append((task, agent))
            key = (task, agent)
            max_admissions = 1 + int(config["infra_retry_limit"])
            next_admission = next_admission_for_cell(
                task,
                agent,
                admissions,
                selected_by_key,
                max_admissions,
            )
            if next_admission is None:
                continue
            pending_cells.append(
                PendingCell(
                    task=task,
                    agent=agent,
                    next_admission=next_admission,
                    max_admissions=max_admissions,
                )
            )

    cell_rank = {key: index for index, key in enumerate(cell_order)}

    def row_order(row: dict[str, Any]) -> tuple[int, int]:
        key = (str(row["task"]), str(row["agent"]))
        return cell_rank.get(key, len(cell_rank)), int(row["admission"])

    def record_attempts(cell: PendingCell, attempts: list[dict[str, Any]]) -> None:
        nonlocal admissions, selected, spent
        if not attempts:
            raise RuntimeError(f"cell returned no admissions: {cell.task}/{cell.agent}")
        admissions.extend(attempts)
        admissions.sort(key=row_order)
        spent += sum(float(row["estimated_cost_usd"]) for row in attempts)
        write_csv(paths.admissions_csv, admissions)

        key = (cell.task, cell.agent)
        chosen = dict(attempts[-1])
        chosen["selected"] = True
        chosen["recovered"] = chosen["admission"] > 1 and not is_retryable(chosen)
        selected = [row for row in selected if (row["task"], row["agent"]) != key]
        selected.append(chosen)
        selected.sort(key=row_order)
        selected_by_key[key] = chosen
        write_csv(paths.selected_csv, selected)
        write_progress_snapshot(paths, selected, total_cells)
        try:
            try:
                from scripts.harness_eval.report import generate
            except ModuleNotFoundError as error:
                if error.name != "scripts":
                    raise
                from report import generate

            generate(paths.run)
            log_progress(
                paths,
                "report_updated",
                completed_cells=len(selected),
                total_cells=total_cells,
                report_path=str(paths.run / "report.md"),
            )
        except Exception as error:
            log_progress(
                paths,
                "report_update_failed",
                completed_cells=len(selected),
                error_type=type(error).__name__,
                error_message=str(error),
            )

    cost_limit = float(config["max_total_estimated_cost_usd"])
    if concurrency == 1:
        for cell in pending_cells:
            if spent >= cost_limit:
                raise RuntimeError(f"cost circuit breaker reached: ${spent:.4f}")
            record_attempts(cell, run_cell_admissions(config, paths, cell))
    else:
        next_cell = 0
        futures: dict[Future[list[dict[str, Any]]], PendingCell] = {}
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            while (
                next_cell < len(pending_cells)
                and len(futures) < concurrency
                and spent < cost_limit
            ):
                cell = pending_cells[next_cell]
                next_cell += 1
                futures[executor.submit(run_cell_admissions, config, paths, cell)] = cell

            while futures:
                completed, _pending = wait(tuple(futures), return_when=FIRST_COMPLETED)
                for future in sorted(
                    completed,
                    key=lambda item: cell_rank[(futures[item].task, futures[item].agent)],
                ):
                    cell = futures.pop(future)
                    record_attempts(cell, future.result())
                while (
                    next_cell < len(pending_cells)
                    and len(futures) < concurrency
                    and spent < cost_limit
                ):
                    cell = pending_cells[next_cell]
                    next_cell += 1
                    futures[executor.submit(run_cell_admissions, config, paths, cell)] = cell

        if next_cell < len(pending_cells):
            raise RuntimeError(f"cost circuit breaker reached: ${spent:.4f}")
    log_progress(
        paths,
        "run_completed",
        completed_cells=len(selected),
        total_cells=total_cells,
        results_path=str(paths.selected_csv),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run paired Terminal-Bench harness cells")
    parser.add_argument("action", choices=["prepare", "run", "reconcile"])
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--eval-root", type=Path, default=default_eval_root())
    parser.add_argument("--task-limit", type=int)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = read_json(args.config.resolve())
    # dataset.manifest 在进入路径解析前合并（revision/slug 决定数据集目录位置）
    config = {**config, "dataset": resolve_dataset_config(config)}
    paths = resolve_paths(config, args.eval_root.expanduser().resolve())
    if args.action == "reconcile":
        frozen_path = paths.run / "frozen_setup.json"
        reconcile(read_json(frozen_path) if frozen_path.is_file() else config, paths)
        return
    if args.action == "prepare":
        tasks = prepare(config, paths)
        print(f"prepared {len(tasks)} tasks at {paths.run}")
        return
    execute(config, paths, args.task_limit)
    print(f"results written to {paths.selected_csv}")


if __name__ == "__main__":
    main()
