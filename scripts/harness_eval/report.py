from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


TIMEOUT_FAILURES = {"budget_exhausted", "agent_timeout", "runner_outer_timeout"}


def as_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes"}


def as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def as_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def exact_mcnemar_p(left_only: int, right_only: int) -> float:
    discordant = left_only + right_only
    if discordant == 0:
        return 1.0
    tail = sum(math.comb(discordant, index) for index in range(min(left_only, right_only) + 1))
    return min(1.0, 2.0 * tail / (2**discordant))


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    values: list[dict[str, Any]] = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                values.append(value)
    return values


def paired_rows(rows: list[dict[str, str]]) -> tuple[list[str], dict[str, dict[str, dict[str, str]]]]:
    agents = sorted({row["agent"] for row in rows})
    by_task: dict[str, dict[str, dict[str, str]]] = defaultdict(dict)
    for row in rows:
        by_task[row["task"]][row["agent"]] = row
    return agents, dict(by_task)


def agent_metrics(rows: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[row["agent"]].append(row)
    metrics: dict[str, dict[str, Any]] = {}
    for agent, values in sorted(grouped.items()):
        scored = [row for row in values if row.get("reward", "") != ""]
        passed = sum(as_bool(row["passed"]) for row in scored)
        non_timeout = [row for row in scored if row["failure_class"] not in TIMEOUT_FAILURES]
        budget = sum(as_bool(row["budget_exhausted"]) for row in values)
        total_cost = sum(as_float(row["estimated_cost_usd"]) for row in values)
        metrics[agent] = {
            "n": len(values),
            "scored": len(scored),
            "unscored": len(values) - len(scored),
            "passed": passed,
            "pass_rate": passed / len(scored) if scored else 0,
            "non_timeout_n": len(non_timeout),
            "non_timeout_passed": sum(as_bool(row["passed"]) for row in non_timeout),
            "non_timeout_rate": (
                sum(as_bool(row["passed"]) for row in non_timeout) / len(non_timeout)
                if non_timeout
                else 0
            ),
            "budget_count": budget,
            "budget_rate": budget / len(values) if values else 0,
            "cost": total_cost,
            "cost_per_pass": total_cost / passed if passed else None,
            "uncached": sum(as_int(row["uncached_input_tokens"]) for row in values),
            "cached": sum(as_int(row["cache_read_tokens"]) for row in values),
            "cache_write": sum(as_int(row["cache_write_tokens"]) for row in values),
            "output": sum(as_int(row["output_tokens"]) for row in values),
            "duration": sum(as_float(row["duration_seconds"]) for row in values),
        }
    return metrics


def pair_metrics(
    agents: list[str], by_task: dict[str, dict[str, dict[str, str]]]
) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    for left_index, left in enumerate(agents):
        for right in agents[left_index + 1 :]:
            complete = [
                cells
                for cells in by_task.values()
                if left in cells
                and right in cells
                and cells[left].get("reward", "") != ""
                and cells[right].get("reward", "") != ""
            ]
            left_only = sum(
                as_bool(cells[left]["passed"]) and not as_bool(cells[right]["passed"])
                for cells in complete
            )
            right_only = sum(
                as_bool(cells[right]["passed"]) and not as_bool(cells[left]["passed"])
                for cells in complete
            )
            both_pass = sum(
                as_bool(cells[left]["passed"]) and as_bool(cells[right]["passed"])
                for cells in complete
            )
            both_fail = len(complete) - left_only - right_only - both_pass
            pairs.append(
                {
                    "left": left,
                    "right": right,
                    "n": len(complete),
                    "left_only": left_only,
                    "right_only": right_only,
                    "both_pass": both_pass,
                    "both_fail": both_fail,
                    "p": exact_mcnemar_p(left_only, right_only),
                }
            )
    return pairs


def markdown_table(headers: list[str], rows: Iterable[Iterable[Any]]) -> str:
    output = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    output.extend("| " + " | ".join(str(value) for value in row) + " |" for row in rows)
    return "\n".join(output)


def write_per_task(
    output: Path,
    agents: list[str],
    by_task: dict[str, dict[str, dict[str, str]]],
) -> None:
    fields = ["task", "difficulty"]
    for agent in agents:
        fields.extend(
            [
                f"{agent}_passed",
                f"{agent}_failure_class",
                f"{agent}_budget_exhausted",
                f"{agent}_cost_usd",
                f"{agent}_duration_seconds",
            ]
        )
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for task, cells in sorted(by_task.items()):
            difficulty = next((cell.get("difficulty", "unknown") for cell in cells.values()), "unknown")
            row: dict[str, Any] = {"task": task, "difficulty": difficulty}
            for agent in agents:
                cell = cells.get(agent, {})
                row.update(
                    {
                        f"{agent}_passed": cell.get("passed", ""),
                        f"{agent}_failure_class": cell.get("failure_class", "missing"),
                        f"{agent}_budget_exhausted": cell.get("budget_exhausted", ""),
                        f"{agent}_cost_usd": cell.get("estimated_cost_usd", ""),
                        f"{agent}_duration_seconds": cell.get("duration_seconds", ""),
                    }
                )
            writer.writerow(row)


def make_plots(
    output_dir: Path,
    agents: list[str],
    metrics: dict[str, dict[str, Any]],
    by_task: dict[str, dict[str, dict[str, str]]],
) -> list[Path]:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as error:
        raise RuntimeError("matplotlib is required; install requirements.txt") from error

    paths: list[Path] = []

    def bar_plot(values: list[float], ylabel: str, title: str, filename: str, percent: bool = False) -> None:
        fig, axis = plt.subplots(figsize=(7, 4.5))
        bars = axis.bar(agents, values, color=["#4C78A8", "#F58518", "#54A24B"][: len(agents)])
        axis.set_ylabel(ylabel)
        axis.set_title(title)
        if percent:
            axis.set_ylim(0, 1)
            axis.yaxis.set_major_formatter(lambda value, _position: f"{value:.0%}")
        axis.bar_label(bars, labels=[f"{value:.1%}" if percent else f"{value:.4f}" for value in values], padding=3)
        fig.tight_layout()
        path = output_dir / filename
        fig.savefig(path, dpi=180)
        plt.close(fig)
        paths.append(path)

    bar_plot([metrics[a]["pass_rate"] for a in agents], "Pass rate", "Terminal-Bench 2.1 paired pass@1", "pass_rate.png", True)
    bar_plot([metrics[a]["cost_per_pass"] or 0 for a in agents], "USD per pass", "Uniform estimated cost per passing task", "cost_per_pass.png")
    bar_plot([metrics[a]["budget_rate"] for a in agents], "Budget exhaustion rate", "Budget exhaustion", "budget_exhaustion.png", True)

    difficulties = sorted(
        {
            cells[next(iter(cells))].get("difficulty", "unknown")
            for cells in by_task.values()
            if cells
        }
        - {"", "unknown"}
    )
    if difficulties:
        fig, axis = plt.subplots(figsize=(8, 4.8))
        width = 0.8 / len(agents)
        x_positions = list(range(len(difficulties)))
        for index, agent in enumerate(agents):
            rates = []
            for difficulty in difficulties:
                cells = [
                    task_cells[agent]
                    for task_cells in by_task.values()
                    if agent in task_cells
                    and task_cells[agent].get("difficulty") == difficulty
                    and task_cells[agent].get("reward", "") != ""
                ]
                rates.append(sum(as_bool(cell["passed"]) for cell in cells) / len(cells) if cells else 0)
            axis.bar([x + index * width for x in x_positions], rates, width=width, label=agent)
        axis.set_xticks([x + width * (len(agents) - 1) / 2 for x in x_positions], difficulties)
        axis.set_ylim(0, 1)
        axis.set_ylabel("Pass rate")
        axis.yaxis.set_major_formatter(lambda value, _position: f"{value:.0%}")
        axis.set_title("Pass rate by task difficulty")
        axis.legend()
        fig.tight_layout()
        difficulty_path = output_dir / "pass_rate_by_difficulty.png"
        fig.savefig(difficulty_path, dpi=180)
        plt.close(fig)
        paths.append(difficulty_path)
    return paths


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate(run_dir: Path) -> None:
    results_path = run_dir / "results.csv"
    if not results_path.is_file():
        raise RuntimeError(f"results not found: {results_path}")
    rows = read_rows(results_path)
    if not rows:
        raise RuntimeError("results.csv contains no rows")
    agents, by_task = paired_rows(rows)
    metrics = agent_metrics(rows)
    pairs = pair_metrics(agents, by_task)
    admissions_path = run_dir / "admissions.csv"
    admissions = read_rows(admissions_path) if admissions_path.is_file() else []
    recovery = [row for row in admissions if as_int(row.get("admission")) > 1]
    failures = Counter(row["failure_class"] for row in rows)
    setup = json.loads((run_dir / "frozen_setup.json").read_text(encoding="utf-8"))
    audit_events = [
        event
        for event in read_jsonl(run_dir / "admissions.jsonl")
        if event.get("event") in {"reconciled", "user_aborted"}
    ]

    main_table = markdown_table(
        ["Agent", "Pass@1", "Rate", "Selected", "Unscored infra"],
        [
            [
                agent,
                f"{metrics[agent]['passed']}/{metrics[agent]['scored']}",
                f"{metrics[agent]['pass_rate']:.2%}",
                metrics[agent]["n"],
                metrics[agent]["unscored"],
            ]
            for agent in agents
        ],
    )
    pair_table = markdown_table(
        ["Pair", "Left-only", "Right-only", "Both pass", "Both fail", "McNemar exact p"],
        [
            [
                f"{pair['left']} vs {pair['right']}",
                pair["left_only"],
                pair["right_only"],
                pair["both_pass"],
                pair["both_fail"],
                f"{pair['p']:.8f}",
            ]
            for pair in pairs
        ],
    )
    pair_section = (
        f"{pair_table}\n\n"
        "Left-only/right-only are paired task wins. McNemar uses the two-sided exact "
        "binomial test over discordant pairs."
        if pairs
        else "McNemar is omitted because this run has only one active agent."
    )
    audit_lines = []
    for event in audit_events:
        if event.get("event") == "reconciled":
            audit_lines.append(
                "- Reconciled raw Harbor results into CSV: "
                f"{event.get('admissions_changed', 0)} admission rows, "
                f"{event.get('selected_changed', 0)} selected rows."
            )
        elif event.get("event") == "user_aborted":
            audit_lines.append(
                f"- User-aborted cell: {event.get('task')}/{event.get('agent')} "
                f"admission {event.get('admission')}; {event.get('reason', '')}."
            )
    audit_summary = "\n".join(audit_lines) or "- Additional recovery/audit events: none."
    diagnostic_table = markdown_table(
        ["Agent", "Non-timeout pass", "Non-timeout rate", "Budget exhausted", "Budget rate"],
        [
            [
                agent,
                f"{metrics[agent]['non_timeout_passed']}/{metrics[agent]['non_timeout_n']}",
                f"{metrics[agent]['non_timeout_rate']:.2%}",
                f"{metrics[agent]['budget_count']}/{metrics[agent]['n']}",
                f"{metrics[agent]['budget_rate']:.2%}",
            ]
            for agent in agents
        ],
    )
    cost_table = markdown_table(
        ["Agent", "Total USD", "USD/pass", "Uncached input", "Cache read", "Cache write", "Output"],
        [
            [
                agent,
                f"${metrics[agent]['cost']:.6f}",
                "n/a" if metrics[agent]["cost_per_pass"] is None else f"${metrics[agent]['cost_per_pass']:.6f}",
                metrics[agent]["uncached"],
                metrics[agent]["cached"],
                metrics[agent]["cache_write"],
                metrics[agent]["output"],
            ]
            for agent in agents
        ],
    )
    failure_table = markdown_table(["Failure class", "Cells"], sorted(failures.items()))

    report_kind = "comparison" if len(agents) > 1 else "evaluation"
    report = f"""# Terminal-Bench 2.1 harness {report_kind}

Generated from `{results_path.name}`. Model `{setup['model']}`, effort `{setup['reasoning_effort']}`, dataset revision `{setup['dataset']['revision']}`.

Unscored infrastructure-invalid cells are never converted to failures. A final 89-task claim is valid only when every arm has 89 scored cells.

## Main results

{main_table}

{pair_section}

## Diagnostics

{diagnostic_table}

Non-timeout excludes `budget_exhausted`, `agent_timeout`, and `runner_outer_timeout`; it is diagnostic and does not replace the all-task pass@1 result.

{failure_table}

## Cost and tokens

{cost_table}

Cost is recomputed uniformly from the frozen DeepSeek price snapshot, not from harness-reported cost.

## Recovery and exceptions

- Infrastructure retries used: {len(recovery)}.
- Verifier-only replays: 0; the runner never performs them automatically.
- All admissions remain in `admissions.csv` and the append-only `admissions.jsonl`; `results.csv` is the selected projection.
- Recovery cells: {', '.join(f"{row['task']}/{row['agent']} admission {row['admission']}" for row in recovery) or 'none'}.
{audit_summary}

## Artifacts

- Per-task wide comparison: `per_task_comparison.csv`.
- Full local jobs, trajectories, agent logs, verifier logs: `jobs/`.
- Frozen setup and versions: `frozen_setup.json`.
- Checksums: `SHA256SUMS`.
"""
    report_path = run_dir / "report.md"
    report_path.write_text(report, encoding="utf-8")
    per_task_path = run_dir / "per_task_comparison.csv"
    write_per_task(per_task_path, agents, by_task)
    plot_paths = make_plots(run_dir, agents, metrics, by_task)

    checksum_targets = [
        results_path,
        admissions_path,
        run_dir / "frozen_setup.json",
        run_dir / "experiment-design.md",
        run_dir / "REPRODUCING.md",
        report_path,
        per_task_path,
        *plot_paths,
    ]
    checksums = "\n".join(
        f"{sha256_file(path)}  {path.name}" for path in checksum_targets if path.is_file()
    )
    (run_dir / "SHA256SUMS").write_text(checksums + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Terminal-Bench comparison report")
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    generate(args.run_dir.expanduser().resolve())
    print(f"report written to {args.run_dir.expanduser().resolve() / 'report.md'}")


if __name__ == "__main__":
    main()
