import hashlib
import json

from code_review.contracts import (
    ComparisonMode,
    Limits,
    ModelSpec,
    ReviewFailed,
    ReviewPartial,
    ReviewRequest,
    Coverage,
    UnitAccounting,
)
from code_review.report import to_markdown, write_artifacts


def _request():
    return ReviewRequest(
        repository="/tmp/repo",
        mode=ComparisonMode.DIRECT,
        base_ref="main",
        head_ref="feature",
        discovery_model=ModelSpec(provider="litellm", model_id="a", api_key_env="LLM_API_KEY"),
        challenge_model=ModelSpec(provider="openai", model_id="b", api_key_env="OPENAI_API_KEY"),
        limits=Limits(),
    )


def test_failed_report_renders_stage_and_cause(tmp_path):
    failed = ReviewFailed(request=_request(), failed_stage="capture", cause="dirty checkout", duration_seconds=0.5)
    md = to_markdown(failed)
    assert "capture" in md
    assert "dirty checkout" in md
    out = write_artifacts(failed, str(tmp_path))
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["status"] == "failed"
    assert hashlib.sha256((tmp_path / "report.json").read_bytes()).hexdigest() == manifest["report_json_sha256"]


def test_partial_report_shows_gaps_and_units(tmp_path):
    from code_review.contracts import SideSnapshot, Snapshot

    side = SideSnapshot(commit="c" * 40, tree="d" * 40, dependency_lock_hash=None,
                        analyzer={"harness": "test"}, file_count=2)
    snap = Snapshot(base=side, head=side, merge_base=None, scope=[], scope_hash="x", excluded_paths=[])
    unit = UnitAccounting(unit_id="u001", title="src/util.ts (top-level change)", status="invalid-output",
                          candidates=0, tool_calls=3, bytes_read=120, wall_seconds=1.5,
                          input_tokens=10, output_tokens=5, model_steps=2, gaps=["invalid JSON"])
    coverage = Coverage(units_total=1, units_assessed=0, hunks_in_scope=2, sources_read=3,
                        read_log=[], unresolved_relations=["semantic layer unavailable"],
                        omitted=["1 relationship omitted"], unsupported_files=[],
                        budget_exhausted=[], failures=[], per_unit=[unit])
    partial = ReviewPartial(request=_request(), snapshot=snap, analyzer={"harness": "test"},
                            findings=[], preexisting_candidates=[], unresolved_candidates=[],
                            coverage=coverage, duration_seconds=2.0)
    md = to_markdown(partial)
    assert "partial" in md
    assert "u001" in md
    assert "semantic layer unavailable" in md
    write_artifacts(partial, str(tmp_path))
    assert (tmp_path / "manifest.json").is_file()


def test_artifacts_are_outside_the_repo_by_default(tmp_path):
    failed = ReviewFailed(request=_request(), failed_stage="x", cause="y", duration_seconds=0.1)
    out = write_artifacts(failed, None)
    assert not out.startswith("/tmp/repo")
