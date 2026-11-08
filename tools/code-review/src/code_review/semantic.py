"""Python client for the semantic worker (worker/semantic_worker.mjs).

One worker per materialized endpoint. If the endpoint has no usable
TypeScript install, semantic relations are reported as gaps — never
silently substituted.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

WORKER = Path(__file__).with_name("worker") / "semantic_worker.mjs"


class SemanticError(RuntimeError):
    pass


def find_typescript(endpoint_root: str) -> str | None:
    """Locate a typescript package to drive the worker.

    Order: explicit override (CODE_REVIEW_TYPESCRIPT), then the endpoint's
    own node_modules (the spec-preferred source), then an adjacent
    `node_modules` produced by the endpoint's lockfile install.
    """
    override = os.environ.get("CODE_REVIEW_TYPESCRIPT")
    if override:
        p = Path(override)
        if (p / "package.json").exists() or p.suffix == ".json":
            return str(p)
        if (p / "node_modules" / "typescript" / "package.json").exists():
            return str(p / "node_modules" / "typescript")
        return None
    candidate = Path(endpoint_root) / "node_modules" / "typescript"
    if (candidate / "package.json").exists():
        return str(candidate)
    return None


def find_node() -> str | None:
    return shutil.which("node")


@dataclass
class SemanticConfig:
    root: str            # absolute path of the materialized endpoint tree
    typescript: str      # path to the typescript package dir
    tsconfigs: list[str] # absolute paths, one per program ("" entries dropped by caller)


class SemanticSession:
    def __init__(self, config: SemanticConfig, timeout: float = 120.0):
        self.config = config
        self.timeout = timeout
        self._proc: subprocess.Popen[bytes] | None = None
        self._deadline = 0.0
        self.ts_version: str | None = None
        self._open_error: str | None = None

    # -- lifecycle -----------------------------------------------------------

    def open(self) -> bool:
        node = find_node()
        if node is None:
            self._open_error = "node executable not found on PATH"
            return False
        try:
            self._proc = subprocess.Popen(
                [node, str(WORKER)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
                cwd=self.config.root,
            )
        except OSError as exc:
            self._open_error = f"cannot spawn semantic worker: {exc}"
            return False
        resp = self._request(
            {
                "op": "open",
                "root": self.config.root,
                "typescript": self.config.typescript,
                "tsconfigs": self.config.tsconfigs,
            }
        )
        if resp is None or not resp.get("ok"):
            self._open_error = (resp or {}).get("error", "semantic worker failed to open")
            self.close()
            return False
        self.ts_version = resp.get("ts_version")
        return True

    @property
    def open_error(self) -> str | None:
        return self._open_error

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                try:
                    proc.stdin.write(b'{"op":"close"}\n')
                    proc.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    def __enter__(self) -> "SemanticSession":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- wire ----------------------------------------------------------------

    def _request(self, payload: dict) -> dict | None:
        assert self._proc and self._proc.stdin and self._proc.stdout
        try:
            self._proc.stdin.write((json.dumps(payload) + "\n").encode())
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            self._open_error = self._open_error or "semantic worker pipe closed"
            return None
        assert self._proc.stdout
        fd = self._proc.stdout.fileno()
        deadline = time.monotonic() + self.timeout
        buf = b""
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 1.0)
            if not ready:
                if self._proc.poll() is not None:
                    self._open_error = self._open_error or "semantic worker exited unexpectedly"
                    return None
                continue
            chunk = os.read(fd, 65536)
            if not chunk:
                self._open_error = self._open_error or "semantic worker closed stdout"
                return None
            buf += chunk
            if b"\n" in buf:
                line, _rest = buf.split(b"\n", 1)
                try:
                    return json.loads(line.decode("utf-8", "replace"))
                except json.JSONDecodeError as exc:
                    self._open_error = self._open_error or f"bad response from worker: {exc}"
                    return None
        self._open_error = self._open_error or "semantic worker timed out"
        return None

    def _call(self, payload: dict) -> dict | None:
        if self._proc is None:
            return None
        return self._request(payload)

    # -- operations ----------------------------------------------------------

    def index(self, file: str, tsconfig: str) -> dict:
        resp = self._call({"op": "index", "root": self.config.root, "file": file, "tsconfig": tsconfig})
        return resp or {"ok": False, "error": self._open_error or "semantic worker unavailable"}

    def references(self, file: str, line: int, name: str | None, tsconfig: str, max_refs: int) -> dict:
        resp = self._call(
            {
                "op": "references",
                "root": self.config.root,
                "file": file,
                "line": line,
                "name": name,
                "tsconfig": tsconfig,
                "maxRefs": max_refs,
            }
        )
        return resp or {"ok": False, "error": self._open_error or "semantic worker unavailable"}

    def calls(self, file: str, start_line: int, end_line: int, tsconfig: str, max_edges: int = 500) -> dict:
        resp = self._call(
            {
                "op": "calls",
                "root": self.config.root,
                "file": file,
                "startLine": start_line,
                "endLine": end_line,
                "tsconfig": tsconfig,
                "maxEdges": max_edges,
            }
        )
        return resp or {"ok": False, "error": self._open_error or "semantic worker unavailable"}
