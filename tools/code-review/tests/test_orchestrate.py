import hashlib
import json
from pathlib import Path

import pytest

from code_review import pipeline
from code_review.contracts import ComparisonMode, Limits, ModelSpec, ReviewRequest
from code_review.gitio import list_tree, resolve_ref

from conftest import make_stub_factory


def _request(repo_path, discovery_id="discovery-stub", challenge_id="challenge-stub"):
    return ReviewRequest(
        repository=str(repo_path),
        mode=ComparisonMode.DIRECT,
        base_ref="main",
        head_ref="feature",
        discovery_model=ModelSpec(provider="litellm", model_id=discovery_id, api_key_env="LLM_API_KEY"),
        challenge_model=ModelSpec(provider="openai", model_id=challenge_id, api_key_env="OPENAI_API_KEY"),
        limits=Limits(),
    )


def _install_stubs(monkeypatch):
    factory, holder = make_stub_factory()
    monkeypatch.setattr(pipeline, "build_model", lambda spec: factory(spec))
    return holder


def test_offline_review_produces_supported_finding(repo_path, tmp_path, monkeypatch):
    holder = _install_stubs(monkeypatch)
    out_dir = tmp_path / "artifacts"
    result = pipeline.run_review(_request(repo_path), output_dir=str(out_dir))

    assert result["status"] == "partial"  # no TS install offline → explicit gaps
    findings = result["findings"]
    assert len(findings) == 1
    finding = findings[0]
    assert finding["severity"] == "high"
    assert finding["disproof"]["outcome"] == "supported"

    head_sha = resolve_ref(str(repo_path), "feature")
    head_blobs = {e.path: e.sha for e in list_tree(str(repo_path), head_sha)}
    for loc in finding["locations"]:
        assert loc["endpoint"] == "head"
        assert loc["blob_id"] == head_blobs[loc["path"]]
        assert loc["start_line"] <= loc["end_line"]

    coverage = result["coverage"]
    assert coverage["units_assessed"] == coverage["units_total"] > 0
    assert coverage["omitted"] or coverage["unresolved_relations"] or coverage["failures"] or coverage["unsupported_files"]
    assert coverage["per_unit"], "per-unit accounting must be present"

    assert holder.calls == 2  # one discovery model + one challenge model

    # artifacts: json + markdown + manifest, manifest hashes the report
    report_json = (out_dir / "report.json").read_bytes()
    report_md = (out_dir / "report.md").read_bytes()
    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["status"] == "partial"
    assert manifest["report_json_sha256"] == hashlib.sha256(report_json).hexdigest()
    assert manifest["report_md_sha256"] == hashlib.sha256(report_md).hexdigest()
    assert json.loads(report_json)["status"] == "partial"
    assert "Code review report" in report_md.decode()


def test_zero_findings_is_not_clean_when_partial(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path, discovery_id="discovery-empty"), output_dir=str(tmp_path / "o"))
    assert result["status"] == "partial"
    assert result["findings"] == []
    cov = result["coverage"]
    assert (cov["omitted"] or cov["unresolved_relations"] or cov["budget_exhausted"] or cov["failures"])


def test_challenge_disproved_yields_no_finding(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path, challenge_id="challenge-disproved"), output_dir=str(tmp_path / "o"))
    assert result["findings"] == []
    assert result["status"] == "partial"


def test_challenge_unresolved_is_not_promoted(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path, challenge_id="challenge-unresolved"), output_dir=str(tmp_path / "o"))
    assert result["findings"] == []
    assert result["unresolved_candidates"], "unresolved candidates must be kept, not promoted or dropped silently"
    assert result["status"] == "partial"


def test_garbage_discovery_output_is_partial_not_crash(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path, discovery_id="discovery-garbage"), output_dir=str(tmp_path / "o"))
    assert result["status"] == "partial"
    assert result["findings"] == []
    statuses = {u["status"] for u in result["coverage"]["per_unit"]}
    assert "invalid-output" in statuses


def test_same_identity_refused_at_contract(repo_path, monkeypatch):
    holder_factory, holder = make_stub_factory()
    monkeypatch.setattr(pipeline, "build_model", lambda spec: holder_factory(spec))
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ReviewRequest(
            repository=str(repo_path),
            mode=ComparisonMode.DIRECT,
            base_ref="main",
            head_ref="feature",
            discovery_model=ModelSpec(provider="litellm", model_id="same", api_key_env="LLM_API_KEY"),
            challenge_model=ModelSpec(provider="litellm", model_id="same", api_key_env="LLM_API_KEY"),
        )
    assert holder.calls == 0  # refusal happens before any model is built


def test_same_identity_refused_at_pipeline_guard(repo_path, monkeypatch):
    from code_review.agents import check_distinct, ModelConfigError

    req = _request(repo_path)
    same_challenge = req.discovery_model.model_copy()
    with pytest.raises(ModelConfigError):
        check_distinct(req.discovery_model, same_challenge)


def test_dirty_or_missing_repo_fails_capture(tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    req = ReviewRequest(
        repository=str(tmp_path / "does-not-exist"),
        mode=ComparisonMode.DIRECT,
        base_ref="main",
        head_ref="feature",
        discovery_model=ModelSpec(provider="litellm", model_id="discovery-stub", api_key_env="LLM_API_KEY"),
        challenge_model=ModelSpec(provider="openai", model_id="challenge-stub", api_key_env="OPENAI_API_KEY"),
    )
    result = pipeline.run_review(req, output_dir=str(tmp_path / "o"))
    assert result["status"] == "failed"
    assert result["failed_stage"] == "capture"


def test_dirty_checkout_fails_capture(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    scratch = tmp_path / "scratch-repo"
    import shutil

    shutil.copytree(repo_path, scratch)
    (scratch / "uncommitted.tmp").write_text("wip")
    req = ReviewRequest(
        repository=str(scratch),
        mode=ComparisonMode.DIRECT,
        base_ref="main",
        head_ref="feature",
        discovery_model=ModelSpec(provider="litellm", model_id="discovery-stub", api_key_env="LLM_API_KEY"),
        challenge_model=ModelSpec(provider="openai", model_id="challenge-stub", api_key_env="OPENAI_API_KEY"),
    )
    result = pipeline.run_review(req, output_dir=str(tmp_path / "o"))
    assert result["status"] == "failed"
    assert result["failed_stage"] == "capture"
    assert "uncommitted" in result["cause"]


def test_report_applicability_present(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path), output_dir=str(tmp_path / "o"))
    assert result["applicability"]
    assert "recorded commits" in result["applicability"]


def test_agent_executes_tools_then_answers(repo_path, tmp_path, monkeypatch):
    """Stub makes tool calls through the real smolagents loop; read log records them."""
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path, discovery_id="discovery-search",
                                          challenge_id="challenge-read"),
                                 output_dir=str(tmp_path / "o"))
    read_log = result["coverage"]["read_log"]
    tools_used = {entry["tool"] for entry in read_log}
    assert "search_snapshot" in tools_used
    assert "read_snapshot_range" in tools_used
    findings = result["findings"]
    assert len(findings) == 1
    assert findings[0]["disproof"]["outcome"] == "supported"


def test_missing_key_env_fails_fast_before_capture(repo_path, tmp_path, monkeypatch):
    """Absent API key env: config failure, nothing captured or installed."""
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    _install_stubs(monkeypatch)
    req = _request(repo_path)
    assert req.discovery_model.api_key_env == "LLM_API_KEY"
    result = pipeline.run_review(req, output_dir=str(tmp_path / "o"))
    assert result["status"] == "failed"
    assert result["failed_stage"] == "config"
    assert "LLM_API_KEY" in result["cause"]


def test_total_model_failure_is_failed_not_clean_zero(repo_path, tmp_path, monkeypatch):
    """Every unit fails at the model boundary → failed review, never a zero-finding 'partial'."""
    _install_stubs(monkeypatch)
    result = pipeline.run_review(_request(repo_path, discovery_id="discovery-explosive"), output_dir=str(tmp_path / "o"))
    assert result["status"] == "failed"
    assert result["failed_stage"] == "discover"
    assert "2 units" in result["cause"]


def test_fork_point_reviews_merge_base_not_base_tip(repo_path, tmp_path, monkeypatch):
    _install_stubs(monkeypatch)
    # main has not moved since the feature branch forked, so fork-point and
    # direct agree on the merge base; the artifact must record the merge base.
    result = pipeline.run_review(
        _request(repo_path).model_copy(update={"mode": ComparisonMode.FORK_POINT}),
        output_dir=str(tmp_path / "o"),
    )
    snap = result["snapshot"]
    assert snap["merge_base"]
    assert snap["base"]["commit"] == snap["merge_base"]
    assert result["analyzer"].get("requested_base")
