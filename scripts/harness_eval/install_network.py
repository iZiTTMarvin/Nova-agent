from __future__ import annotations

import shlex
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment


class RootExecutor(Protocol):
    async def exec_as_root(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
    ) -> object: ...


def prepare_command(proxy_url: str, ubuntu_archive_mirror: str) -> str:
    proxy = shlex.quote(proxy_url.rstrip("/"))
    mirror = shlex.quote(ubuntu_archive_mirror.rstrip("/") + "/")
    return (
        "set -euo pipefail; "
        f"proxy={proxy}; mirror={mirror}; "
        "if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then "
        "cp /etc/apt/sources.list.d/ubuntu.sources /tmp/nova-harness-ubuntu.sources; "
        "sed -i \"s|http://archive.ubuntu.com/ubuntu/|${mirror}|; "
        "s/^Components:.*/Components: main/\" /etc/apt/sources.list.d/ubuntu.sources; "
        "fi; "
        "if command -v apt-get >/dev/null 2>&1; then "
        "printf '%s\\n' "
        "\"Acquire::http::Proxy \\\"${proxy}\\\";\" "
        "\"Acquire::https::Proxy \\\"${proxy}\\\";\" "
        "\"Acquire::Retries \\\"2\\\";\" "
        "\"Acquire::http::Timeout \\\"30\\\";\" "
        "\"Acquire::https::Timeout \\\"30\\\";\" "
        "> /etc/apt/apt.conf.d/99nova-harness-network; "
        "fi"
    )


def restore_command() -> str:
    return (
        "set -euo pipefail; "
        "if [ -f /tmp/nova-harness-ubuntu.sources ]; then "
        "mv /tmp/nova-harness-ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources; "
        "fi; "
        "rm -f /etc/apt/apt.conf.d/99nova-harness-network"
    )


def proxy_environment(proxy_url: str) -> dict[str, str]:
    proxy = proxy_url.rstrip("/")
    return {
        "HTTP_PROXY": proxy,
        "HTTPS_PROXY": proxy,
        "http_proxy": proxy,
        "https_proxy": proxy,
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
    }


async def prepare_install_network(
    agent: RootExecutor,
    environment: BaseEnvironment,
    proxy_url: str,
    ubuntu_archive_mirror: str,
) -> None:
    await agent.exec_as_root(
        environment,
        command=prepare_command(proxy_url, ubuntu_archive_mirror),
    )


async def restore_install_network(
    agent: RootExecutor,
    environment: BaseEnvironment,
) -> None:
    await agent.exec_as_root(environment, command=restore_command())
