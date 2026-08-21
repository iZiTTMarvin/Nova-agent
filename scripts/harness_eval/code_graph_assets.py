from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "scripts" / "build" / "codeGraphAssets.json"


def _load_wasm_file_names() -> tuple[str, ...]:
    value: Any = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not value:
        raise RuntimeError(f"invalid Code Graph asset manifest: {MANIFEST_PATH}")
    file_names: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            raise RuntimeError(f"invalid Code Graph asset manifest: {MANIFEST_PATH}")
        file_name = item.get("fileName")
        if (
            not isinstance(file_name, str)
            or not file_name
            or Path(file_name).name != file_name
        ):
            raise RuntimeError(f"invalid Code Graph asset manifest: {MANIFEST_PATH}")
        file_names.append(file_name)
    if len(set(file_names)) != len(file_names):
        raise RuntimeError(f"duplicate Code Graph asset name: {MANIFEST_PATH}")
    return tuple(file_names)


CODE_GRAPH_WASM_FILES = _load_wasm_file_names()
HEADLESS_CODE_GRAPH_ARTIFACTS = (
    "codeGraphWorker.cjs",
    *(f"code-graph/grammars/{file_name}" for file_name in CODE_GRAPH_WASM_FILES),
)


def headless_runtime_chunks(output_root: Path) -> tuple[Path, ...]:
    return tuple(sorted((output_root / "chunks").glob("*.cjs")))
