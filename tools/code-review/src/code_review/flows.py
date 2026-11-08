"""Declarative flow registry: load, validate, match.

The registry routes context; it is never executed as code and never
standing policy. Missing or stale anchors are reported as gaps.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from .gitio import BlobReader


@dataclass(frozen=True)
class Flow:
    id: str
    description: str
    path_patterns: list[re.Pattern[str]]
    symbol_patterns: list[re.Pattern[str]]
    clauses: list[str]


@dataclass
class FlowMatch:
    flow_id: str
    clauses: list[str]
    stale_clauses: list[str]


def load_flows(path: Path | None = None) -> tuple[list[Flow], list[str]]:
    path = path or Path(__file__).with_name("flows.yaml")
    errors: list[str] = []
    raw = yaml.safe_load(path.read_text())
    flows: list[Flow] = []
    for i, entry in enumerate(raw.get("flows", [])):
        try:
            path_patterns = [re.compile(p) for p in entry["path_patterns"]]
            symbol_patterns = [re.compile(p, re.IGNORECASE) for p in entry.get("symbol_patterns", [])]
            flows.append(
                Flow(
                    id=entry["id"],
                    description=entry.get("description", ""),
                    path_patterns=path_patterns,
                    symbol_patterns=symbol_patterns,
                    clauses=list(entry.get("clauses", [])),
                )
            )
        except (KeyError, re.error) as exc:
            errors.append(f"flow #{i} invalid: {exc}")
    return flows, errors


def match_flows(flows: list[Flow], changed_paths: list[str], changed_symbols: list[str]) -> list[FlowMatch]:
    out: list[FlowMatch] = []
    for flow in flows:
        hit_path = any(p.search(path) for p in flow.path_patterns for path in changed_paths)
        hit_symbol = any(p.search(sym) for p in flow.symbol_patterns for sym in changed_symbols)
        if hit_path or hit_symbol:
            out.append(FlowMatch(flow_id=flow.id, clauses=list(flow.clauses), stale_clauses=[]))
    return out


def check_clause_anchors(matches: list[FlowMatch], allowed_paths: set[str]) -> list[FlowMatch]:
    """Flag clause references that do not exist in the captured source set."""
    checked: list[FlowMatch] = []
    for match in matches:
        stale = [c for c in match.clauses if not c.startswith(("DESIGN.md", "AGENTS.md", "DIRECTION.md")) and c not in allowed_paths]
        checked.append(FlowMatch(flow_id=match.flow_id, clauses=match.clauses, stale_clauses=stale))
    return checked


def clause_texts(reader: BlobReader, allowed: dict, clauses: list[str], byte_budget: int) -> list[tuple[str, str, bool]]:
    """Return (clause, text, truncated) for clause references that are repo paths."""
    out: list[tuple[str, str, bool]] = []
    remaining = byte_budget
    for clause in clauses:
        if clause not in allowed:
            out.append((clause, "(not present in captured source set)", False))
            continue
        raw = reader.read(allowed[clause].sha)
        text = raw.decode("utf-8", "replace")
        truncated = False
        if len(text.encode()) > remaining:
            text = text[:remaining]
            truncated = True
        remaining = max(0, remaining - len(text.encode()))
        out.append((clause, text, truncated))
        if remaining <= 0:
            break
    return out
