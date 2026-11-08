"""Artifact writers: report.json, report.md, manifest.json.

Durable whole-file writes (tmp + os.replace). Artifacts live outside tracked
source at an explicit output path. The manifest is the proof of a finished
report; a partial write is a failed manifest, never a "clean" report.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .contracts import ReviewResult


def _write_durable(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_manifest(result, report_json: bytes, report_md: bytes, extras: dict) -> dict:
    request = getattr(result, "request", None)
    snapshot = getattr(result, "snapshot", None)
    return {
        "manifest_version": 1,
        "status": result.status,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base_ref": getattr(request, "base_ref", None),
        "head_ref": getattr(request, "head_ref", None),
        "base_commit": getattr(getattr(snapshot, "base", None), "commit", None),
        "head_commit": getattr(getattr(snapshot, "head", None), "commit", None),
        "merge_base": getattr(snapshot, "merge_base", None),
        "report_json_sha256": _sha256(report_json),
        "report_md_sha256": _sha256(report_md),
        "findings": len(getattr(result, "findings", []) or []),
        "units_total": getattr(getattr(result, "coverage", None), "units_total", None),
        "extras": extras,
    }


def to_markdown(result) -> str:
    lines: list[str] = []
    lines.append("# Code review report")
    lines.append("")
    lines.append(f"- Status: **{result.status}**")
    if result.status == "failed":
        lines += [f"- Failed stage: `{result.failed_stage}`", f"- Cause: {result.cause}"]
        return "\n".join(lines) + "\n"

    snap = result.snapshot
    lines += [
        f"- Base: `{snap.base.commit}` (tree `{snap.base.tree}`, {snap.base.file_count} files)",
        f"- Head: `{snap.head.commit}` (tree `{snap.head.tree}`, {snap.head.file_count} files)",
        f"- Mode: `{result.request.mode.value}`" + (f" (merge base `{snap.merge_base}`)" if snap.merge_base else ""),
        f"- Discovery model: `{result.request.discovery_model.provider}:{result.request.discovery_model.model_id}`",
        f"- Challenge model: `{result.request.challenge_model.provider}:{result.request.challenge_model.model_id}`",
        f"- Duration: {result.duration_seconds:.1f}s",
    ]
    if result.applicability:
        lines.append(f"- Applicability: {result.applicability}")
    if result.analyzer.get("requested_base"):
        lines.append(f"- Fork point: requested base `{result.analyzer['requested_base'][:12]}` — review covers `merge-base..head`")
    lines.append("")

    findings = result.findings
    lines.append(f"## Findings ({len(findings)})")
    lines.append("")
    if not findings:
        lines.append("No supported findings in the assessed scope.")
        lines.append("")
    for i, finding in enumerate(findings, 1):
        lines += [
            f"### {i}. [{finding.severity}] {finding.changed_cause}",
            f"- Trigger: {finding.trigger}",
            f"- Execution path: {finding.execution_path}",
            f"- Violated contract: {finding.violated_contract}",
            f"- Consequence: {finding.consequence}",
            f"- Severity rationale: {finding.severity_rationale}",
            f"- Disproof pass: **{finding.disproof.outcome.value}** — {finding.disproof.rationale}",
            "- Locations:",
        ]
        for loc in finding.locations:
            lines.append(f"  - `{loc.endpoint.value}:{loc.path}:{loc.start_line}-{loc.end_line}` (blob `{loc.blob_id[:12]}`)")
        lines.append("")

    if result.preexisting_candidates:
        lines.append(f"## Pre-existing defects ({len(result.preexisting_candidates)}) — not introduced by this change")
        for cand in result.preexisting_candidates:
            lines.append(f"- {cand.violated_contract}: {cand.consequence}")
        lines.append("")

    cov = result.coverage
    lines += [
        "## Coverage",
        f"- Units assessed: {cov.units_assessed}/{cov.units_total}",
        f"- Hunks in scope: {cov.hunks_in_scope}",
        f"- Sources read: {cov.sources_read}",
    ]
    for label, items in [
        ("Omitted context", cov.omitted),
        ("Unresolved relations", cov.unresolved_relations),
        ("Unsupported files", cov.unsupported_files),
        ("Budget exhausted", cov.budget_exhausted),
        ("Failures", cov.failures),
    ]:
        if items:
            lines.append(f"- {label} ({len(items)}):")
            lines += [f"  - {item}" for item in items]
    for unit in cov.per_unit:
        tokens = (
            f"{unit.input_tokens}/{unit.output_tokens} tok"
            if unit.input_tokens is not None
            else "tokens unknown"
        )
        lines.append(
            f"  - `{unit.unit_id}` {unit.status} — {unit.tool_calls} tool calls, "
            f"{unit.bytes_read} B read, {unit.wall_seconds:.1f}s, {tokens}"
            + (f" — gaps: {', '.join(unit.gaps)}" if unit.gaps else "")
        )
    if result.unresolved_candidates:
        lines.append(f"- Unresolved candidates: {len(result.unresolved_candidates)} (not findings; kept for inspection)")
    lines.append("")
    lines.append(
        "Complete means the declared review work finished, not that all bugs were found. "
        "This report never grants merge authority."
    )
    return "\n".join(lines) + "\n"


def write_artifacts(result, output_dir: str | None, extras: dict | None = None) -> str:
    if output_dir is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        output_dir = tempfile.mkdtemp(prefix=f"goblin-code-review-{stamp}-")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    report_json = json.dumps(result.model_dump(mode="json"), indent=2, sort_keys=False).encode()
    report_md = to_markdown(result).encode()
    _write_durable(out / "report.json", report_json)
    _write_durable(out / "report.md", report_md)
    extras = extras or {}
    manifest = build_manifest(result, report_json, report_md, extras)
    _write_durable(out / "manifest.json", json.dumps(manifest, indent=2).encode())
    return str(out)
