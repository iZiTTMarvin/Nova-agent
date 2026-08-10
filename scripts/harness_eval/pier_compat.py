from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


_ORIGINAL_PROXY_WRITE = (
    b'    (proxy_dir / "start-squid.sh").write_text(squid_bootstrap_command())'
)
_LF_PROXY_WRITE = (
    b'    (proxy_dir / "start-squid.sh").write_text('
    b'squid_bootstrap_command(), newline="\\n")'
)


def apply_lf_proxy_script_write(agent_setup_path: Path) -> bool:
    original = agent_setup_path.read_bytes()
    original_count = original.count(_ORIGINAL_PROXY_WRITE)
    patched_count = original.count(_LF_PROXY_WRITE)
    if original_count == 0 and patched_count == 1:
        return False
    if original_count != 1 or patched_count != 0:
        raise RuntimeError(f"unsupported Pier proxy writer layout: {agent_setup_path}")

    compatible = original.replace(_ORIGINAL_PROXY_WRITE, _LF_PROXY_WRITE, 1)
    temporary = agent_setup_path.with_name(f".{agent_setup_path.name}.nova.tmp")
    temporary.write_bytes(compatible)
    os.chmod(temporary, stat.S_IMODE(agent_setup_path.stat().st_mode))
    temporary.replace(agent_setup_path)
    return True


def _pier_python(pier_executable: Path) -> Path:
    configured = os.environ.get("NOVA_PIER_PYTHON")
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.is_file():
            return candidate
        raise RuntimeError(f"NOVA_PIER_PYTHON does not exist: {candidate}")

    try:
        if importlib.metadata.version("datacurve-pier"):
            return Path(sys.executable).resolve()
    except importlib.metadata.PackageNotFoundError:
        pass

    for candidate in (
        pier_executable.parent / "python.exe",
        pier_executable.parent / "python",
    ):
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(
        "cannot locate Pier's Python runtime; set NOVA_PIER_PYTHON explicitly"
    )


def ensure_pier_proxy_compatibility(
    pier_executable: str | None = None,
) -> dict[str, Any]:
    executable = Path(pier_executable or shutil.which("pier") or "")
    if not executable.is_file():
        raise RuntimeError("pier is not installed")
    pier_python = _pier_python(executable)
    query = (
        "import importlib.metadata, json; "
        "import pier.environments.agent_setup as module; "
        "print(json.dumps({'version': importlib.metadata.version('datacurve-pier'), "
        "'path': str(module.__file__)}))"
    )
    result = subprocess.run(
        [str(pier_python), "-c", query],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    metadata = json.loads(result.stdout.strip())
    version = str(metadata["version"])
    if version != "0.3.0":
        raise RuntimeError(f"unsupported Pier version: {version}")
    source_path = Path(str(metadata["path"])).resolve()
    if not source_path.is_file():
        raise RuntimeError(f"Pier agent setup source not found: {source_path}")
    modified = apply_lf_proxy_script_write(source_path)
    return {
        "mode": "windows-lf-proxy-script",
        "pier_version": version,
        "source_path": str(source_path),
        "source_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "modified": modified,
    }
