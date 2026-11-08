import pytest

from code_review.budget import BudgetExhausted, BudgetState


def test_wall_time_ceiling():
    budget = BudgetState(wall_seconds=-1.0, token_ceiling=None)
    with pytest.raises(BudgetExhausted) as excinfo:
        budget.check()
    assert excinfo.value.which == "wall-time"


def test_token_ceiling():
    budget = BudgetState(wall_seconds=60.0, token_ceiling=100)
    budget.add_tokens(60, 30)
    budget.check()
    budget.add_tokens(20, 0)
    with pytest.raises(BudgetExhausted) as excinfo:
        budget.check()
    assert excinfo.value.which == "tokens"


def test_bytes_ceiling():
    budget = BudgetState(wall_seconds=60.0, token_ceiling=None, bytes_ceiling=100)
    budget.add_bytes(99)
    budget.check()
    budget.add_bytes(2)
    with pytest.raises(BudgetExhausted) as excinfo:
        budget.check()
    assert excinfo.value.which == "bytes"


def test_calls_ceiling():
    budget = BudgetState(wall_seconds=60.0, token_ceiling=None, calls_ceiling=2)
    budget.add_tool_call()
    budget.add_tool_call()
    budget.check()
    budget.add_tool_call()
    with pytest.raises(BudgetExhausted) as excinfo:
        budget.check()
    assert excinfo.value.which == "tool-calls"


def test_no_ceilings_never_raises():
    budget = BudgetState(wall_seconds=10_000, token_ceiling=None)
    budget.add_tokens(10**9, 10**9)
    budget.add_bytes(10**12)
    budget.add_tool_call()
    budget.check()


def test_none_token_usage_tolerated():
    budget = BudgetState(wall_seconds=60.0, token_ceiling=10)
    budget.add_tokens(None, None)
    budget.check()
