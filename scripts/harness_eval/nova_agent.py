from __future__ import annotations

import ipaddress
import json
import os
import shlex
import uuid
from pathlib import Path
from typing import override
from urllib.parse import urlsplit

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


def _provider_host_entries(
    base_url: str, encoded_addresses: str | list[str]
) -> tuple[str, ...]:
    parsed = urlsplit(base_url)
    if isinstance(encoded_addresses, str):
        try:
            raw_addresses = json.loads(encoded_addresses)
        except json.JSONDecodeError as error:
            raise ValueError(
                "provider_addresses must contain public IPv4 addresses"
            ) from error
    else:
        raw_addresses = encoded_addresses
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.query)
        or bool(parsed.fragment)
        or not isinstance(raw_addresses, list)
        or not raw_addresses
    ):
        raise ValueError("provider_addresses must contain public IPv4 addresses")
    try:
        addresses = sorted({str(ipaddress.ip_address(value)) for value in raw_addresses})
    except (TypeError, ValueError) as error:
        raise ValueError("provider_addresses must contain public IPv4 addresses") from error
    if any(
        ipaddress.ip_address(value).version != 4
        or not ipaddress.ip_address(value).is_global
        for value in addresses
    ):
        raise ValueError("provider_addresses must contain public IPv4 addresses")
    return tuple(f"{address} {parsed.hostname}" for address in addresses)


class NovaHeadless(BaseInstalledAgent):
    """Run Nova's production AgentLoop without Electron or renderer state."""

    SUPPORTS_ATIF = True

    def __init__(
        self,
        *args,
        bundle_path: str,
        prompt_path: str,
        node_archive_path: str,
        base_url: str,
        provider_addresses: str | list[str],
        reasoning_effort: str = "max",
        max_tool_rounds: int | None = None,
        deadline_seconds: float | None = None,
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._bundle_path = Path(bundle_path).resolve()
        self._prompt_path = Path(prompt_path).resolve()
        self._node_archive_path = Path(node_archive_path).resolve()
        self._base_url = base_url.rstrip("/")
        self._provider_host_entries = _provider_host_entries(
            base_url, provider_addresses
        )
        self._reasoning_effort = reasoning_effort
        if max_tool_rounds is not None and int(max_tool_rounds) < 1:
            raise ValueError("max_tool_rounds must be positive when provided")
        self._max_tool_rounds = (
            None if max_tool_rounds is None else int(max_tool_rounds)
        )
        self._deadline_seconds = deadline_seconds

    @staticmethod
    @override
    def name() -> str:
        return "nova-headless"

    @override
    def get_version_command(self) -> str | None:
        return "/opt/node/bin/node --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._bundle_path.is_file():
            raise FileNotFoundError(f"Nova bundle not found: {self._bundle_path}")
        if not self._prompt_path.is_file():
            raise FileNotFoundError(f"Nova prompt not found: {self._prompt_path}")
        if not self._node_archive_path.is_file():
            raise FileNotFoundError(
                f"Pinned Node runtime archive not found: {self._node_archive_path}"
            )

        await self.exec_as_root(
            environment,
            command="install -d -m 0755 /opt/node /opt/nova /opt/nova/prompts",
        )
        await environment.upload_file(
            str(self._node_archive_path), "/opt/nova/node-runtime.tar.gz"
        )
        await environment.upload_file(
            str(self._bundle_path), "/opt/nova/nova-headless.cjs"
        )
        await environment.upload_file(
            str(self._prompt_path), "/opt/nova/prompts/base-rules.md"
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "tar -xzf /opt/nova/node-runtime.tar.gz "
                "-C /opt/node --strip-components=1; "
                "/opt/node/bin/node --version"
            ),
        )
        entries = " ".join(shlex.quote(value) for value in self._provider_host_entries)
        await self.exec_as_root(
            environment,
            command=f"printf '%s\\n' {entries} >> /etc/hosts",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        api_key = self._get_env("DEEPSEEK_API_KEY") or ""
        if not api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is required")
        if not self.model_name:
            raise RuntimeError("model_name is required")

        instruction_var = f"NOVA_INSTRUCTION_{uuid.uuid4().hex.upper()}"
        env = {
            "DEEPSEEK_API_KEY": api_key,
            instruction_var: instruction,
            "NOVA_VERSION": self.version() or "workspace",
            "NOVA_WIRE_DUMP_DIR": "/logs/agent/wire",
        }
        model = self.model_name.split("/", 1)[-1]
        deadline_arg = (
            f"--deadline-seconds {self._deadline_seconds:g} "
            if self._deadline_seconds is not None
            else ""
        )
        round_limit_arg = (
            f"--max-tool-rounds {self._max_tool_rounds} "
            if self._max_tool_rounds is not None
            else ""
        )
        command = (
            "set -euo pipefail; "
            f'printf "%s" "${{{instruction_var}}}" | '
            "/opt/node/bin/node /opt/nova/nova-headless.cjs "
            "--workdir /app --logs-dir /logs/agent "
            f"--model {shlex.quote(model)} "
            f"--base-url {shlex.quote(self._base_url)} "
            f"--reasoning-effort {shlex.quote(self._reasoning_effort)} "
            f"{round_limit_arg}"
            f"{deadline_arg}"
            "2>&1 | tee /logs/agent/nova-headless.txt"
        )
        await self.exec_as_agent(environment, command=command, env=env, cwd="/app")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        summary_path = self.logs_dir / "summary.json"
        if not summary_path.is_file():
            return
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return

        usage = summary.get("usage") or {}
        uncached = int(usage.get("uncachedInputTokens") or 0)
        cached = int(usage.get("cacheReadTokens") or 0)
        cache_write = int(usage.get("cacheWriteTokens") or 0)
        output = int(usage.get("outputTokens") or 0)
        context.n_input_tokens = uncached + cached
        context.n_cache_tokens = cached
        context.n_output_tokens = output
        context.cost_usd = (
            uncached * 0.14 + cached * 0.0028 + output * 0.28
        ) / 1_000_000
        context.metadata = {
            "reasoning_effort": summary.get("reasoning_effort"),
            "budget_exhausted": bool(summary.get("budget_exhausted")),
            "failure_class": summary.get("failure_class"),
            "cache_write_tokens": cache_write,
        }
