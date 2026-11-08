"""End-to-end review pipeline (design/code-review.md §Pipeline).

Stage failure semantics:
  capture / config        → status=failed (nothing was reviewed)
  load-policy / index     → status=failed (pipeline cannot proceed soundly)
  units / discover /      → status=partial with explicit gaps (findings that
  challenge                 were produced are still reported)
  report                  → always produced; manifest marks it finished
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from . import report as report_mod
from .agents import build_model, check_distinct, check_key_envs, extract_json, make_schema_check, ModelConfigError
from .budget import BudgetExhausted, BudgetState
from .capture import capture, cleanup, snapshot
from .contracts import (
    Candidate,
    ChallengeOutcome,
    ChallengeResult,
    Endpoint,
    Finding,
    ReviewComplete,
    ReviewFailed,
    ReviewPartial,
    ReviewRequest,
    UnitAccounting,
    Coverage,
)
from .flows import load_flows
from .gitio import BlobReader, GitError, blob_text, raw_diff, resolve_ref
from .indexer import index_side, match_symbols, open_semantic_session
from .jsonl import emit, step_callback_factory
from .policy import load_policy
from .tools import ToolContext, build_tools
from .units import build_units


DISCOVERY_INSTRUCTIONS = """You are a meticulous defect finder reviewing ONE bounded unit of a code change.
You are not an author: you never modify code, never approve it, and never
invent contracts. Report only defects introduced by this change that have
a concrete trigger and a concrete consequence. Style, scale speculation,
feature requests, and "might be a problem someday" are out of scope.
An untested claim stays untested: propose, don't assert.

Output contract: reply with ONLY a JSON object
{"candidates":[{"changed_cause":"...","trigger":"<the concrete input/order that triggers it>",
"execution_path":"<how the trigger reaches the defect, via real callers>",
"violated_contract":"<the contract this breaks — cite it>","consequence":"<observable harm>",
"locations":[{"endpoint":"head","path":"src/x.ts","start_line":10,"end_line":20}],
"proposed_severity":"critical|high|medium|low","severity_rationale":"<material consequence x realistic trigger>"}]}
If there is no defect, return {"candidates": []}.
Locations must reference endpoint (base|head), repo-relative path, and line ranges.
"""

CHALLENGE_INSTRUCTIONS = """You are an independent defect challenger. You receive ONE candidate defect
report written by a different model reviewing a change you have not reviewed.
Your task is to try to DISPROVE it — not to defend it, and not to rubber-stamp it.

Answer these questions using your read-only tools (all reads are from immutable snapshots):
1. Is the cited code present at the stated endpoint and location?
2. Does the proposed input/order reach this path through real callers?
3. Is validation, fencing, transactionality, or recovery already provided elsewhere?
4. Is the defect introduced or made reachable by this change? What differs at the base?
5. Does the claimed consequence follow? Is the alleged contract current?

Output contract: reply with ONLY a JSON object
{"outcome":"supported|disproved|unresolved","rationale":"<what the evidence shows>",
"evidence":[{"endpoint":"head","path":"src/x.ts","start_line":10,"end_line":20}]}
Use 'unresolved' when the evidence is insufficient to decide. Never upgrade
'unresolved' to 'supported'."""


def _pydantic_models():
    from pydantic import BaseModel

    from .contracts import Location

    class CandidatesPayload(BaseModel):
        candidates: list[Candidate] = []

    class ChallengePayload(BaseModel):
        outcome: ChallengeOutcome
        rationale: str
        evidence: list[Location] = []

    return CandidatesPayload, ChallengePayload


def _fix_locations(cap, locations: list) -> list:
    """Bind each model-supplied location to the recorded blob and bounds-check it."""
    fixed = []
    repo = cap.request.repository
    for loc in locations:
        side = cap.side(loc.endpoint)
        entry = side.allowed.get(loc.path)
        if entry is None:
            continue
        try:
            text = blob_text(repo, entry.sha)
        except GitError:
            continue
        total = max(1, len(text.splitlines()))
        start = max(1, min(loc.start_line, total))
        end = max(start, min(loc.end_line, total))
        from .contracts import Location

        fixed.append(Location(endpoint=loc.endpoint, path=loc.path, blob_id=entry.sha, start_line=start, end_line=end))
    return fixed


def _candidate_key(candidate: Candidate) -> tuple[str, str]:
    norm = lambda s: " ".join(s.lower().split())[:160]
    return (norm(candidate.violated_contract), norm(candidate.changed_cause))


def _fresh_unit_ctx(shared: ToolContext, budget: BudgetState) -> ToolContext:
    """Shallow-clone the shared tool context with a fresh per-unit budget.

    read_log and unresolved are shared references so evidence from the unit's
    tools lands in the run-wide log; budgets are per-unit by design.
    """
    unit_ctx = ToolContext.__new__(ToolContext)
    unit_ctx.__dict__.update(shared.__dict__)
    unit_ctx.budget = budget
    return unit_ctx


def run_review(request: ReviewRequest, *, output_dir: str | None = None, install_deps: bool = False) -> dict:
    started = time.monotonic()

    def fail(stage: str, cause: str) -> dict:
        try:
            result = ReviewFailed(request=request, failed_stage=stage, cause=cause,
                                  duration_seconds=time.monotonic() - started)
        except Exception:
            # the failure path itself must never raise; keep the artifact and note it
            result = ReviewFailed.model_construct(request=request, failed_stage=stage,
                                                  cause=f"{cause} (note: request revalidation failed on the failure path)",
                                                  duration_seconds=time.monotonic() - started)
        report_mod.write_artifacts(result, output_dir)
        return result.model_dump(mode="json")

    try:
        check_distinct(request.discovery_model, request.challenge_model)
        check_key_envs(request)
    except ModelConfigError as exc:
        return fail("config", str(exc))

    try:
        cap = capture(request, install_deps=install_deps)
    except GitError as exc:
        return fail("capture", str(exc))
    emit("capture", base=cap.base.commit, head=cap.head.commit, merge_base=cap.merge_base)

    try:
        result = _run_pipeline(request, cap, started, output_dir=output_dir)
    except Exception as exc:
        emit("fatal", stage="pipeline", error=f"{type(exc).__name__}: {exc}")
        cleanup(cap)
        return fail("pipeline", f"{type(exc).__name__}: {exc}")
    cleanup(cap)
    return result


def _run_pipeline(request: ReviewRequest, cap, started: float, *, output_dir: str | None) -> dict:
    limits = request.limits
    repo = request.repository

    # ---- policy + flows (from the pinned BASE snapshot)
    base_reader = BlobReader(repo)
    try:
        policy = load_policy(base_reader, cap.base.allowed, limits.policy_bytes)
        flows, flow_errors = load_flows()
    finally:
        base_reader.close()
    for err in flow_errors:
        emit("flow_error", detail=err)
    emit("policy", files=policy.loaded_files, missing=policy.missing_files, truncated=policy.truncated_files)
    if policy.missing_files:
        emit("policy_missing", files=policy.missing_files)

    # ---- semantic sessions (shared between indexer and tools)
    sessions: dict[Endpoint, object | None] = {}
    tsconfigs: dict[Endpoint, list[str]] = {}
    index_gaps: list[str] = []
    for side in (cap.base, cap.head):
        ep = Endpoint.BASE if side is cap.base else Endpoint.HEAD
        session, gaps, tcs, _tv = open_semantic_session(cap, side)
        sessions[ep] = session
        tsconfigs[ep] = tcs
        index_gaps.extend(gaps)

    # ---- index both endpoints
    base_graph = index_side(cap, cap.base, session=sessions[Endpoint.BASE],
                            tsconfigs=tsconfigs[Endpoint.BASE],
                            gaps=[g for g in index_gaps if g.startswith("base")])
    head_graph = index_side(cap, cap.head, session=sessions[Endpoint.HEAD],
                            tsconfigs=tsconfigs[Endpoint.HEAD],
                            gaps=[g for g in index_gaps if g.startswith("head")])
    changes = raw_diff(repo, cap.base.commit, cap.head.commit)
    rename_map = {c.old_path: c.new_path for c in changes if c.status == "R" and c.old_path and c.new_path}
    pair = match_symbols(base_graph, head_graph, rename_map)
    emit("index", base_symbols=len(base_graph.symbols), head_symbols=len(head_graph.symbols),
         matched=len(pair.matches), deleted=len(pair.deleted), gaps=len(base_graph.gaps) + len(head_graph.gaps))

    # ---- units
    unit_build = build_units(cap, pair, flows, sessions)
    emit("units", total=len(unit_build.units), hunks=unit_build.hunks_in_scope,
         unsupported=len(unit_build.unsupported))

    base_budget = BudgetState(wall_seconds=limits.unit_wall_seconds,
                              token_ceiling=limits.unit_token_ceiling,
                              bytes_ceiling=limits.tool_budget_bytes,
                              calls_ceiling=limits.tool_calls_per_unit)
    tool_ctx = ToolContext(cap, limits, base_budget, flows)
    tool_ctx.sessions = sessions
    tool_ctx.tsconfigs = tsconfigs

    # ---- discover (fresh session per unit)
    per_unit: list[UnitAccounting] = []
    all_candidates: list[tuple[str, Candidate]] = []
    unresolved_candidates: list[dict] = []

    try:
        discovery_model = build_model(request.discovery_model)
    except ModelConfigError as exc:
        return _fail_with_cleanup(request, cap, sessions, "discover", str(exc), started, output_dir)

    for unit in unit_build.units:
        outcome = _discover_unit(request=request, cap=cap, unit=unit,
                                 policy_text=policy.trusted_text, model=discovery_model,
                                 limits=limits, shared_ctx=tool_ctx)
        per_unit.append(outcome["accounting"])
        all_candidates.extend((unit.unit_id, c) for c in outcome["candidates"])
        unresolved_candidates.extend(outcome["unresolved"])

    tool_ctx.close()

    # Total model-boundary failure: nothing was reviewed, so this is a failed
    # review, not a "partial" one that could read as a clean zero-finding pass.
    if per_unit and all(u.status == "failed" for u in per_unit):
        first = next((g for u in per_unit for g in u.gaps), "unknown")
        return _fail_with_cleanup(
            request, cap, sessions, "discover",
            f"discovery failed for all {len(per_unit)} units; first failure: {first}",
            started, output_dir,
        )

    # ---- challenge (fresh session per candidate, different model)
    try:
        challenge_model = build_model(request.challenge_model)
    except ModelConfigError as exc:
        return _fail_with_cleanup(request, cap, sessions, "challenge", str(exc), started, output_dir)

    challenge_budget = BudgetState(wall_seconds=limits.challenge_wall_seconds,
                                   token_ceiling=limits.challenge_token_ceiling,
                                   bytes_ceiling=limits.tool_budget_bytes,
                                   calls_ceiling=limits.tool_calls_per_unit)
    challenge_ctx = ToolContext(cap, limits, challenge_budget, flows)
    challenge_ctx.sessions = sessions
    challenge_ctx.tsconfigs = tsconfigs

    challenge_outcomes: list[dict] = []
    findings_by_key: dict[tuple[str, str], Finding] = {}
    if not all_candidates:
        emit("challenge", skipped=True, reason="no candidates; challenge pass not run")

    for index, (unit_id, candidate) in enumerate(all_candidates, 1):
        outcome = _challenge_candidate(request=request, cap=cap, candidate=candidate,
                                       unit_id=unit_id, model=challenge_model,
                                       limits=limits, shared_ctx=challenge_ctx)
        challenge_outcomes.append({"unit_id": unit_id, "index": index,
                                   "outcome": outcome.outcome.value, "rationale": outcome.rationale})
        if outcome.outcome is ChallengeOutcome.SUPPORTED:
            key = _candidate_key(candidate)
            if key not in findings_by_key:
                findings_by_key[key] = Finding(
                    changed_cause=candidate.changed_cause,
                    trigger=candidate.trigger,
                    execution_path=candidate.execution_path,
                    violated_contract=candidate.violated_contract,
                    consequence=candidate.consequence,
                    locations=candidate.locations,
                    severity=candidate.proposed_severity,
                    severity_rationale=candidate.severity_rationale,
                    disproof=outcome,
                )
        elif outcome.outcome is ChallengeOutcome.UNRESOLVED:
            unresolved_candidates.append({"unit_id": unit_id,
                                          "candidate": candidate.model_dump(mode="json"),
                                          "rationale": outcome.rationale})

    challenge_ctx.close()
    for s in sessions.values():
        try:
            if s:
                s.close()
        except Exception:
            pass

    # ---- applicable vs pre-existing
    head_changed_paths = {(c.new_path or c.old_path) for c in unit_build.changes if (c.new_path or c.old_path)}
    findings: list[Finding] = []
    preexisting: list[Candidate] = []
    for finding in findings_by_key.values():
        base_only = finding.locations and all(loc.endpoint is Endpoint.BASE for loc in finding.locations)
        outside_change = all(loc.path not in head_changed_paths for loc in finding.locations)
        if base_only and outside_change:
            preexisting.append(Candidate(
                changed_cause=finding.changed_cause, trigger=finding.trigger,
                execution_path=finding.execution_path, violated_contract=finding.violated_contract,
                consequence=finding.consequence, locations=finding.locations,
                proposed_severity=finding.severity, severity_rationale=finding.severity_rationale))
            continue
        findings.append(finding)
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    findings.sort(key=lambda f: severity_order.get(f.severity, 4))

    # ---- coverage
    index_gap_list = list(dict.fromkeys(base_graph.gaps + head_graph.gaps + index_gaps))
    read_log = list(tool_ctx.read_log) + list(challenge_ctx.read_log)
    unresolved_relations = list(dict.fromkeys(tool_ctx.unresolved + challenge_ctx.unresolved))
    unsupported = list(dict.fromkeys(unit_build.unsupported))
    budget_exhausted = [u.unit_id for u in per_unit if u.status == "budget-exhausted"]
    failures = [u.unit_id for u in per_unit if u.status == "failed"]

    coverage = Coverage(
        units_total=len(unit_build.units),
        units_assessed=sum(1 for u in per_unit if u.status == "assessed"),
        hunks_in_scope=unit_build.hunks_in_scope,
        sources_read=len(read_log),
        read_log=read_log,
        unresolved_relations=unresolved_relations,
        omitted=list(dict.fromkeys(unit_build.omitted + index_gap_list)),
        unsupported_files=unsupported,
        budget_exhausted=budget_exhausted,
        failures=failures,
        per_unit=per_unit,
    )

    snap = snapshot(cap)
    analyzer = cap.analyzer()
    applicability = _check_ref_drift(repo, cap)

    gap_count = (len(coverage.unresolved_relations) + len(coverage.omitted) + len(coverage.unsupported_files)
                 + len(coverage.budget_exhausted) + len(coverage.failures)
                 + sum(len(u.gaps) for u in per_unit) + len(unresolved_candidates))
    complete = (
        per_unit
        and coverage.units_assessed == coverage.units_total
        and gap_count == 0
        and all(u.status == "assessed" for u in per_unit)
    )
    duration = time.monotonic() - started

    if complete:
        result = ReviewComplete(request=request, snapshot=snap, analyzer=analyzer,
                                findings=findings, preexisting_candidates=preexisting,
                                coverage=coverage, applicability=applicability,
                                duration_seconds=duration)
    else:
        if gap_count == 0:
            # e.g. all units skipped (no changes) with no other signal to mark partial
            coverage.unsupported_files.append("no assessable units were produced; nothing was reviewed")
        result = ReviewPartial(request=request, snapshot=snap, analyzer=analyzer,
                               findings=findings, preexisting_candidates=preexisting,
                               unresolved_candidates=unresolved_candidates,
                               coverage=coverage, applicability=applicability,
                               duration_seconds=duration)

    artifact_dir = report_mod.write_artifacts(result, output_dir, extras={"challenge_outcomes": challenge_outcomes})
    emit("report", dir=artifact_dir, status=result.status, findings=len(result.findings))
    return result.model_dump(mode="json")


def _fail_with_cleanup(request, cap, sessions, stage, cause, started, output_dir):
    cleanup(cap)
    for s in sessions.values():
        try:
            if s:
                s.close()
        except Exception:
            pass
    result = ReviewFailed(request=request, failed_stage=stage, cause=cause,
                          duration_seconds=time.monotonic() - started)
    report_mod.write_artifacts(result, output_dir)
    return result.model_dump(mode="json")


def _check_ref_drift(repo: str, cap) -> str:
    from .contracts import ComparisonMode
    from .gitio import merge_base

    try:
        head_now = resolve_ref(repo, cap.request.head_ref)
        if cap.request.mode is ComparisonMode.FORK_POINT:
            base_now = resolve_ref(repo, cap.request.base_ref)
            try:
                base_cmp = merge_base(repo, base_now, head_now)
            except GitError:
                base_cmp = None
            base_moved = base_cmp != cap.base.commit
            head_moved = head_now != cap.head.commit
            if not base_moved and not head_moved:
                return "endpoints unchanged; report is valid for its recorded commits"
            moved = [n for n, changed in (("base", base_moved), ("head", head_moved)) if changed]
            return f"requested refs moved ({', '.join(moved)}) after capture; report remains valid only for recorded commits"
        base_now = resolve_ref(repo, cap.request.base_ref)
    except Exception:
        return "refs could not be re-resolved at completion"
    if base_now == cap.base.commit and head_now == cap.head.commit:
        return "endpoints unchanged; report is valid for its recorded commits"
    moved = [n for n, now, then in (("base", base_now, cap.base.commit), ("head", head_now, cap.head.commit)) if now != then]
    return f"requested refs moved ({', '.join(moved)}) after capture; report remains valid only for recorded commits"


def _discover_unit(*, request, cap, unit, policy_text, model, limits, shared_ctx):
    from smolagents import LogLevel, ToolCallingAgent

    unit_budget = BudgetState(wall_seconds=limits.unit_wall_seconds,
                              token_ceiling=limits.unit_token_ceiling,
                              bytes_ceiling=limits.tool_budget_bytes,
                              calls_ceiling=limits.tool_calls_per_unit)
    unit_ctx = _fresh_unit_ctx(shared_ctx, unit_budget)
    tools = build_tools(unit_ctx)

    CandidatesPayload, _ = _pydantic_models()
    callbacks = step_callback_factory(unit.unit_id, unit_budget)
    instructions = f"{policy_text}\n\n{DISCOVERY_INSTRUCTIONS}"
    task = f"""Review this unit of a pinned code change.

{unit.context}

Locations you cite must name the endpoint (base|head), repo-relative path, and line range."""

    agent = ToolCallingAgent(
        tools=tools,
        model=model,
        instructions=instructions,
        max_steps=limits.max_steps_per_unit,
        verbosity_level=LogLevel.OFF,
        max_tool_threads=1,
        return_full_result=True,
        step_callbacks=callbacks,
        final_answer_checks=[make_schema_check(CandidatesPayload)],
    )
    emit("unit_start", unit=unit.unit_id, title=unit.title)
    status = "assessed"
    error_cause: str | None = None
    run_result = None
    try:
        run_result = agent.run(task)
    except BudgetExhausted as exc:
        status, error_cause = "budget-exhausted", str(exc)
        emit("unit_budget", unit=unit.unit_id, which=exc.which)
    except Exception as exc:
        status, error_cause = "failed", f"{type(exc).__name__}: {exc}"
        emit("unit_failed", unit=unit.unit_id, error=error_cause)

    candidates: list[Candidate] = []
    unresolved: list[dict] = []
    if run_result is not None:
        output = run_result.output
        text = output if isinstance(output, str) else json.dumps(output)
        parsed = extract_json(text)
        payload = None
        if parsed is not None:
            try:
                payload = CandidatesPayload.model_validate(parsed)
                status = "assessed" if run_result.state == "success" else "budget-exhausted"
            except Exception as exc:
                status, error_cause = "invalid-output", f"final answer failed schema validation: {exc}"
        else:
            status, error_cause = "invalid-output", "final answer was not parseable JSON"
        if payload is not None:
            for cand in payload.candidates:
                fixed = _fix_locations(cap, list(cand.locations))
                if not fixed:
                    unresolved.append({"unit_id": unit.unit_id,
                                       "candidate": cand.model_dump(mode="json"),
                                       "rationale": "all locations failed snapshot validation"})
                    continue
                candidates.append(cand.model_copy(update={"locations": fixed}))

    usage = getattr(run_result, "token_usage", None) if run_result else None
    steps = len(getattr(run_result, "steps", []) or []) if run_result else None
    accounting = UnitAccounting(
        unit_id=unit.unit_id,
        title=unit.title,
        status=status,
        candidates=len(candidates),
        tool_calls=unit_budget.tool_calls,
        bytes_read=unit_budget.bytes_returned,
        wall_seconds=round(time.monotonic() - unit_budget.started, 3),
        input_tokens=usage.input_tokens if usage else None,
        output_tokens=usage.output_tokens if usage else None,
        model_steps=steps,
        gaps=list(unit.gaps) + ([error_cause] if error_cause else []),
    )
    return {"accounting": accounting, "candidates": candidates, "unresolved": unresolved}


def _challenge_candidate(*, request, cap, candidate: Candidate, unit_id: str,
                         model, limits, shared_ctx) -> ChallengeResult:
    from smolagents import LogLevel, ToolCallingAgent

    _, ChallengePayload = _pydantic_models()
    budget = BudgetState(wall_seconds=limits.challenge_wall_seconds,
                         token_ceiling=limits.challenge_token_ceiling,
                         bytes_ceiling=limits.tool_budget_bytes,
                         calls_ceiling=limits.tool_calls_per_unit)
    candidate_ctx = _fresh_unit_ctx(shared_ctx, budget)
    tools = build_tools(candidate_ctx)
    callbacks = step_callback_factory(f"{unit_id}/challenge", budget)

    candidate_json = json.dumps(candidate.model_dump(mode="json"), indent=2)
    task = f"""Independent challenger task for the candidate defect below (unit {unit_id}).

{candidate_json}

Decide: supported, disproved, or unresolved. Evidence outranks opinion."""

    agent = ToolCallingAgent(
        tools=tools,
        model=model,
        instructions=CHALLENGE_INSTRUCTIONS,
        max_steps=limits.max_steps_per_candidate,
        verbosity_level=LogLevel.OFF,
        max_tool_threads=1,
        return_full_result=True,
        step_callbacks=callbacks,
        final_answer_checks=[make_schema_check(ChallengePayload)],
    )
    emit("challenge_start", unit=unit_id)
    try:
        run_result = agent.run(task)
    except BudgetExhausted as exc:
        emit("challenge_budget", unit=unit_id, which=exc.which)
        return ChallengeResult(outcome=ChallengeOutcome.UNRESOLVED,
                               rationale=f"challenge pass exhausted its budget ({exc.which})", evidence=[])
    except Exception as exc:
        emit("challenge_failed", unit=unit_id, error=str(exc))
        return ChallengeResult(outcome=ChallengeOutcome.UNRESOLVED,
                               rationale=f"challenge pass failed: {exc}", evidence=[])

    output = run_result.output
    text = output if isinstance(output, str) else json.dumps(output)
    parsed = extract_json(text)
    if parsed is None:
        return ChallengeResult(outcome=ChallengeOutcome.UNRESOLVED,
                               rationale="challenge output was not parseable JSON", evidence=[])
    try:
        payload = ChallengePayload.model_validate(parsed)
    except Exception as exc:
        return ChallengeResult(outcome=ChallengeOutcome.UNRESOLVED,
                               rationale=f"challenge output failed schema validation: {exc}", evidence=[])
    fixed = _fix_locations(cap, list(payload.evidence))
    return ChallengeResult(outcome=payload.outcome, rationale=payload.rationale, evidence=fixed)
