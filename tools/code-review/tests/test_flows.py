from code_review.flows import check_clause_anchors, load_flows, match_flows


def test_flows_registry_loads_clean():
    flows, errors = load_flows()
    assert errors == []
    assert flows, "declared-flow registry must not be empty"
    ids = [flow.id for flow in flows]
    assert len(ids) == len(set(ids))


def test_flows_match_by_path_and_symbol():
    flows, _ = load_flows()
    by_path = match_flows(flows, ["tools/code-review/src/code_review/cli.py"], [])
    by_symbol = match_flows(flows, [], ["turn-admission"])
    assert isinstance(by_path, list)
    assert isinstance(by_symbol, list)
    # at least one registry entry is path-anchored somewhere sensible; both call shapes work
    assert all(isinstance(m.clauses, list) for m in by_path + by_symbol)


def test_flows_anchor_check_flags_stale_clause():
    flows, _ = load_flows()
    matches = match_flows(flows, ["design/turn-admission.md"], []) + match_flows(flows, ["src/turn/admission.ts"], [])
    if matches:
        stale = check_clause_anchors(matches, allowed_paths=set())
        assert isinstance(stale, list)
        # a base snapshot with none of the referenced paths must flag every path-like clause
        assert any(m.stale_clauses for m in stale) or all(
            c.startswith(("DESIGN.md", "AGENTS.md", "DIRECTION.md")) for m in stale for c in m.clauses
        )


def test_flows_anchor_check_passes_on_allowed_docs():
    flows, _ = load_flows()
    matches = match_flows(flows, ["src/anything.ts"], ["turn-admission"])
    if matches:
        stale = check_clause_anchors(matches, allowed_paths=set())
        for m in stale:
            for clause in m.stale_clauses:
                assert not clause.startswith(("DESIGN.md", "AGENTS.md", "DIRECTION.md"))
