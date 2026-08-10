from __future__ import annotations

from scripts.harness_eval.harness_compat import (
    AgentContext,
    BaseEnvironment,
    BaseInstalledAgent,
    NetworkAllowlist,
)


class PierPatchCanary(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "nova-pier-patch-canary"

    def install_spec(self) -> None:
        return None

    def network_allowlist(self):
        if NetworkAllowlist is None:
            return None
        # 空白名单会让 Pier 跳过 egress proxy，canary 必须走与正式评测相同的代理路径
        return NetworkAllowlist(domains=["opencode.ai"])

    async def install(self, environment: BaseEnvironment) -> None:
        return None

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "printf '%s\\n' 'pier patch canary' > PIER_PATCH_CANARY.txt; "
                "git add -- PIER_PATCH_CANARY.txt; "
                "git -c user.name='Nova Harness' "
                "-c user.email='nova-harness@example.invalid' "
                "commit -m 'test: pier patch canary'"
            ),
            cwd="/app",
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        context.n_input_tokens = 0
        context.n_cache_tokens = 0
        context.n_output_tokens = 0
        context.cost_usd = 0.0
