from __future__ import annotations

import unittest
import csv
import hashlib
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

from scripts.harness_eval.report import exact_mcnemar_p, generate
from scripts.harness_eval.install_network import prepare_command, proxy_environment
from scripts.harness_eval.harbor_egress import apply_loopback_only_local_exemption
from scripts.harness_eval.pier_compat import apply_lf_proxy_script_write
from scripts.harness_eval.nova_agent import _provider_host_entries
from scripts.harness_eval.run_experiment import (
    CSV_FIELDS,
    Paths,
    agent_command,
    build_row,
    classify_failure,
    checkout_dataset_revision,
    estimated_cost,
    ensure_node_runtime_archive,
    execute,
    harbor_environment,
    is_retryable,
    newest_result,
    next_admission_for_cell,
    node_runtime_archive_path,
    ordered_task_names,
    provider_hostname,
    resolve_provider_ipv4_addresses,
    resolve_dataset_config,
    result_is_complete,
    token_fields,
    validate_execution_shape,
    validate_deepswe_verifier_entrypoints,
    write_progress_snapshot,
)


class HarnessEvalTests(unittest.TestCase):
    def test_pier_proxy_script_writer_forces_lf_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "agent_setup.py"
            source.write_bytes(
                b"before\r\n"
                b'    (proxy_dir / "start-squid.sh").write_text('
                b"squid_bootstrap_command())\r\n"
                b"after\r\n"
            )

            self.assertTrue(apply_lf_proxy_script_write(source))
            patched = source.read_bytes()
            self.assertIn(b'squid_bootstrap_command(), newline="\\n"', patched)
            self.assertFalse(apply_lf_proxy_script_write(source))

    def test_pier_proxy_script_writer_rejects_unknown_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "agent_setup.py"
            source.write_text("unknown layout", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "unsupported Pier proxy writer"):
                apply_lf_proxy_script_write(source)

    def test_dataset_checkout_restores_unix_line_endings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "dataset"
            subprocess.run(["git", "init", str(repository)], check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", str(repository), "config", "user.email", "eval@example.invalid"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(repository), "config", "user.name", "Harness Eval"],
                check=True,
            )
            script = repository / "tasks" / "task-a" / "tests" / "test.sh"
            script.parent.mkdir(parents=True)
            script.write_bytes(b"#!/bin/bash\necho ok\n")
            subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
            subprocess.run(
                ["git", "-C", str(repository), "commit", "-m", "fixture"],
                check=True,
                capture_output=True,
            )
            revision = subprocess.run(
                ["git", "-C", str(repository), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            script.write_bytes(b"#!/bin/bash\r\necho ok\r\n")

            checkout_dataset_revision(repository, revision)

            self.assertEqual(script.read_bytes(), b"#!/bin/bash\necho ok\n")
            self.assertEqual(
                subprocess.run(
                    ["git", "-C", str(repository), "config", "--get", "core.autocrlf"],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                "false",
            )

    def test_deepswe_verifier_preflight_rejects_crlf_shebang(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks"
            script = tasks / "task-a" / "tests" / "test.sh"
            script.parent.mkdir(parents=True)
            script.write_bytes(b"#!/bin/bash\r\necho broken\r\n")

            with self.assertRaisesRegex(RuntimeError, "Unix line endings.*task-a"):
                validate_deepswe_verifier_entrypoints(tasks, ["task-a"])

            script.write_bytes(b"#!/bin/bash\necho ok\n")
            validate_deepswe_verifier_entrypoints(tasks, ["task-a"])

    def test_harbor_egress_compatibility_is_stricter_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / "network-policy"
            policy.write_bytes(
                b"meta mark 1 return\n"
                b"    fib daddr type local return\n"
                b"meta mark 1 accept\n"
                b"    fib daddr type local accept\n"
                b"    ip6 nexthdr icmpv6 accept\n"
                b"    meta l4proto != tcp reject\n"
            )

            self.assertTrue(apply_loopback_only_local_exemption(policy))
            patched = policy.read_text(encoding="utf-8")
            self.assertNotIn("fib daddr", patched)
            self.assertIn("ip daddr 127.0.0.0/8 return", patched)
            self.assertIn("ip6 daddr ::1 accept", patched)
            self.assertIn("ip daddr 127.0.0.11 udp dport 53 accept", patched)
            self.assertNotIn("\n    udp dport 53 accept", patched)
            self.assertIn("meta l4proto != tcp reject", patched)
            self.assertFalse(apply_loopback_only_local_exemption(policy))

    def test_harbor_egress_compatibility_replaces_legacy_unbounded_dns(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / "network-policy"
            policy.write_bytes(
                b"    ip daddr 127.0.0.0/8 return\n"
                b"    ip6 daddr ::1 return\n"
                b"    ip daddr 127.0.0.0/8 accept\n"
                b"    ip6 daddr ::1 accept\n"
                b"    ip6 nexthdr icmpv6 accept\n"
                b"    udp dport 53 accept\n"
                b"    meta l4proto != tcp reject\n"
            )

            self.assertTrue(apply_loopback_only_local_exemption(policy))
            patched = policy.read_text(encoding="utf-8")
            self.assertIn("ip daddr 127.0.0.11 udp dport 53 accept", patched)
            self.assertNotIn("\n    udp dport 53 accept", patched)
            self.assertFalse(apply_loopback_only_local_exemption(policy))

    def test_provider_host_is_https_and_credential_free(self) -> None:
        self.assertEqual(
            provider_hostname("https://opencode.ai/zen/go/v1"),
            "opencode.ai",
        )
        for invalid in (
            "http://opencode.ai/v1",
            "https://token@opencode.ai/v1",
            "https://opencode.ai/v1?token=secret",
            "https://opencode.ai/v1#token=secret",
            "not-a-url",
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTPS URL"):
                provider_hostname(invalid)

    def test_provider_addresses_are_frozen_to_public_ipv4(self) -> None:
        records = [
            (2, 1, 6, "", ("198.20.0.64", 443)),
            (2, 1, 6, "", ("198.20.0.64", 443)),
            (2, 1, 6, "", ("198.20.0.65", 443)),
        ]
        with patch(
            "scripts.harness_eval.run_experiment.socket.getaddrinfo",
            return_value=records,
        ):
            self.assertEqual(
                resolve_provider_ipv4_addresses("https://opencode.ai/zen/go/v1"),
                ["198.20.0.64", "198.20.0.65"],
            )

        private_record = [(2, 1, 6, "", ("192.168.65.7", 443))]
        with (
            patch(
                "scripts.harness_eval.run_experiment.socket.getaddrinfo",
                return_value=private_record,
            ),
            self.assertRaisesRegex(RuntimeError, "public IPv4"),
        ):
            resolve_provider_ipv4_addresses("https://opencode.ai/zen/go/v1")

    def test_nova_provider_hosts_require_matching_public_addresses(self) -> None:
        self.assertEqual(
            _provider_host_entries(
                "https://opencode.ai/zen/go/v1", '["198.20.0.65","198.20.0.64"]'
            ),
            ("198.20.0.64 opencode.ai", "198.20.0.65 opencode.ai"),
        )
        self.assertEqual(
            _provider_host_entries(
                "https://opencode.ai/zen/go/v1", ["198.20.0.64"]
            ),
            ("198.20.0.64 opencode.ai",),
        )
        for addresses in ('["127.0.0.1"]', '["192.168.65.7"]', '[]', '"198.20.0.64"'):
            with self.assertRaisesRegex(ValueError, "public IPv4"):
                _provider_host_entries("https://opencode.ai/zen/go/v1", addresses)

    def test_single_agent_tasks_allow_bounded_parallelism(self) -> None:
        config = {
            "pair_concurrency": 2,
            "arms_parallel": False,
            "active_agents": ["nova"],
            "agents": {"nova": {}},
        }
        self.assertEqual(validate_execution_shape(config), 2)

        config["active_agents"] = ["nova", "opencode"]
        config["agents"]["opencode"] = {}
        with self.assertRaisesRegex(RuntimeError, "exactly one active agent"):
            validate_execution_shape(config)

    def test_execute_never_exceeds_configured_task_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            bundle = source / "out" / "headless" / "nova-headless.cjs"
            prompt = source / "out" / "headless" / "prompts" / "base-rules.md"
            prompt.parent.mkdir(parents=True)
            bundle.write_bytes(b"bundle")
            prompt.write_bytes(b"prompt")
            node_archive = root / "node.tar.gz"
            node_archive.write_bytes(b"node")

            dataset = root / "dataset"
            task_names = ["task-a", "task-b", "task-c"]
            for task_name in task_names:
                task = dataset / "tasks" / task_name
                task.mkdir(parents=True)
                (task / "task.toml").write_text(
                    "[agent]\ntimeout_sec = 900.0\n",
                    encoding="utf-8",
                )

            run = root / "run"
            run.mkdir()
            paths = Paths(
                root=root,
                run=run,
                dataset=dataset,
                jobs=run / "jobs",
                ledger=run / "admissions.jsonl",
                selected_csv=run / "results.csv",
                admissions_csv=run / "admissions.csv",
            )
            frozen = {
                "executor": "pier",
                "run_id": "parallel-fixture",
                "tasks": task_names,
                "agents": {"nova": {}},
                "active_agents": ["nova"],
                "pair_concurrency": 2,
                "arms_parallel": False,
                "infra_retry_limit": 0,
                "max_total_estimated_cost_usd": None,
                "dataset": {"slug": "deep-swe"},
                "nova_bundle_sha256": hashlib.sha256(b"bundle").hexdigest(),
                "nova_prompt_sha256": hashlib.sha256(b"prompt").hexdigest(),
                "harness_sha256": {},
                "runner_isolation": {
                    "executor": "pier",
                    "network_policy": "adapter_network_allowlist",
                    "artifact_hook": "task_pre_artifacts",
                    "pier_proxy_compatibility": {
                        "source_sha256": "fixture-pier-policy"
                    },
                },
                "node_runtime": {
                    "archive_path": str(node_archive),
                    "archive_sha256": hashlib.sha256(b"node").hexdigest(),
                },
            }
            (run / "frozen_setup.json").write_text(
                json.dumps(frozen),
                encoding="utf-8",
            )

            active = 0
            max_active = 0
            guard = threading.Lock()

            def fake_run_cell_admissions(_config, _paths, cell):
                nonlocal active, max_active
                with guard:
                    active += 1
                    max_active = max(max_active, active)
                try:
                    time.sleep(0.08 if cell.task == "task-a" else 0.02)
                    row = {field: "" for field in CSV_FIELDS}
                    row.update(
                        {
                            "run_id": "parallel-fixture",
                            "task": cell.task,
                            "difficulty": "unknown",
                            "agent": cell.agent,
                            "admission": cell.next_admission,
                            "selected": False,
                            "recovered": False,
                            "passed": True,
                            "reward": 1.0,
                            "failure_class": "pass",
                            "budget_exhausted": False,
                            "estimated_cost_usd": 0.01,
                            "exception_type": "",
                            "exception_message": "",
                            "job_path": str(root / cell.task),
                        }
                    )
                    return [row]
                finally:
                    with guard:
                        active -= 1

            with (
                patch("scripts.harness_eval.run_experiment.ROOT", source),
                patch("scripts.harness_eval.run_experiment.ensure_preflight"),
                patch(
                    "scripts.harness_eval.run_experiment.ensure_harbor_egress_compatibility",
                    return_value={"policy_sha256": "fixture-policy"},
                ),
                patch(
                    "scripts.harness_eval.run_experiment.ensure_pier_proxy_compatibility",
                    return_value={"source_sha256": "fixture-pier-policy"},
                ),
                patch(
                    "scripts.harness_eval.run_experiment.run_cell_admissions",
                    side_effect=fake_run_cell_admissions,
                ),
                patch("scripts.harness_eval.report.generate"),
            ):
                execute({}, paths, task_limit=None)

            self.assertEqual(max_active, 2)
            with paths.selected_csv.open(encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([row["task"] for row in rows], task_names)

    def test_exact_mcnemar_matches_reference_case(self) -> None:
        self.assertAlmostEqual(exact_mcnemar_p(16, 4), 0.01181793212890625)

    def test_budget_exhaustion_is_not_infrastructure_retry(self) -> None:
        row = {"exception_type": "AgentTimeoutError", "budget_exhausted": True}
        self.assertFalse(is_retryable(row))
        self.assertEqual(
            classify_failure(
                {"exception_info": {"exception_type": "AgentTimeoutError"}},
                reward=None,
                budget=True,
            ),
            "budget_exhausted",
        )

    def test_transient_provider_failure_gets_one_retry_admission(self) -> None:
        row = {"exception_type": "ApiOverloadedError", "budget_exhausted": False}
        self.assertTrue(is_retryable(row))

    def test_generic_setup_failure_is_retryable_after_csv_round_trip(self) -> None:
        trial = {
            "agent_setup": {
                "started_at": "2026-08-03T00:00:00Z",
                "finished_at": "2026-08-03T00:00:01Z",
            },
            "agent_execution": None,
            "exception_info": {"exception_type": "NonZeroAgentExitCodeError"},
        }
        failure = classify_failure(trial, reward=None, budget=False)
        self.assertEqual(failure, "agent_setup_infra")
        self.assertTrue(
            is_retryable(
                {
                    "exception_type": "NonZeroAgentExitCodeError",
                    "failure_class": failure,
                    "budget_exhausted": "False",
                }
            )
        )

    def test_resume_continues_with_second_infrastructure_admission(self) -> None:
        row = {
            "task": "fixture",
            "agent": "nova",
            "admission": "1",
            "exception_type": "NonZeroAgentExitCodeError",
            "failure_class": "agent_setup_infra",
            "budget_exhausted": "False",
        }
        self.assertEqual(
            next_admission_for_cell(
                "fixture",
                "nova",
                [row],
                {("fixture", "nova"): row},
                max_admissions=2,
            ),
            2,
        )

    def test_incomplete_harbor_result_gets_infrastructure_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            result_path.write_text(json.dumps({"finished_at": None}), encoding="utf-8")
            self.assertFalse(result_is_complete(result_path))
        row = {"exception_type": "HarborIncompleteResultError", "budget_exhausted": False}
        self.assertTrue(is_retryable(row))

    def test_trial_result_is_preferred_over_completed_job_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job_dir = Path(directory)
            outer = job_dir / "result.json"
            outer.write_text(
                json.dumps({"finished_at": "2026-08-03T00:00:00Z", "stats": {}}),
                encoding="utf-8",
            )
            trial_dir = job_dir / "task__trial"
            trial_dir.mkdir()
            trial = trial_dir / "result.json"
            trial.write_text(
                json.dumps(
                    {
                        "task_name": "terminal-bench/task",
                        "agent_info": {"name": "nova-headless"},
                        "finished_at": "2026-08-03T00:00:00Z",
                        "exception_info": {"exception_type": "AgentTimeoutError"},
                        "verifier_result": {"rewards": {"reward": 0.0}},
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(newest_result(job_dir), trial)
            self.assertFalse(result_is_complete(outer))
            self.assertTrue(result_is_complete(trial))

    def test_event_usage_recovers_tokens_when_timeout_prevents_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job_dir = Path(directory)
            events = job_dir / "agent" / "events.jsonl"
            events.parent.mkdir()
            events.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "usage",
                                "usage": {
                                    "uncachedInputTokens": 10,
                                    "cacheReadTokens": 20,
                                    "cacheWriteTokens": 3,
                                    "outputTokens": 4,
                                },
                            }
                        ),
                        json.dumps({"type": "tool_call", "toolName": "bash"}),
                        json.dumps(
                            {
                                "type": "usage",
                                "usage": {
                                    "uncachedInputTokens": 5,
                                    "cacheReadTokens": 30,
                                    "cacheWriteTokens": 0,
                                    "outputTokens": 6,
                                },
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            trial = {
                "agent_result": {
                    "n_input_tokens": None,
                    "n_cache_tokens": None,
                    "n_output_tokens": None,
                    "cost_usd": None,
                }
            }

            self.assertEqual(token_fields(trial, job_dir), (15, 50, 3, 10, None))

    def test_harbor_environment_exposes_custom_agent_module_and_claude_endpoint(self) -> None:
        env = harbor_environment(
            "claude_code",
            {"reasoning_effort": "max"},
            {"DEEPSEEK_API_KEY": "test-key", "PYTHONPATH": "existing"},
        )
        self.assertEqual(env["PYTHONPATH"].split(os.pathsep), [str(Path.cwd()), "existing"])
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "test-key")
        self.assertEqual(env["CLAUDE_CODE_EFFORT_LEVEL"], "max")
        self.assertEqual(env["PYTHONUTF8"], "1")
        self.assertEqual(env["PYTHONIOENCODING"], "utf-8")

    def test_nova_deadline_uses_task_timeout_with_frozen_grace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "dataset"
            task_dir = dataset / "tasks" / "fixture"
            task_dir.mkdir(parents=True)
            (task_dir / "task.toml").write_text(
                "[agent]\ntimeout_sec = 900.0\n",
                encoding="utf-8",
            )
            paths = Paths(
                root=root,
                run=root / "run",
                dataset=dataset,
                jobs=root / "run" / "jobs",
                ledger=root / "run" / "admissions.jsonl",
                selected_csv=root / "run" / "results.csv",
                admissions_csv=root / "run" / "admissions.csv",
            )
            config = {
                "executor": "pier",
                "timeout_multiplier": 1.0,
                "agent_setup_timeout_multiplier": 1.0,
                "model": "deepseek-v4-flash",
                "base_url": "https://provider.example/v1",
                "provider_network": {
                    "hostname": "provider.example",
                    "ipv4_addresses": ["198.20.0.64", "198.20.0.65"],
                },
                "reasoning_effort": "max",
                "max_tool_rounds": None,
                "agent_deadline_grace_seconds": 15,
                "install_network": {
                    "proxy_url": "http://proxy",
                    "ubuntu_archive_mirror": "http://mirror",
                },
                "node_runtime": {
                    "archive_filename": "node-runtime.tar.gz",
                },
                "agents": {"nova": {"version": "workspace"}},
            }

            command, _ = agent_command("nova", "fixture", 1, config, paths)

            self.assertEqual(command[:2], ["pier", "run"])
            self.assertIn("--agent-import-path", command)
            self.assertEqual(
                command[command.index("-p") + 1],
                str(task_dir),
            )
            self.assertIn("--yes", command)
            self.assertIn("deadline_seconds=885", command)
            self.assertFalse(
                any(value.startswith("max_tool_rounds=") for value in command)
            )
            self.assertIn("base_url=https://provider.example/v1", command)
            self.assertFalse(
                any(value.startswith("install_proxy_url=") for value in command)
            )
            self.assertNotIn("--allow-agent-host", command)
            self.assertIn(
                'provider_addresses=["198.20.0.64","198.20.0.65"]',
                command,
            )
            self.assertIn(
                f"node_archive_path={root / 'cache' / 'node-runtime.tar.gz'}",
                command,
            )

            config["max_tool_rounds"] = 250
            capped_command, _ = agent_command("nova", "fixture", 1, config, paths)
            self.assertIn("max_tool_rounds=250", capped_command)

    def test_deepswe_rejects_harbor_executor(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "DeepSWE requires executor=pier"):
            validate_execution_shape(
                {
                    "dataset": {"slug": "deep-swe"},
                    "executor": "harbor",
                    "pair_concurrency": 1,
                    "arms_parallel": False,
                    "active_agents": ["nova"],
                    "agents": {"nova": {"version": "workspace"}},
                }
            )

    def test_deepswe_non_binary_reward_is_verifier_infrastructure(self) -> None:
        config = {
            "run_id": "fixture",
            "dataset": {"slug": "deep-swe"},
            "pricing_usd_per_million": {
                "uncached_input": 0.14,
                "cached_input": 0.0028,
                "cache_write": 0.0,
                "output": 0.28,
                "multiplier": 1.0,
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "task_name": "deep-swe/fixture",
                        "agent_info": {"name": "nova-headless"},
                        "finished_at": "2026-08-03T00:00:00Z",
                        "verifier_result": {"rewards": {"reward": -1}},
                    }
                ),
                encoding="utf-8",
            )

            row = build_row(
                config,
                "fixture",
                "nova",
                1,
                selected=False,
                recovered=False,
                result_path=result_path,
                elapsed=1.0,
            )

        self.assertEqual(row["reward"], "")
        self.assertEqual(row["passed"], "")
        self.assertEqual(row["failure_class"], "verifier_infra")
        self.assertEqual(row["exception_type"], "VerifierInvalidRewardError")
        self.assertTrue(is_retryable(row))

    def test_pinned_node_runtime_uses_verified_local_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content = b"pinned node runtime fixture"
            digest = hashlib.sha256(content).hexdigest()
            config = {
                "node_runtime": {
                    "archive_url": "https://nodejs.org/dist/fixture/node-runtime.tar.gz",
                    "archive_filename": "node-runtime.tar.gz",
                    "archive_sha256": digest,
                }
            }
            paths = Paths(
                root=root,
                run=root / "run",
                dataset=root / "dataset",
                jobs=root / "run" / "jobs",
                ledger=root / "run" / "admissions.jsonl",
                selected_csv=root / "run" / "results.csv",
                admissions_csv=root / "run" / "admissions.csv",
            )
            archive = node_runtime_archive_path(config, paths)
            archive.parent.mkdir(parents=True)
            archive.write_bytes(content)

            self.assertEqual(ensure_node_runtime_archive(config, paths), archive)

    def test_task_order_prioritizes_shorter_official_timeouts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory)
            for name, timeout in (("slow", 3600), ("fast-b", 900), ("fast-a", 900)):
                task = tasks / name
                task.mkdir()
                (task / "task.toml").write_text(
                    f"[agent]\ntimeout_sec = {timeout}\n",
                    encoding="utf-8",
                )

            self.assertEqual(
                ordered_task_names(tasks),
                ["fast-a", "fast-b", "slow"],
            )

    def test_ordered_task_names_filters_selected_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory)
            for name, timeout in (("slow", 3600), ("fast-b", 900), ("fast-a", 900)):
                task = tasks / name
                task.mkdir()
                (task / "task.toml").write_text(
                    f"[agent]\ntimeout_sec = {timeout}\n",
                    encoding="utf-8",
                )

            self.assertEqual(
                ordered_task_names(tasks, selected_ids=["slow", "fast-a"]),
                ["fast-a", "slow"],
            )

    def test_ordered_task_names_rejects_unknown_selected_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory)
            (tasks / "task-a").mkdir()
            (tasks / "task-a" / "task.toml").write_text(
                "[agent]\ntimeout_sec = 900.0\n",
                encoding="utf-8",
            )
            with self.assertRaises(RuntimeError):
                ordered_task_names(tasks, selected_ids=["task-a", "nope"])

    def test_resolve_dataset_config_merges_deepswe_manifest(self) -> None:
        config = {
            "dataset": {
                "manifest": "deepswe_subset30.json",
                "task_count": 30,
            }
        }
        dataset = resolve_dataset_config(config)
        self.assertEqual(dataset["label"], "DeepSWE subset-30")
        self.assertEqual(dataset["slug"], "deep-swe")
        self.assertEqual(
            dataset["revision"],
            "6db64a40f3318d8659238ff34a8cc4b491c49205",
        )
        self.assertEqual(len(dataset["task_ids"]), 30)
        # 内联字段覆盖 manifest 同名字段
        config = {"dataset": {"manifest": "deepswe_subset30.json", "task_count": 30, "task_ids": ["only-one"]}}
        self.assertEqual(resolve_dataset_config(config)["task_ids"], ["only-one"])

    def test_deepswe_full_manifest_has_113_tasks(self) -> None:
        full = resolve_dataset_config({"dataset": {"manifest": "deepswe_full113.json"}})
        self.assertEqual(len(full["task_ids"]), 113)
        # 子集必须是全集的子集
        subset = resolve_dataset_config({"dataset": {"manifest": "deepswe_subset30.json"}})
        full_ids = set(full["task_ids"])
        for task_id in subset["task_ids"]:
            self.assertIn(task_id, full_ids)
        self.assertEqual(len(set(full["task_ids"])), 113)

    def test_install_network_is_scoped_and_restorable(self) -> None:
        command = prepare_command(
            "http://http.docker.internal:3128",
            "http://free.nchc.org.tw/ubuntu",
        )
        self.assertIn("Components: main", command)
        self.assertIn("nova-harness-ubuntu.sources", command)
        self.assertIn("99nova-harness-network", command)
        proxy = proxy_environment("http://http.docker.internal:3128/")
        self.assertEqual(proxy["HTTPS_PROXY"], "http://http.docker.internal:3128")
        self.assertIn("localhost", proxy["NO_PROXY"])

    def test_uniform_deepseek_cost_formula(self) -> None:
        config = {
            "pricing_usd_per_million": {
                "uncached_input": 0.14,
                "cached_input": 0.0028,
                "cache_write": 0.0,
                "output": 0.28,
                "multiplier": 1.0,
            }
        }
        self.assertAlmostEqual(estimated_cost((1_000_000, 1_000_000, 0, 1_000_000, None), config), 0.4228)

    def test_progress_snapshot_reports_partial_pass_rate_and_cost(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "run"
            run.mkdir()
            paths = Paths(
                root=root,
                run=run,
                dataset=root / "dataset",
                jobs=run / "jobs",
                ledger=run / "admissions.jsonl",
                selected_csv=run / "results.csv",
                admissions_csv=run / "admissions.csv",
            )
            write_progress_snapshot(
                paths,
                [
                    {
                        "passed": True,
                        "estimated_cost_usd": 0.01,
                        "uncached_input_tokens": 10,
                        "cache_read_tokens": 20,
                        "output_tokens": 3,
                    },
                    {
                        "passed": False,
                        "estimated_cost_usd": 0.02,
                        "uncached_input_tokens": 30,
                        "cache_read_tokens": 40,
                        "output_tokens": 5,
                    },
                ],
                total_cells=10,
            )
            snapshot = json.loads((run / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(snapshot["completed_cells"], 2)
            self.assertEqual(snapshot["passed_cells"], 1)
            self.assertEqual(snapshot["pass_rate"], 0.5)
            self.assertAlmostEqual(snapshot["estimated_cost_usd"], 0.03)

    def test_report_generates_tables_plots_and_checksums(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            setup = {
                "model": "deepseek-v4-flash",
                "reasoning_effort": "max",
                "dataset": {"revision": "test-revision"},
            }
            (run_dir / "frozen_setup.json").write_text(json.dumps(setup), encoding="utf-8")
            (run_dir / "experiment-design.md").write_text("# Fixture\n", encoding="utf-8")
            rows = []
            outcomes = {
                "nova": [True, False],
                "opencode": [False, False],
                "claude_code": [True, True],
            }
            for agent, passes in outcomes.items():
                for index, passed in enumerate(passes):
                    row = {field: "" for field in CSV_FIELDS}
                    row.update(
                        {
                            "run_id": "fixture",
                            "task": f"task-{index}",
                            "difficulty": "easy" if index == 0 else "hard",
                            "agent": agent,
                            "admission": 1,
                            "selected": True,
                            "recovered": False,
                            "passed": passed,
                            "reward": 1 if passed else 0,
                            "failure_class": "pass" if passed else "verifier_fail",
                            "budget_exhausted": False,
                            "uncached_input_tokens": 100,
                            "cache_read_tokens": 50,
                            "cache_write_tokens": 0,
                            "output_tokens": 20,
                            "estimated_cost_usd": 0.01,
                            "duration_seconds": 1.5,
                        }
                    )
                    rows.append(row)
            for name in ("results.csv", "admissions.csv"):
                with (run_dir / name).open("w", encoding="utf-8-sig", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
                    writer.writeheader()
                    writer.writerows(rows)
            generate(run_dir)
            for name in (
                "report.md",
                "per_task_comparison.csv",
                "pass_rate.png",
                "cost_per_pass.png",
                "budget_exhaustion.png",
                "pass_rate_by_difficulty.png",
                "SHA256SUMS",
            ):
                self.assertTrue((run_dir / name).is_file(), name)


if __name__ == "__main__":
    unittest.main()
