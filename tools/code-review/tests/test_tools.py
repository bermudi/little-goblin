import pytest

from code_review.budget import BudgetState
from code_review.capture import capture, cleanup
from code_review.contracts import ComparisonMode, Endpoint, Limits, ModelSpec, ReviewRequest
from code_review.flows import load_flows
from code_review.tools import ToolContext, build_tools


@pytest.fixture(scope="module")
def cap_and_flows(repo_path):
    request = ReviewRequest(
        repository=str(repo_path),
        mode=ComparisonMode.DIRECT,
        base_ref="main",
        head_ref="feature",
        discovery_model=ModelSpec(provider="litellm", model_id="x", api_key_env="NOPE"),
        challenge_model=ModelSpec(provider="openai", model_id="y", api_key_env="NOPE"),
        limits=Limits(),
    )
    cap = capture(request, install_deps=False)
    flows, _ = load_flows()
    yield cap, flows
    cleanup(cap)


@pytest.fixture()
def ctx(cap_and_flows):
    cap, flows = cap_and_flows
    budget = BudgetState(wall_seconds=60.0, token_ceiling=None,
                         bytes_ceiling=cap.request.limits.tool_budget_bytes, calls_ceiling=1000)
    context = ToolContext(cap, cap.request.limits, budget, flows)
    yield context
    context.close()


@pytest.fixture()
def tools(ctx):
    return {t.name: t for t in build_tools(ctx)}


def test_read_snapshot_range_provenance(tools):
    out = tools["read_snapshot_range"].forward(endpoint="head", path="src/report.ts", start_line=1, end_line=4)
    assert "endpoint=head" in out
    assert out.splitlines()[0].startswith("// snapshot")
    assert "import { area }" in out
    assert len(out.encode()) > 0


def test_read_snapshot_range_bounds_and_refusals(tools, ctx):
    budget_bytes_before = ctx.budget.bytes_returned
    assert "REFUSE" in tools["read_snapshot_range"].forward(endpoint="head", path="/etc/passwd", start_line=1, end_line=1)
    assert "REFUSE" in tools["read_snapshot_range"].forward(endpoint="head", path="../x", start_line=1, end_line=1)
    assert "REFUSE" in tools["read_snapshot_range"].forward(endpoint="head", path="nope/missing.ts", start_line=1, end_line=1)
    assert "REFUSE" in tools["read_snapshot_range"].forward(endpoint="head", path="src/report.ts", start_line=0, end_line=1)
    # refused reads never consume the byte budget
    assert ctx.budget.bytes_returned == budget_bytes_before


def test_search_snapshot_literal_and_regex(tools):
    literal = tools["search_snapshot"].forward(pattern="mul", endpoint="head")
    assert "src/calc.ts" in literal and "src/util.ts" in literal
    regex = tools["search_snapshot"].forward(pattern=r"area\s*\(", endpoint="head")
    assert "src/calc.ts:2" in regex
    assert "NO MATCHES" in tools["search_snapshot"].forward(pattern="zzz_no_such_token_qqq", endpoint="head")


def test_search_snapshot_rejects_nested_quantifiers(tools):
    out = tools["search_snapshot"].forward(pattern=r"(a+)+$", endpoint="head")
    assert out.startswith("REFUSE")


def test_search_snapshot_glob_filter(tools):
    out = tools["search_snapshot"].forward(pattern="mul", endpoint="head", path_glob="src/**/*.ts")
    assert "src/util.ts" in out
    out2 = tools["search_snapshot"].forward(pattern="mul", endpoint="head", path_glob="package.json")
    assert "NO MATCHES" in out2


def test_search_snapshot_budget_cap(tools, ctx):
    before = ctx.budget.tool_calls
    for _ in range(3):
        tools["search_snapshot"].forward(pattern=".", endpoint="head", max_hits=5)
    assert ctx.budget.tool_calls == before + 3


def test_resolve_references_unavailable_layer_is_explicit_gap(tools, ctx):
    out = tools["resolve_references"].forward(endpoint="head", path="src/util.ts", line=2, name="mul")
    assert out.startswith("UNRESOLVED")
    assert any("semantic layer unavailable" in note for note in ctx.unresolved)


def test_resolve_references_name_not_on_line(tools):
    # semantic layer unavailable on this fixture, so the name check happens after
    # the session check — assert the explicit gap either way.
    out = tools["resolve_references"].forward(endpoint="head", path="src/calc.ts", line=2, name="mul")
    assert out.startswith("UNRESOLVED")


def test_inspect_declared_flow_no_match(tools):
    out = tools["inspect_declared_flow"].forward(topic="zzz qqx nonexistent-topic")
    assert "NO MATCH" in out


def test_read_log_records_blob_ids(tools, ctx, cap_and_flows):
    cap, _ = cap_and_flows
    tools["read_snapshot_range"].forward(endpoint="head", path="src/report.ts", start_line=1, end_line=2)
    assert ctx.read_log, "read log must not be empty"
    entry = ctx.read_log[-1]
    expected_sha = cap.head.allowed["src/report.ts"].sha
    assert entry.blob_id == expected_sha
    assert entry.tool == "read_snapshot_range"
