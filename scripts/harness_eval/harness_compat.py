from __future__ import annotations

try:
    import pier  # noqa: F401

    from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
    from pier.environments.base import BaseEnvironment
    from pier.models.agent.context import AgentContext
    from pier.models.agent.network import NetworkAllowlist

    IS_PIER = True
except ModuleNotFoundError as error:
    if error.name != "pier":
        raise
    from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext

    NetworkAllowlist = None
    IS_PIER = False


__all__ = [
    "AgentContext",
    "BaseEnvironment",
    "BaseInstalledAgent",
    "IS_PIER",
    "NetworkAllowlist",
    "with_prompt_template",
]
