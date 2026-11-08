import pytest
from pydantic import ValidationError

from code_review.contracts import (
    ComparisonMode,
    Limits,
    ModelSpec,
    ReviewComplete,
    ReviewPartial,
    ReviewFailed,
    ReviewRequest,
    Snapshot,
    SideSnapshot,
    Coverage,
)


def _spec(provider="litellm", model_id="anthropic/x", api_base=None):
    return ModelSpec(provider=provider, model_id=model_id, api_base=api_base, api_key_env="LLM_API_KEY")


def _request(**overrides):
    payload = dict(
        repository="/tmp/repo",
        mode=ComparisonMode.DIRECT,
        base_ref="main",
        head_ref="feature",
        discovery_model=_spec(),
        challenge_model=_spec("openai", "gpt-4o"),
        limits=Limits(),
    )
    payload.update(overrides)
    return ReviewRequest(**payload)


def test_same_identity_rejected():
    with pytest.raises(ValidationError):
        _request(discovery_model=_spec("litellm", "same"), challenge_model=_spec("litellm", "same"))


def test_same_model_id_different_provider_ok():
    req = _request(discovery_model=_spec("litellm", "x"), challenge_model=_spec("openai", "x"))
    assert req.discovery_model.model_id == req.challenge_model.model_id


def test_same_identity_with_different_api_base_is_distinct():
    req = _request(
        discovery_model=_spec("litellm", "x", api_base="https://a.example"),
        challenge_model=_spec("litellm", "x", api_base="https://b.example"),
    )
    assert req.discovery_model.identity() != req.challenge_model.identity()


def test_model_spec_identity_shape():
    assert len(_spec().identity()) == 3


def test_limits_defaults_sane():
    limits = Limits()
    assert limits.max_units >= 1
    # token ceilings default to None (disabled); opt-in only
    assert limits.unit_token_ceiling is None or limits.unit_token_ceiling > 0
    assert limits.policy_bytes > 0
    assert limits.unit_context_bytes > 1024


def _snap():
    side = SideSnapshot(commit="a" * 40, tree="b" * 40, dependency_lock_hash=None,
                        analyzer={"harness": "test"}, file_count=1)
    return Snapshot(base=side, head=side, merge_base=None, scope=[], scope_hash="x", excluded_paths=[])


def _coverage(total=1, assessed=1):
    return Coverage(units_total=total, units_assessed=assessed, hunks_in_scope=1,
                    sources_read=0)


def test_complete_review_requires_full_coverage():
    with pytest.raises(ValidationError):
        ReviewComplete(request=_request(), snapshot=_snap(), analyzer={}, findings=[],
                       preexisting_candidates=[], coverage=_coverage(total=2, assessed=1),
                       duration_seconds=1.0)


def test_partial_review_requires_a_gap_signal():
    with pytest.raises(ValidationError):
        ReviewPartial(request=_request(), snapshot=_snap(), analyzer={}, findings=[],
                      preexisting_candidates=[], unresolved_candidates=[],
                      coverage=_coverage(total=1, assessed=1),
                      duration_seconds=1.0)
    ok = ReviewPartial(request=_request(), snapshot=_snap(), analyzer={}, findings=[],
                       preexisting_candidates=[], unresolved_candidates=[],
                       coverage=Coverage(units_total=1, units_assessed=1, hunks_in_scope=1,
                                         sources_read=0, omitted=["gap noted"]),
                       duration_seconds=1.0)
    assert ok.status == "partial"


def test_review_failed_shape():
    failed = ReviewFailed(request=_request(), failed_stage="capture", cause="nope", duration_seconds=0.1)
    assert failed.status == "failed"
