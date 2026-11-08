"""Endpoint capture: resolve, verify cleanliness, classify, materialize."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from . import excludes, gitio
from .contracts import ComparisonMode, Endpoint, Limits, ReviewRequest, SideSnapshot, Snapshot
from .gitio import GitError, RawChange, TreeEntry


TS_RE = re.compile(r"\.(ts|tsx|mts|cts)$")


@dataclass
class CapturedSide:
    endpoint: Endpoint
    commit: str
    tree: str
    entries: list[TreeEntry]
    allowed: dict[str, TreeEntry]      # path -> entry (tracked, not excluded, not symlink)
    excluded: dict[str, str]           # path -> reason
    symlinks: list[str]                # skipped symlink paths
    materialized: str | None = None    # temp tree path for the language worker

    def blob_map(self) -> dict[str, str]:
        return {path: e.sha for path, e in self.allowed.items()}


@dataclass
class CapturedRepo:
    request: ReviewRequest
    base: CapturedSide
    head: CapturedSide
    merge_base: str | None
    excluded_paths: list[str]
    scope: list[str]
    scope_hash: str
    config_hash: str
    warnings: list[str] = field(default_factory=list)
    requested_base: str | None = None  # fork-point mode: the resolved base-ref tip (content reviewed is the merge base)

    def side(self, endpoint: Endpoint | str) -> CapturedSide:
        return self.base if Endpoint(endpoint) is Endpoint.BASE else self.head

    def analyzer(self) -> dict[str, str]:
        from smolagents import __version__ as smol_version
        import pydantic

        analyzer = {
            "harness": "goblin-code-review 0.1.0",
            "smolagents": smol_version,
            "pydantic": pydantic.VERSION,
            "python": f"{os.sys.version_info.major}.{os.sys.version_info.minor}.{os.sys.version_info.micro}",
            "ts_semantic": "tsgo --api (typescript unstable async API)",
        }
        if self.requested_base:
            analyzer["requested_base"] = self.requested_base
            analyzer["comparison_base"] = "merge-base"
        return analyzer


def _scope_ok(path: str, scope: list[str]) -> bool:
    if not scope:
        return True
    return any(path == s or path.startswith(s + "/") or s == "." for s in scope)


def _scope_hash(scope: list[str]) -> str:
    return hashlib.sha256(json.dumps(sorted(scope)).encode()).hexdigest()[:16]


def _config_hash(request: ReviewRequest) -> str:
    payload = {
        "scope": sorted(request.scope),
        "limits": request.limits.model_dump(),
        "mode": request.mode.value,
        "base_ref": request.base_ref,
        "head_ref": request.head_ref,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def capture(request: ReviewRequest, *, install_deps: bool = False) -> CapturedRepo:
    repo = os.path.realpath(request.repository)
    if not os.path.isdir(repo):
        raise GitError(f"not a repository: {repo}")
    top = gitio.repo_toplevel(repo)
    if os.path.realpath(request.repository) != top and not repo.startswith(top):
        pass  # git resolves nested paths fine; keep canonical root for clarity
    repo = top

    dirty = gitio.dirty_entries(repo)
    if dirty:
        sample = ", ".join(dirty[:5])
        raise GitError(
            f"checkout has uncommitted changes ({len(dirty)} entries: {sample}); "
            "a review of committed changes cannot be allowed to masquerade as a review of unsaved work"
        )

    base_commit = gitio.resolve_ref(repo, request.base_ref)
    head_commit = gitio.resolve_ref(repo, request.head_ref)

    merge_base_sha: str | None = None
    base_side_commit = base_commit
    if request.mode is ComparisonMode.FORK_POINT:
        # The fork point *is* the comparison base: diffs, hunks, and the
        # before-side snapshot all come from the merge base, so the report
        # reviews exactly what a merge would introduce.
        merge_base_sha = gitio.merge_base(repo, base_commit, head_commit)
        base_side_commit = merge_base_sha

    warnings: list[str] = []
    if gitio.is_shallow(repo):
        warnings.append("shallow repository: merge-base may be incomplete")

    def build_side(endpoint: Endpoint, commit: str) -> CapturedSide:
        tree = gitio.tree_of(repo, commit)
        entries = gitio.list_tree(repo, commit)
        allowed: dict[str, TreeEntry] = {}
        excluded: dict[str, str] = {}
        symlinks: list[str] = []
        for e in entries:
            if e.type != "blob":
                continue
            if e.mode == "120000":
                symlinks.append(e.path)
                excluded[e.path] = "symlink (never followed)"
                continue
            if e.mode == "160000":
                excluded[e.path] = "submodule"
                continue
            reason = excludes.is_excluded(e.path)
            if reason:
                excluded[e.path] = reason
                continue
            if not _scope_ok(e.path, request.scope):
                excluded[e.path] = "outside requested scope"
                continue
            allowed[e.path] = e
        return CapturedSide(endpoint, commit, tree, entries, allowed, excluded, symlinks)

    base = build_side(Endpoint.BASE, base_side_commit)
    head = build_side(Endpoint.HEAD, head_commit)

    excluded_paths = sorted(set(base.excluded) | set(head.excluded))
    scope_hash = _scope_hash(request.scope)
    config_hash = _config_hash(request)
    cap = CapturedRepo(request, base, head, merge_base_sha, excluded_paths, request.scope, scope_hash, config_hash, warnings)
    cap.requested_base = base_commit if merge_base_sha else None

    if install_deps:
        for side in (base, head):
            side.materialized = _materialize(repo, side, install_deps=True, warnings=warnings)
    else:
        for side in (base, head):
            side.materialized = _materialize(repo, side, install_deps=False, warnings=warnings)
    return cap


def _materialize(repo: str, side: CapturedSide, *, install_deps: bool, warnings: list[str]) -> str:
    """git archive the allowed tracked source into a throwaway host-owned tree."""
    paths = sorted(side.allowed)
    dest = tempfile.mkdtemp(prefix=f"code-review-{side.endpoint.value}-")
    os.chmod(dest, 0o700)
    try:
        gitio.archive_paths(repo, side.commit, paths, dest)
        if install_deps and os.path.exists(os.path.join(dest, "package.json")):
            _install_deps(dest, warnings, side.endpoint)
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    return dest


def _install_deps(tree: str, warnings: list[str], endpoint: Endpoint) -> None:
    npm = shutil.which("npm")
    if npm is None:
        warnings.append(f"{endpoint.value}: npm not found; skipping dependency install (coverage gap)")
        return
    lock = None
    for name in ("package-lock.json", "npm-shrinkwrap.json"):
        if os.path.exists(os.path.join(tree, name)):
            lock = name
            break
    cmd = [npm, "ci" if lock else "install", "--ignore-scripts", "--no-audit", "--no-fund"]
    try:
        proc = subprocess.run(cmd, cwd=tree, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900, check=False)
    except (subprocess.TimeoutExpired, OSError) as exc:
        warnings.append(f"{endpoint.value}: dependency install failed ({exc}); semantic coverage gap")
        return
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-500:]
        warnings.append(f"{endpoint.value}: dependency install failed ({tail.strip()}); semantic coverage gap")


def cleanup(cap: CapturedRepo) -> None:
    for side in (cap.base, cap.head):
        if side.materialized:
            shutil.rmtree(side.materialized, ignore_errors=True)
            side.materialized = None


def lock_of(side: CapturedSide) -> str | None:
    return gitio.lock_hash(side.entries)


def side_snapshot(cap: CapturedRepo, side: CapturedSide) -> SideSnapshot:
    return SideSnapshot(
        commit=side.commit,
        tree=side.tree,
        dependency_lock_hash=lock_of(side),
        analyzer=cap.analyzer(),
        file_count=len(side.allowed),
    )


def snapshot(cap: CapturedRepo) -> Snapshot:
    return Snapshot(
        base=side_snapshot(cap, cap.base),
        head=side_snapshot(cap, cap.head),
        merge_base=cap.merge_base,
        scope=cap.scope,
        scope_hash=cap.scope_hash,
        excluded_paths=cap.excluded_paths,
    )
