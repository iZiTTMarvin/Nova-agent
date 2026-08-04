from __future__ import annotations

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.opencode import OpenCode
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment

from scripts.harness_eval.install_network import (
    prepare_install_network,
    proxy_environment,
    restore_install_network,
)


class _InstallNetworkMixin:
    def __init__(
        self,
        *args,
        install_proxy_url: str,
        ubuntu_archive_mirror: str,
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._install_proxy_url = install_proxy_url
        self._ubuntu_archive_mirror = ubuntu_archive_mirror

    async def _prepare_install_network(self, environment: BaseEnvironment) -> None:
        await prepare_install_network(
            self,
            environment,
            self._install_proxy_url,
            self._ubuntu_archive_mirror,
        )

    async def _restore_install_network(self, environment: BaseEnvironment) -> None:
        await restore_install_network(self, environment)


class OpenCodeComparison(_InstallNetworkMixin, OpenCode):
    async def install(self, environment: BaseEnvironment) -> None:
        with environment.scoped_exec_env(proxy_environment(self._install_proxy_url)):
            await self._prepare_install_network(environment)
            try:
                await super().install(environment)
            finally:
                await self._restore_install_network(environment)


class ClaudeCodeComparison(_InstallNetworkMixin, ClaudeCode):
    async def install(self, environment: BaseEnvironment) -> None:
        with environment.scoped_exec_env(proxy_environment(self._install_proxy_url)):
            await self._prepare_install_network(environment)
            try:
                await self.exec_as_root(
                    environment,
                    command=(
                        "if command -v apk &> /dev/null; then "
                        "apk add --no-cache curl bash nodejs npm procps; "
                        "elif command -v apt-get &> /dev/null; then "
                        "apt-get update && apt-get install -y curl procps; "
                        "elif command -v yum &> /dev/null; then "
                        "yum install -y curl procps-ng; "
                        "else echo 'Unsupported package manager' >&2; exit 1; fi"
                    ),
                    env={"DEBIAN_FRONTEND": "noninteractive"},
                )
                version_spec = f"@{self._version}" if self._version else "@latest"
                await self.exec_as_agent(
                    environment,
                    command=(
                        "set -euo pipefail; "
                        "if command -v npm &> /dev/null; then true; else "
                        f"{nvm_node_install_snippet()}; fi; "
                        "mkdir -p ~/.local/bin ~/.local/lib; "
                        f"npm install -g --prefix ~/.local @anthropic-ai/claude-code{version_spec}; "
                        "ln -sf \"$(command -v node)\" ~/.local/bin/node; "
                        "export PATH=\"$HOME/.local/bin:$PATH\"; claude --version"
                    ),
                )
            finally:
                await self._restore_install_network(environment)
