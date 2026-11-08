"""The four read-only review tools (smolagents Tool subclasses).

Every tool enforces path confinement, blob-provenance reads, and byte
budgets inside `forward()`. The model sees only the schema-derived
descriptions — never ambient authority. All reads come from Git objects
(cat-file via BlobReader) or the pinned flow registry, never from the
operator's checkout.
"""

from __future__ import annotations

import posixpath
import re
import time
from pathlib import PurePosixPath

from smolagents import Tool

from . import excludes
from .budget import BudgetState
from .capture import CapturedRepo
from .contracts import Endpoint, Limits, ReadLogEntry
from .flows import Flow, FlowMatch, clause_texts
from .gitio import BlobReader

MAX_SEARCH_PATTERN = 200
_NESTED_QUANTIFIER_RE = re.compile(r"\([^)]*[+*][^)]*\)\s*[+*{]")


class ToolContext:
    """Host-side state shared by the four tools for one review run."""

    def __init__(self, cap: CapturedRepo, limits: Limits, budget: BudgetState, flows: list[Flow]):
        self.cap = cap
        self.limits = limits
        self.budget = budget
        self.flows = flows
        self.tsconfigs: dict[Endpoint, list[str]] = {Endpoint.BASE: [], Endpoint.HEAD: []}
        self.read_log: list[ReadLogEntry] = []
        self.unresolved: list[str] = []
        self.readers = {Endpoint.BASE: BlobReader(cap.request.repository), Endpoint.HEAD: BlobReader(cap.request.repository)}
        self.sessions: dict[Endpoint, object | None] = {}
        self.started = time.monotonic()

    # -- confinement ---------------------------------------------------------

    def side(self, endpoint: str):
        ep = Endpoint(endpoint.lower())
        return self.cap.side(ep)

    def checked_path(self, endpoint: str, path: str):
        ep = Endpoint(endpoint.lower())
        side = self.cap.side(ep)
        norm = posixpath.normpath(path)
        if path.startswith("/") or norm.startswith("../") or norm == ".." or PurePosixPath(path).is_absolute():
            return None, None, f"REFUSE: path must be repository-relative: {path!r}"
        entry = side.allowed.get(norm)
        if entry is None:
            reason = side.excluded.get(norm, "not a tracked, in-scope, non-excluded blob")
            return None, None, f"REFUSE: {norm} is not readable ({reason})"
        return ep, (norm, entry), None

    def blob_of(self, endpoint: str, path: str):
        ep, checked, err = self.checked_path(endpoint, path)
        if err:
            return None, None, err
        norm, entry = checked
        try:
            return ep, (norm, entry, self.readers[ep].read(entry.sha)), None
        except Exception as exc:
            return None, None, f"REFUSE: cannot read blob for {norm}: {exc}"

    # -- accounting ----------------------------------------------------------

    def finish(self, endpoint: Endpoint, tool: str, path: str, blob_id: str | None,
               start: int | None, end: int | None, text: str) -> str:
        data = len(text.encode("utf-8", "replace"))
        self.read_log.append(
            ReadLogEntry(endpoint=endpoint, tool=tool, path=path, blob_id=blob_id,
                         start_line=start, end_line=end, bytes=data)
        )
        self.budget.add_bytes(data)
        self.budget.add_tool_call()
        return text

    def close(self):
        for reader in self.readers.values():
            try:
                reader.close()
            except Exception:
                pass


class _SnapshotTool(Tool):
    def __init__(self, ctx: ToolContext):
        super().__init__()
        self.ctx = ctx

    # smolagents calls forward(**kwargs); keep the signature positional-safe.


class ReadSnapshotRange(_SnapshotTool):
    name = "read_snapshot_range"
    description = (
        "Read a line range of a tracked, in-scope file from one immutable snapshot "
        "(endpoints: 'base' or 'head'). Returns the lines with a provenance header "
        "naming endpoint, path, blob ID, and range. Never reads the working tree."
    )
    inputs = {
        "endpoint": {"type": "string", "description": "'base' or 'head'"},
        "path": {"type": "string", "description": "Repository-relative path, e.g. 'src/tools/fetch.ts'"},
        "start_line": {"type": "integer", "description": "1-based first line, inclusive"},
        "end_line": {"type": "integer", "description": "1-based last line, inclusive"},
    }
    output_type = "string"

    def forward(self, endpoint: str, path: str, start_line: int, end_line: int) -> str:
        ep, checked, err = self.ctx.blob_of(endpoint, path)
        if err:
            return err
        norm, entry, raw = checked
        limit = self.ctx.limits.read_range_lines
        start, end = int(start_line), int(end_line)
        if start < 1 or end < 1:
            return "REFUSE: lines are 1-based"
        if end < start:
            return "REFUSE: end_line is before start_line"
        truncated = False
        if end - start + 1 > limit:
            end = start + limit - 1
            truncated = True
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return f"REFUSE: {norm} is not UTF-8 text in {ep.value} (binary)"
        lines = text.splitlines()
        end = min(end, len(lines))
        if start > len(lines):
            return f"EMPTY: {ep.value}:{norm} has {len(lines)} lines; range {start}-{end_line} is out of bounds"
        body = "\n".join(f"{i + 1}\t{lines[i]}" for i in range(start - 1, end))
        note = f"\n[truncated to {limit} lines]" if truncated else ""
        out = f"// snapshot endpoint={ep.value} path={norm} blob={entry.sha} lines={start}-{end}{note}\n{body}"
        return self.ctx.finish(ep, self.name, norm, entry.sha, start, end, out)


class SearchSnapshot(_SnapshotTool):
    name = "search_snapshot"
    description = (
        "Search one or both snapshots' allowed source text with a literal string or regular "
        "expression. Returns capped matches (path:line) with provenance. Never searches "
        "excluded files, vendored trees, or the working tree."
    )
    inputs = {
        "pattern": {"type": "string", "description": "Literal text or Python regex (max 200 chars)"},
        "endpoint": {"type": "string", "description": "'base', 'head', or 'both' (default 'both')", "nullable": True},
        "path_glob": {"type": "string", "description": "Optional repo-relative glob filter, e.g. 'src/**/*.ts'", "nullable": True},
        "max_hits": {"type": "integer", "description": "Cap on returned matches (default 50)", "nullable": True},
    }
    output_type = "string"

    def forward(self, pattern: str, endpoint: str = "both", path_glob: str | None = None, max_hits: int | None = None) -> str:
        if not pattern or len(pattern) > MAX_SEARCH_PATTERN:
            return f"REFUSE: pattern must be 1..{MAX_SEARCH_PATTERN} characters"
        if _NESTED_QUANTIFIER_RE.search(pattern):
            return "REFUSE: nested quantifiers are not accepted (unbounded regex cost)"
        try:
            rx = re.compile(pattern)
        except re.error:
            rx = re.compile(re.escape(pattern))
        glob_re = (
            re.compile(
                re.escape(path_glob)
                .replace(r"\*\*/", "(?:.*/)?")  # **/ matches zero or more directories
                .replace(r"\*\*", ".*")
                .replace(r"\*", "[^/]*")
            )
            if path_glob
            else None
        )
        cap = min(int(max_hits or self.ctx.limits.search_hits), self.ctx.limits.search_hits)
        endpoints = ["base", "head"] if (endpoint or "both").lower() == "both" else [(endpoint or "both").lower()]
        results: list[str] = []
        hits = 0
        total_bytes = 0
        byte_cap = self.ctx.limits.tool_budget_bytes
        for ep_name in endpoints:
            ep = Endpoint(ep_name)
            side = self.ctx.cap.side(ep)
            for path in sorted(side.allowed):
                if glob_re and not glob_re.fullmatch(path):
                    continue
                entry = side.allowed[path]
                try:
                    raw = self.ctx.readers[ep].read(entry.sha)
                    text = raw.decode("utf-8")
                except Exception:
                    continue
                for i, line in enumerate(text.splitlines(), 1):
                    m = rx.search(line)
                    if not m:
                        continue
                    hits += 1
                    shown = line[: self.ctx.limits.search_line_chars]
                    row = f"{ep_name} {path}:{i}: {shown}"
                    total_bytes += len(row.encode())
                    if total_bytes > byte_cap:
                        results.append(f"[byte budget reached after {hits - 1} hits]")
                        results.append(f"[blob lookup: {ep_name} {path}:{i}]")
                        return self.ctx.finish(ep, self.name, path, entry.sha, i, i, "\n".join(results))
                    results.append(row)
                    self.ctx.read_log.append(
                        ReadLogEntry(endpoint=ep, tool=self.name, path=path, blob_id=entry.sha,
                                     start_line=i, end_line=i, bytes=len(row.encode()))
                    )
                    if hits >= cap:
                        results.append(f"[hit cap {cap} reached]")
                        return self.ctx.finish(ep, self.name, path, entry.sha, i, i, "\n".join(results))
        if not results:
            return self.ctx.finish(ep, self.name, "", None, None, None, "NO MATCHES")
        joined = "\n".join(results)
        self.ctx.budget.add_bytes(total_bytes)
        self.ctx.budget.add_tool_call()
        return joined


def _nearest_tsconfig(ctx: ToolContext, ep: Endpoint, path: str) -> str:
    from .indexer import abs_nearest_tsconfig

    side = ctx.cap.side(ep)
    tcs = list(getattr(ctx, "tsconfigs", {}).get(ep, []))
    return abs_nearest_tsconfig(side, tcs, path)


class ResolveReferences(_SnapshotTool):
    name = "resolve_references"
    description = (
        "Resolve the definition and program-wide reference sites of the symbol under a "
        "position (or the symbol with the given name on that line) using the endpoint's "
        "own TypeScript compiler. Returns provenance-bound locations. If the semantic "
        "layer is unavailable, returns an explicit UNRESOLVED gap — never an empty "
        "'no references found'."
    )
    inputs = {
        "endpoint": {"type": "string", "description": "'base' or 'head'"},
        "path": {"type": "string", "description": "Repository-relative source path"},
        "line": {"type": "integer", "description": "1-based line containing the symbol"},
        "name": {"type": "string", "description": "Optional symbol name to locate on that line", "nullable": True},
    }
    output_type = "string"

    def forward(self, endpoint: str, path: str, line: int, name: str | None = None) -> str:
        ep, checked, err = self.ctx.checked_path(endpoint, path)
        if err:
            return err
        norm, _entry = checked
        session = self.ctx.sessions.get(ep)
        if session is None:
            self.ctx.unresolved.append(f"{ep.value}:{norm}:{line} references unresolved: semantic layer unavailable")
            return f"UNRESOLVED: semantic layer unavailable for {ep.value} (see coverage gaps)"
        if name:
            blob = self.ctx.readers[ep].read(self.ctx.cap.side(ep).allowed[norm].sha)
            lines = blob.decode("utf-8", "replace").splitlines()
            target_line = lines[int(line) - 1] if 0 < int(line) <= len(lines) else ""
            if name not in target_line:
                return (
                    f"UNRESOLVED: {name!r} not found on line {int(line)} of {ep.value}:{norm}; "
                    "the line is: " + (target_line.strip() or "<blank>")
                )
        tsconfig_abs = _nearest_tsconfig(self.ctx, ep, norm)
        resp = session.references(norm, int(line), name, tsconfig_abs, self.ctx.limits.max_reference_sites)
        if not resp.get("ok"):
            self.ctx.unresolved.append(f"{ep.value}:{norm}:{line} references unresolved: {resp.get('error')}")
            return f"UNRESOLVED: {resp.get('error')}"
        blob = self.ctx.cap.side(ep).allowed.get(norm)
        out = [f"// snapshot endpoint={ep.value} path={norm} blob={blob.sha if blob else '?'} line={line}"]
        definition = resp.get("definition")
        if definition:
            out.append(f"definition: {definition['path']}:{definition['line']} ({definition.get('name', '')})")
        else:
            out.append("definition: <not found>")
        refs = resp.get("references", [])
        out.append(f"references ({len(refs)}{'+' if resp.get('truncated') else ''}):")
        for ref in refs:
            out.append(f"  {ref['path']}:{ref['line']}")
        if resp.get("unresolved"):
            out.append(f"unresolved reference sites: {resp['unresolved']}")
        if resp.get("truncated"):
            out.append("[truncated at reference cap]")
        return self.ctx.finish(ep, self.name, norm, blob.sha if blob else None, int(line), int(line), "\n".join(out))


class InspectDeclaredFlow(_SnapshotTool):
    name = "inspect_declared_flow"
    description = (
        "Look up the operator-pinned declared-flow registry for the area under review. "
        "Returns the connected areas and the design-clause references (pinned BASE copies "
        "of the clauses, size-capped). An explicit NO MATCH is a valid answer; it never "
        "licenses inventing connections."
    )
    inputs = {
        "topic": {"type": "string", "description": "Keywords describing the area, e.g. 'turn admission tools delivery'"},
    }
    output_type = "string"

    def forward(self, topic: str) -> str:
        words = {w.lower() for w in re.split(r"[^a-zA-Z0-9_-]+", topic) if len(w) > 2}
        scored: list[tuple[int, Flow]] = []
        for flow in self.ctx.flows:
            hay = f"{flow.id} {flow.description} {' '.join(p.pattern for p in flow.path_patterns)} {' '.join(s.pattern for s in flow.symbol_patterns)}".lower()
            score = sum(1 for w in words if w in hay)
            if score:
                scored.append((score, flow))
        scored.sort(key=lambda item: -item[0])
        ep = Endpoint.BASE
        side = self.ctx.cap.side(ep)
        out = [f"// declared flows for: {topic} (registry + pinned base clauses)"]
        if not scored:
            out.append("NO MATCH: no declared flow anchors this area; treat connections as unresolved.")
            return self.ctx.finish(ep, self.name, "", None, None, None, "\n".join(out))
        budget = self.ctx.limits.policy_bytes // 2
        for score, flow in scored[:3]:
            out.append(f"flow {flow.id} ({flow.description})")
            clauses = clause_texts(self.ctx.readers[ep], side.allowed, flow.clauses, budget)
            for clause, text, truncated in clauses:
                marker = " [truncated]" if truncated else ""
                excerpt = text[:4000]
                out.append(f"  clause: {clause}{marker}\n{excerpt}")
        return self.ctx.finish(ep, self.name, "", None, None, None, "\n".join(out))


def build_tools(ctx: ToolContext) -> list[Tool]:
    return [ReadSnapshotRange(ctx), SearchSnapshot(ctx), ResolveReferences(ctx), InspectDeclaredFlow(ctx)]
