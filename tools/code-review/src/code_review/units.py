"""Review units: map hunks → symbols → bounded context bundles.

The host builds units; agents never widen their own scope. Required
context that exceeds the budget makes the unit partial — never a silent
clip.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .capture import CapturedRepo
from .contracts import Endpoint, Hunk, Limits, ReviewUnit
from .excludes import classify_path
from .flows import Flow, check_clause_anchors, match_flows
from .gitio import BlobReader, GitError, file_hunks, numstat, raw_diff
from .indexer import EndpointGraph, PairGraph, SymbolDecl


@dataclass
class UnitBuild:
    units: list[ReviewUnit] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)
    omitted: list[str] = field(default_factory=list)
    hunks_in_scope: int = 0
    rename_map: dict[str, str] = field(default_factory=dict)
    changes: list = field(default_factory=list)


def _read_text(reader: BlobReader, side, path: str) -> str | None:
    entry = side.allowed.get(path)
    if entry is None:
        return None
    try:
        return reader.read(entry.sha).decode("utf-8")
    except Exception:
        return None


def _intersects(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start <= b_end and b_start <= a_end


def build_units(
    cap: CapturedRepo,
    graphs: PairGraph,
    flows: list[Flow],
    sessions: dict[Endpoint, object | None],
) -> UnitBuild:
    limits: Limits = cap.request.limits
    build = UnitBuild()
    repo = cap.request.repository

    changes = raw_diff(repo, cap.base.commit, cap.head.commit)
    build.changes = changes
    rename_map = {c.old_path: c.new_path for c in changes if c.status == "R" and c.old_path and c.new_path}
    build.rename_map = rename_map

    numstats = numstat(repo, cap.base.commit, cap.head.commit)
    in_scope_changes = []
    for c in changes:
        path = c.new_path or c.old_path or ""
        if not path:
            continue
        nb = numstats.get(path)
        binary = nb is not None and nb[0] is None
        if path not in cap.head.allowed and path not in cap.base.allowed and c.status != "D":
            build.unsupported.append(f"{path} (excluded from capture)")
            continue
        if binary:
            build.unsupported.append(f"{path} (binary)")
            continue
        in_scope_changes.append(c)

    # gather hunks (works for renames too: diff with explicit commits)
    hunks_by_path: dict[str, list[Hunk]] = {}
    for c in in_scope_changes:
        path = c.new_path or c.old_path or ""
        try:
            raw_hunks = file_hunks(repo, cap.base.commit, cap.head.commit, path)
        except GitError as exc:
            build.gaps.append(f"{path}: cannot compute hunks: {exc}")
            continue
        hunks_by_path[path] = [
            Hunk(path=path, old_start=h.old_start, old_lines=h.old_lines, new_start=h.new_start, new_lines=h.new_lines)
            for h in raw_hunks
        ]
    build.hunks_in_scope = sum(len(v) for v in hunks_by_path.values())

    reader = BlobReader(repo)
    try:
        changed_symbol_spans: list[tuple[str, str, SymbolDecl]] = []  # (side, role, decl)

        head_by_file: dict[str, list[SymbolDecl]] = graphs.head.by_path
        base_by_file: dict[str, list[SymbolDecl]] = graphs.base.by_path

        for c in in_scope_changes:
            new_p, old_p = c.new_path, c.old_path
            target = new_p or old_p or ""
            new_h = hunks_by_path.get(target, [])
            head_decls_here = set()
            if c.status in ("A", "R", "M", "T", "mode-only"):
                for decl in head_by_file.get(target, []):
                    if c.status == "A" or any(
                        _intersects(decl.start_line, decl.end_line, h.new_start, h.new_start + max(h.new_lines, 1) - 1)
                        for h in new_h
                    ):
                        role = "added-file" if c.status == "A" else ("renamed" if c.status == "R" else "modified")
                        changed_symbol_spans.append((Endpoint.HEAD.value, role, decl))
                        head_decls_here.add(decl.ident)
            base_path = old_p or target
            if c.status in ("D", "R", "M", "T", "mode-only"):
                for decl in base_by_file.get(base_path, []):
                    intersects = c.status == "D" or any(
                        _intersects(decl.start_line, decl.end_line, h.old_start, h.old_start + max(h.old_lines, 1) - 1)
                        for h in new_h
                    )
                    if not intersects:
                        continue
                    # The base half of a paired change already produced a head-side
                    # unit; emit a separate base unit only for deletions or when the
                    # base declaration has no head counterpart in this diff.
                    matched_head = graphs.matches.get(decl.ident)
                    if matched_head and matched_head in head_decls_here:
                        continue
                    role = "deleted-file" if c.status == "D" else ("renamed" if c.status == "R" else "modified")
                    changed_symbol_spans.append((Endpoint.BASE.value, role, decl))

        # symbol-less units for changed files with hunks
        unit_items: list[tuple[str, str, SymbolDecl | None, list[Hunk]]] = []
        covered_files: set[str] = set()
        for side, role, decl in changed_symbol_spans:
            path = decl.path
            unit_items.append((side, role, decl, hunks_by_path.get(path, [])))
            covered_files.add(path)
        for path, hunks in hunks_by_path.items():
            if hunks and path not in covered_files:
                c_side = Endpoint.HEAD.value if any((c.new_path == path) for c in in_scope_changes) else Endpoint.BASE.value
                unit_items.append((c_side, "top-level", None, hunks))

        unit_items = unit_items[: limits.max_units]
        dropped = max(0, len(unit_items) - limits.max_units)
        if dropped:
            build.omitted.append(f"{dropped} additional changed items exceeded max_units={limits.max_units}")

        for index, (side_name, role, decl, hunks) in enumerate(unit_items, 1):
            unit = _build_one(cap, graphs, flows, sessions, build, reader, repo,
                              index, side_name, role, decl, hunks, limits)
            build.units.append(unit)
        return build
    finally:
        reader.close()


def _build_one(cap, graphs, flows, sessions, build, reader, repo,
               index, side_name, role, decl, hunks, limits) -> ReviewUnit:
    side = cap.head if side_name == "head" else cap.base
    other = cap.base if side_name == "head" else cap.head
    path = decl.path if decl else (hunks[0].path if hunks else "")
    gaps: list[str] = []
    omitted: list[str] = []

    # ---- headers / before/after code
    def decl_text(text: str | None, start_line: int, end_line: int) -> str:
        if text is None:
            return "(file not readable in this snapshot)"
        lines = text.splitlines()
        lo = max(1, start_line)
        hi = min(len(lines), end_line)
        return "\n".join(f"{i + 1}\t{lines[i]}" for i in range(lo - 1, hi))

    if decl:
        text = _read_text(reader, side, decl.path)
        before_after = [f"[{side_name} {decl.path}:{decl.start_line}-{decl.end_line} ({decl.kind}{' exported' if decl.exported else ''})]"]
        before_after.append(decl_text(text, decl.start_line, decl.end_line))
        # counterpart before/after when visible in both endpoints
        counterpart_path = None
        for c in build.changes:
            if decl.path == c.new_path:
                counterpart_path = c.old_path
            elif decl.path == c.old_path:
                counterpart_path = c.new_path
        if counterpart_path and counterpart_path != decl.path:
            other_texts = _read_text(reader, other, counterpart_path)
            if other_texts:
                o_lines = other_texts.splitlines()
                lo, hi = 1, min(len(o_lines), 400)
                before_after.append(f"[{'base' if side_name == 'head' else 'head'} {counterpart_path}]")
                before_after.append("\n".join(f"{i + 1}\t{o_lines[i]}" for i in range(lo - 1, hi)))
    else:
        text = _read_text(reader, side, path)
        snippet = ""
        if text:
            lines = text.splitlines()
            windows = [f"lines {h.new_start}-{h.new_start + max(h.new_lines, 1) - 1}" for h in hunks]
            shown = []
            for h in hunks[:6]:
                lo = max(1, h.new_start - 1)
                hi = min(len(lines), h.new_start + max(h.new_lines, 1) + 4)
                shown.append(f"// ... {windows[len(shown)]} ...\n" + "\n".join(f"{i + 1}\t{lines[i]}" for i in range(lo - 1, hi)))
            snippet = "\n".join(shown)
        before_after = [f"[{side_name} {path} (top-level change)]", snippet or "(no hunk text available)"]

    changed_symbols = [decl.ident] if decl else []
    changed_symbol_names = [decl.name] if decl else []

    # ---- relationships: callers (both endpoints), callees, dependents
    from .contracts import Basis, Location, Relationship, RelationshipKind
    from .indexer import abs_nearest_tsconfig

    relationships: list = []
    external_relationships = 0
    session = sessions.get(Endpoint(side_name))
    side_side = side
    tsconfig_abs = abs_nearest_tsconfig(side_side, None, (decl.path if decl else path)) if session is not None else ""
    if decl and session is not None:
        try:
            resp = session.references(decl.path, decl.start_line, decl.name, tsconfig_abs, limits.max_reference_sites)
        except Exception as exc:  # worker died mid-call
            resp = {"ok": False, "error": str(exc)}
        if resp.get("ok"):
            refs = resp.get("references", [])
            if resp.get("truncated"):
                omitted.append("reference sites truncated at cap")
            for ref in refs:
                if ref["path"] == decl.path and abs(ref["line"] - decl.start_line) <= decl.end_line - decl.start_line + 1:
                    continue  # the declaration itself
                ref_entry = side_side.allowed.get(ref["path"])
                if ref_entry is None:
                    external_relationships += 1
                    continue
                relationships.append(
                    Relationship(
                        source=f"{ref['path']}:{ref['line']}",
                        target=decl.ident,
                        kind=RelationshipKind.REFERENCES,
                        basis=Basis.COMPILER_RESOLVED,
                        evidence=Location(
                            endpoint=Endpoint.BASE if side_name == "base" else Endpoint.HEAD,
                            path=ref["path"],
                            blob_id=ref_entry.sha,
                            start_line=ref["line"],
                            end_line=ref["line"],
                        ),
                    )
                )
        else:
            gaps.append(f"references unresolved for {decl.ident}: {resp.get('error')}")
    elif decl and session is None:
        gaps.append("semantic layer unavailable; callers/references not indexed")

    # callees for changed decls
    if decl and session is not None:
        try:
            resp = session.calls(decl.path, decl.start_line, decl.end_line, tsconfig_abs)
        except Exception as exc:
            resp = {"ok": False, "error": str(exc)}
        if resp.get("ok"):
            for edge in resp.get("edges", []):
                target_path = edge.get("target_path") or ""
                if not target_path:
                    if edge.get("note"):
                        external_relationships += 1
                    continue
                if target_path.split("#")[0] not in side_side.allowed:
                    external_relationships += 1
                    continue
                relationships.append(
                    Relationship(
                        source=decl.ident,
                        target=f"{target_path}#{edge.get('target_name') or '?'}",
                        kind=RelationshipKind.CALLS,
                        basis=Basis.COMPILER_RESOLVED if edge.get("basis") == "compiler-resolved" else Basis.CANDIDATE,
                        evidence=Location(
                            endpoint=Endpoint.BASE if side_name == "base" else Endpoint.HEAD,
                            path=decl.path,
                            blob_id=decl.blob_id,
                            start_line=edge["line"],
                            end_line=edge["line"],
                        ),
                    )
                )
            if resp.get("unresolved_sites"):
                gaps.append(f"{resp['unresolved_sites']} dynamic/indirect call sites in {decl.ident} not statically resolved")
        else:
            gaps.append(f"call graph unresolved for {decl.ident}: {resp.get('error')}")

    # dedup, then drop any residual external targets; count what we dropped
    seen_relationships = set()
    deduped_relationships = []
    for rel in relationships:
        key = (rel.kind, rel.source, rel.target, rel.evidence.path, rel.evidence.start_line)
        if key in seen_relationships:
            continue
        seen_relationships.add(key)
        deduped_relationships.append(rel)
    relationships = deduped_relationships
    if external_relationships:
        omitted.append(f"{external_relationships} relationship(s) to external/vendored files omitted")

    # dependents (files importing the changed file) — cheap declared edges
    changed_paths = {decl.path} if decl else {h.path for h in hunks}
    dependent_files = set()
    for ep_graph in (graphs.base, graphs.head):
        for edge in ep_graph.imports:
            if edge.target in changed_paths:
                dependent_files.add(f"{edge.endpoint}:{edge.path}")
            if edge.target and edge.target.endswith("/index.ts") and any(
                p.startswith(edge.target[: -len("/index.ts")] + "/") for p in changed_paths
            ):
                dependent_files.add(f"{edge.endpoint}:{edge.path}")
    if len(dependent_files) > 20:
        dependent_files = set(sorted(dependent_files)[:20])
        omitted.append("dependent files list truncated at 20")

    # ---- flows & clauses
    flow_matches = match_flows(flows, list(changed_paths), changed_symbol_names)
    stale_checked = check_clause_anchors(flow_matches, set(side.allowed))
    for match in stale_checked:
        if match.stale_clauses:
            gaps.append(f"flow {match.flow_id}: stale clause anchors {match.stale_clauses}")

    clauses: list[str] = []
    for match in stale_checked:
        clauses.extend(match.clauses)

    # ---- assemble context with hard budget
    sections: list[str] = []
    sections.append(f"# Review unit: {rel_title(decl, path, role)}\nrole={role} endpoint={side_name}")
    sections.append("## Changed hunks\n" + ("\n".join(
        f"{h.path}: base {h.old_start}+{h.old_lines} -> head {h.new_start}+{h.new_lines}" for h in hunks
    ) or "(no textual hunks; mode/rename or deletion)"))
    sections.append("## Code\n" + "\n".join(before_after))
    if relationships:
        refs = "\n".join(
            f"- {r.kind.value} {r.source} -> {r.target} [{r.basis.value}] ({r.evidence.endpoint.value}:{r.evidence.path}:{r.evidence.start_line})"
            for r in relationships[:60]
        )
        sections.append("## Relationships (bounded)\n" + refs)
    if dependent_files:
        sections.append("## Dependents (declared imports)\n" + "\n".join(f"- {d}" for d in sorted(dependent_files)))
    if clauses:
        sections.append("## Design clauses to consider\n" + "\n".join(f"- {c}" for c in dict.fromkeys(clauses)))
    if gaps:
        sections.append("## Explicit gaps\n" + "\n".join(f"- {g}" for g in gaps))

    context = "\n\n".join(sections)
    if len(context.encode()) > limits.unit_context_bytes:
        over = len(context.encode()) - limits.unit_context_bytes
        # The code section is sections[2] by construction; clip it first,
        # keep relationships and gaps intact, and record the omission.
        sections[2] = sections[2][: limits.unit_context_bytes // 2]
        sections.append("## Omissions\n- unit context exceeded budget; code section clipped, deeper context omitted")
        omitted.append(f"unit context over budget ({over} bytes over); code section clipped")
        context = "\n\n".join(sections)
        if len(context.encode()) > limits.unit_context_bytes:
            gaps.append("unit remains over context budget after clipping; treating as partial")

    omitted_note = list(dict.fromkeys(omitted))
    unit = ReviewUnit(
        unit_id=f"u{index:03d}",
        title=rel_title(decl, path, role),
        hunks=hunks,
        changed_symbols=changed_symbols,
        relationships=relationships,
        design_clauses=list(dict.fromkeys(clauses)),
        context=context,
        context_bytes=len(context.encode()),
        omitted=omitted_note,
        gaps=gaps,
    )
    return unit


def rel_title(decl, path, role) -> str:
    if decl:
        return f"{path}: {decl.enclosing + '/' if decl.enclosing else ''}{decl.name} ({decl.kind})"
    return f"{path} (top-level change)"
