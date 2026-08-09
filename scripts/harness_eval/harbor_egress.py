from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
from pathlib import Path
from typing import Any


_ORIGINAL_LOCAL_RETURN = b"    fib daddr type local return"
_LOOPBACK_LOCAL_RETURN = (
    b"    ip daddr 127.0.0.0/8 return\n"
    b"    ip6 daddr ::1 return"
)
_ORIGINAL_LOCAL_ACCEPT = b"    fib daddr type local accept"
_LOOPBACK_LOCAL_ACCEPT = (
    b"    ip daddr 127.0.0.0/8 accept\n"
    b"    ip6 daddr ::1 accept"
)
_ORIGINAL_NON_TCP_REJECT = (
    b"    ip6 nexthdr icmpv6 accept\n"
    b"    meta l4proto != tcp reject"
)
_LEGACY_UNBOUNDED_DNS = (
    b"    ip6 nexthdr icmpv6 accept\n"
    b"    udp dport 53 accept\n"
    b"    meta l4proto != tcp reject"
)
_DOCKER_DNS_ONLY = (
    b"    ip6 nexthdr icmpv6 accept\n"
    b"    ip daddr 127.0.0.11 udp dport 53 accept\n"
    b"    meta l4proto != tcp reject"
)
_COMPATIBLE_RULES = (
    ((_ORIGINAL_LOCAL_RETURN,), _LOOPBACK_LOCAL_RETURN),
    ((_ORIGINAL_LOCAL_ACCEPT,), _LOOPBACK_LOCAL_ACCEPT),
    ((_ORIGINAL_NON_TCP_REJECT, _LEGACY_UNBOUNDED_DNS), _DOCKER_DNS_ONLY),
)


def apply_loopback_only_local_exemption(policy_path: Path) -> bool:
    original = policy_path.read_bytes()
    compatible = original
    modified = False
    for sources, target in _COMPATIBLE_RULES:
        if target in compatible:
            continue
        source = next((candidate for candidate in sources if candidate in compatible), None)
        if source is None:
            raise RuntimeError(
                f"unsupported Harbor egress policy layout: {policy_path}"
            )
        compatible = compatible.replace(source, target, 1)
        modified = True
    if not modified:
        return False

    temporary = policy_path.with_name(f".{policy_path.name}.nova.tmp")
    temporary.write_bytes(compatible)
    os.chmod(temporary, stat.S_IMODE(policy_path.stat().st_mode))
    temporary.replace(policy_path)
    return True


def _resolve_harbor_python(harbor_executable: Path) -> Path:
    configured = os.environ.get("NOVA_HARBOR_PYTHON")
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.is_file():
            return candidate
        raise RuntimeError(f"NOVA_HARBOR_PYTHON does not exist: {candidate}")

    try:
        first_line = harbor_executable.read_bytes().splitlines()[0].decode("utf-8")
    except (OSError, UnicodeDecodeError, IndexError):
        first_line = ""
    if first_line.startswith("#!"):
        candidate = Path(first_line[2:].strip())
        if candidate.is_file():
            return candidate

    for name in ("python", "python3", "python.exe"):
        candidate = harbor_executable.parent / name
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "cannot locate Harbor's Python runtime; set NOVA_HARBOR_PYTHON explicitly"
    )


def ensure_harbor_egress_compatibility(
    harbor_executable: str | None = None,
) -> dict[str, Any]:
    executable = Path(harbor_executable or shutil.which("harbor") or "")
    if not executable.is_file():
        raise RuntimeError("harbor is not installed")
    harbor_python = _resolve_harbor_python(executable)
    query = (
        "from harbor.environments.docker import EGRESS_CONTROL_SIDECAR_CONTEXT_PATH as p; "
        "print(p / 'bin' / 'network-policy')"
    )
    result = subprocess.run(
        [str(harbor_python), "-c", query],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    policy_path = Path(result.stdout.strip())
    if not policy_path.is_file():
        raise RuntimeError(f"Harbor egress policy not found: {policy_path}")
    modified = apply_loopback_only_local_exemption(policy_path)
    return {
        "mode": "loopback-only-local-exemption",
        "policy_path": str(policy_path),
        "policy_sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
        "modified": modified,
    }
