"""Both-endpoint index: declarations, imports, re-exports, import resolution.

Syntax/semantics come from the installed TypeScript 7 compiler through the
worker (see semantic.py). When the worker is unavailable, the graph holds
file-level facts only and the gap is recorded — there is no fallback
syntax guesser pretending to be a semantic index.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .capture import CapturedRepo, CapturedSide
from .excludes import classify_path
from .gitio import BlobReader
from .semantic import SemanticConfig, SemanticSession, find_typescript


# ----------------------------------------------------------------- records


@dataclass(frozen=True)
class SymbolDecl:
    endpoint: str
    path: str
    name: str
    kind: str
    start_line: int
    end_line: int
    exported: bool
    enclosing: str
    project: str
    blob_id: str

    @property
    def ident(self) -> str:
        return f"{self.path}#{self.enclosing}::{self.name}:{self.kind}"


@dataclass(frozen=True)
class ImportEdge:
    endpoint: str
    path: str            # importing file
    module: str          # specifier as written
    type_only: bool
    line: int
    target: str | None   # resolved repo-relative file, or pkg:<name>, or None
    basis: str           # explicitly declared | candidate


@dataclass(frozen=True)
class ReexportEdge:
    endpoint: str
    path: str
    module: str
    names: tuple[str, ...] | None  # None = star
    type_only: bool
    line: int
    target: str | None
    basis: str


@dataclass
class EndpointGraph:
    endpoint: str
    symbols: list[SymbolDecl] = field(default_factory=list)
    imports: list[ImportEdge] = field(default_factory=list)
    reexports: list[ReexportEdge] = field(default_factory=list)
    by_path: dict[str, list[SymbolDecl]] = field(default_factory=dict)
    gaps: list[str] = field(default_factory=list)
    semantic_available: bool = False
    ts_version: str | None = None
    projects: list[str] = field(default_factory=list)

    def imports_of(self, path: str) -> list[ImportEdge]:
        return [e for e in self.imports if e.path == path]

    def symbols_named(self, name: str) -> list[SymbolDecl]:
        return [s for s in self.symbols if s.name == name]


@dataclass
class PairGraph:
    base: EndpointGraph
    head: EndpointGraph
    matches: dict[str, str]          # base ident -> head ident
    deleted: list[SymbolDecl]        # base decls with no head match
    added: list[SymbolDecl]          # head decls with no base match
    rename_map: dict[str, str]       # base path -> head path


# ------------------------------------------------------------ tsconfig sniff


def _strip_jsonc(text: str) -> str:
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_str:
            out.append(ch)
            if ch == "\\":
                if i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        out.append(ch)
        i += 1
    stripped = "".join(out)
    return re.sub(r",(\s*[}\]])", r"\1", stripped)


def _load_compiler_options(reader: BlobReader, entries_by_path: dict, path: str, depth: int = 0) -> dict:
    import json

    if depth > 4 or path not in entries_by_path:
        return {}
    try:
        raw = reader.read(entries_by_path[path].sha)
        opts = json.loads(_strip_jsonc(raw.decode("utf-8", "replace")))
    except Exception:
        return {}
    merged: dict = {}
    extends = opts.get("extends")
    if isinstance(extends, str) and extends.startswith("."):
        ext_path = posixpath.normpath(posixpath.join(posixpath.dirname(path), extends))
        if not ext_path.endswith(".json"):
            ext_path += ".json"
        merged.update(_load_compiler_options(reader, entries_by_path, ext_path, depth + 1))
    merged.update(opts.get("compilerOptions", {}))
    return merged


def _resolve_import(
    importer: str,
    spec: str,
    allowed_paths: set[str],
    paths_map: dict[str, list[str]],
    base_url: str | None,
) -> tuple[str | None, str]:
    """Return (target, basis). target may be pkg:<name> for externals."""

    def try_path(candidate: str) -> str | None:
        candidate = posixpath.normpath(candidate)
        if candidate.startswith("../") or candidate.startswith("/"):
            return None
        for ext in ("", ".ts", ".tsx", ".d.ts", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.d.ts"):
            p = candidate + ext
            if p in allowed_paths:
                return p
        return None

    if spec.startswith("."):
        target = try_path(posixpath.join(posixpath.dirname(importer), spec))
        if target:
            return target, "explicitly declared"
        return None, "candidate"

    if base_url and not spec.startswith("@"):
        target = try_path(posixpath.join(base_url, spec))
        if target:
            return target, "explicitly declared"

    for prefix, subs in paths_map.items():
        if prefix.endswith("*"):
            stem = prefix[:-1]
            if spec.startswith(stem):
                rest = spec[len(stem):]
                for sub in subs:
                    target = try_path(sub.replace("*", rest))
                    if target:
                        return target, "explicitly declared"
        elif spec == prefix:
            for sub in subs:
                target = try_path(sub)
                if target:
                    return target, "explicitly declared"

    if spec.startswith("@"):
        parts = spec.split("/")
        pkg = "/".join(parts[:2])
        return f"pkg:{pkg}", "explicitly declared"
    pkg = spec.split("/", 1)[0]
    return f"pkg:{pkg}", "explicitly declared"


# ------------------------------------------------------------------ build


def _find_tsconfigs(side: CapturedSide) -> list[str]:
    candidates = [
        p
        for p in side.allowed
        if p == "tsconfig.json"
        or (p.count("/") == 1 and posixpath.basename(p).startswith("tsconfig") and p.endswith(".json"))
        or (p == "tsconfig.app.json")
    ]
    ordered = sorted(set(candidates), key=lambda p: (p != "tsconfig.json", p))
    return ordered[:6]


def nearest_tsconfig(tsconfigs: list[str], path: str) -> str:
    """The tsconfig whose root most narrowly contains `path`; "" when none match."""
    if not tsconfigs:
        return ""

    def project_root(tc: str) -> str:
        d = posixpath.dirname(tc)
        return "" if d in ("", ".") else d

    def contains(tc: str) -> bool:
        root_dir = project_root(tc)
        return root_dir == "" or path == root_dir or path.startswith(root_dir + "/")

    containing = [tc for tc in tsconfigs if contains(tc)]
    if containing:
        return max(containing, key=lambda tc: len(project_root(tc)))
    return tsconfigs[0]


def abs_nearest_tsconfig(side, tsconfigs: list[str] | None, path: str):
    """absolute path of the nearest tsconfig for `path`, or "" when none."""
    tcs = list(tsconfigs or _find_tsconfigs(side))
    if not tcs:
        return ""
    rel = nearest_tsconfig(tcs, path)
    root = Path(side.materialized).resolve() if side.materialized else None
    return str((root / rel).resolve()) if root and rel else rel


def open_semantic_session(cap: CapturedRepo, side: CapturedSide) -> tuple[SemanticSession | None, list[str], list[str], str | None]:
    """Open one semantic worker session for `side` (shared by index and tools).

    Returns (session, gaps, tsconfigs, ts_version). session is None when the
    semantic layer is unavailable; gaps explain why.
    """
    gaps: list[str] = []
    tsconfigs = _find_tsconfigs(side)
    root = Path(side.materialized).resolve() if side.materialized else None
    if root is None:
        return None, [f"{side.endpoint.value}: endpoint tree not materialized; no semantic index"], [], None
    ts_files = [p for p in side.allowed if classify_path(p) == "ts"]
    typescript = find_typescript(str(root))
    if not ts_files:
        return None, [], tsconfigs, None
    if typescript is None:
        return None, [
            f"{side.endpoint.value}: no usable TypeScript install (endpoint node_modules or "
            "CODE_REVIEW_TYPESCRIPT unset); declarations, imports, and call edges are not resolved"
        ], tsconfigs, None
    if not tsconfigs:
        return None, [
            f"{side.endpoint.value}: no tsconfig.json found; declarations, imports, and call edges are not resolved"
        ], [], None
    session = SemanticSession(
        SemanticConfig(
            root=str(root),
            typescript=typescript,
            tsconfigs=[str((root / p).resolve()) for p in tsconfigs],
        )
    )
    if not session.open():
        return None, [f"{side.endpoint.value}: semantic worker unavailable: {session.open_error}"], tsconfigs, None
    return session, gaps, tsconfigs, session.ts_version


def index_side(cap: CapturedRepo, side: CapturedSide, *, session: SemanticSession | None = None,
               tsconfigs: list[str] | None = None, ts_version: str | None = None,
               gaps: list[str] | None = None) -> EndpointGraph:
    graph = EndpointGraph(endpoint=side.endpoint.value)
    graph.gaps.extend(gaps or [])
    reader = BlobReader(cap.request.repository)
    try:
        entries_by_path = {e.path: e for e in side.entries if e.type == "blob"}
        tsconfigs = tsconfigs if tsconfigs is not None else _find_tsconfigs(side)
        ts_files = sorted(p for p in side.allowed if classify_path(p) == "ts")
        root = Path(side.materialized).resolve() if side.materialized else None
        tsconfig_abs = [str((root / p).resolve()) for p in tsconfigs] if root else []

        own_session = session is None
        if own_session and ts_files and root is not None and tsconfigs:
            session, extra_gaps, _, ts_version = open_semantic_session(cap, side)
            graph.gaps.extend(extra_gaps)
        if session is not None:
            graph.semantic_available = True
            graph.ts_version = ts_version or session.ts_version
            graph.projects = list(tsconfigs)

        allowed_paths = set(side.allowed)
        for path in ts_files:
            assert root is not None
            blob_sha = side.allowed[path].sha
            if session is None:
                continue
            merged_decls: dict[tuple, dict] = {}
            merged_imports: list[dict] = []
            merged_reexports: list[dict] = []
            saw_file = False
            for tsconfig, tsconfig_path in zip(tsconfigs or [""], tsconfig_abs or [""]):
                resp = session.index(path, tsconfig_path)
                if not resp.get("ok"):
                    graph.gaps.append(f"{side.endpoint.value}: index failed for {path} ({tsconfig}): {resp.get('error')}")
                    continue
                saw_file = True
                project = tsconfig
                for d in resp.get("decls", []):
                    key = (d["name"], d["start_line"], d["kind"])
                    merged_decls.setdefault(key, {**d, "project": project})
                merged_imports.extend(resp.get("imports", []))
                merged_reexports.extend(resp.get("reexports", []))
            if not saw_file:
                continue
            for d in merged_decls.values():
                graph.symbols.append(
                    SymbolDecl(
                        endpoint=side.endpoint.value,
                        path=path,
                        name=d["name"],
                        kind=d["kind"],
                        start_line=int(d["start_line"]),
                        end_line=int(d["end_line"]),
                        exported=bool(d["exported"]),
                        enclosing=d.get("enclosing") or "",
                        project=d.get("project") or "",
                        blob_id=blob_sha,
                    )
                )
            # import resolution tables per program set
            opts = {}
            for tsconfig in tsconfigs[:1]:
                opts = _load_compiler_options(reader, entries_by_path, tsconfig)
            base_url = opts.get("baseUrl") if isinstance(opts.get("baseUrl"), str) else None
            paths_opt = opts.get("paths") if isinstance(opts.get("paths"), dict) else {}
            paths_map = {k: (v if isinstance(v, list) else [str(v)]) for k, v in paths_opt.items()}
            seen_imp = set()
            for imp in merged_imports:
                key = (imp["module"], imp.get("type_only"))
                if key in seen_imp:
                    continue
                seen_imp.add(key)
                target, basis = _resolve_import(path, imp["module"], allowed_paths, paths_map, base_url)
                graph.imports.append(
                    ImportEdge(
                        endpoint=side.endpoint.value,
                        path=path,
                        module=imp["module"],
                        type_only=bool(imp.get("type_only")),
                        line=int(imp.get("line", 1)),
                        target=target,
                        basis=basis,
                    )
                )
            seen_rex = set()
            for rex in merged_reexports:
                key = (rex["module"], tuple(rex.get("names") or ()))
                if key in seen_rex:
                    continue
                seen_rex.add(key)
                target, basis = _resolve_import(path, rex["module"], allowed_paths, paths_map, base_url)
                graph.reexports.append(
                    ReexportEdge(
                        endpoint=side.endpoint.value,
                        path=path,
                        module=rex["module"],
                        names=tuple(rex["names"]) if rex.get("names") else None,
                        type_only=bool(rex.get("type_only")),
                        line=int(rex.get("line", 1)),
                        target=target,
                        basis=basis,
                    )
                )
        if own_session and session is not None:
            session.close()
        graph.by_path = {}
        for sym in graph.symbols:
            graph.by_path.setdefault(sym.path, []).append(sym)
        return graph
    finally:
        reader.close()


def match_symbols(base: EndpointGraph, head: EndpointGraph, rename_map: dict[str, str]) -> PairGraph:
    """Match base/head declarations by rename map, exported name, enclosing
    declaration, and structural evidence. Ambiguous matches stay ambiguous."""
    head_by_key: dict[tuple[str, str, str, str], list[SymbolDecl]] = {}
    head_by_key_nopath: dict[tuple[str, str, str], list[SymbolDecl]] = {}
    for sym in head.symbols:
        head_by_key.setdefault((sym.path, sym.kind, sym.enclosing, sym.name), []).append(sym)
        head_by_key_nopath.setdefault((sym.kind, sym.enclosing, sym.name), []).append(sym)

    matches: dict[str, str] = {}
    used_head: set[str] = set()
    deleted: list[SymbolDecl] = []
    ambiguities = 0

    for sym in base.symbols:
        head_path = rename_map.get(sym.path, sym.path)
        candidates = head_by_key.get((head_path, sym.kind, sym.enclosing, sym.name))
        if not candidates and sym.path != head_path:
            candidates = head_by_key.get((sym.path, sym.kind, sym.enclosing, sym.name))
        trusted = True
        if not candidates:
            trusted = False
            candidates = head_by_key_nopath.get((sym.kind, sym.enclosing, sym.name), [])
            if len(candidates) != 1:
                ambiguities += 1
                candidates = None  # ambiguous or absent cross-file move
        if candidates:
            free = [c for c in candidates if c.ident not in used_head]
            if len(free) == 1:
                matches[sym.ident] = free[0].ident
                used_head.add(free[0].ident)
                continue
            if len(free) > 1 and trusted:
                # Same path/enclosing/name but structurally redundant decls:
                # deterministic first match, but record it as ambiguous evidence.
                ambiguities += 1
                matches[sym.ident] = free[0].ident
                used_head.add(free[0].ident)
                continue
            if len(free) > 1:
                ambiguities += 1
                deleted.append(sym)
                continue
        deleted.append(sym)

    added = [s for s in head.symbols if s.ident not in used_head]
    graph = PairGraph(base=base, head=head, matches=matches, deleted=deleted, added=added, rename_map=rename_map)
    if ambiguities:
        base.gaps.append(f"{ambiguities} base declarations matched ambiguously or not at all; evidence noted")
    return graph
