"""JSONL on stderr — stage transitions, model/tool boundaries, failures.

Never carries source bodies or secrets. One line per event.
"""

from __future__ import annotations

import json
import sys
import time


def emit(event: str, **fields) -> None:
    record = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stderr.write(json.dumps(record, default=str) + "\n")
    sys.stderr.flush()


def step_callback_factory(unit_id: str, budget, logger=emit):
    """Build smolagents step callbacks for ActionStep/FinalAnswerStep.

    The callback never inspects or logs model content — only structural
    facts — and raises BudgetExhausted past the unit ceiling (propagating
    out of the agent loop; smolagents runs callbacks in _finalize_step,
    so raising aborts the run between steps).
    """
    from smolagents import ActionStep, FinalAnswerStep, PlanningStep

    def on_step(step):
        usage = getattr(step, "token_usage", None)
        if usage is not None:
            budget.add_tokens(getattr(usage, "input_tokens", None), getattr(usage, "output_tokens", None))
        tool_calls = getattr(step, "tool_calls", None) or []
        logger(
            "step",
            unit=unit_id,
            step=getattr(step, "step_number", None),
            tools=[getattr(tc, "name", None) for tc in tool_calls],
            error=type(step.error).__name__ if getattr(step, "error", None) else None,
        )
        budget.check()

    def on_final_answer(step):
        logger("final_answer", unit=unit_id)
        budget.check()

    return {
        ActionStep: [on_step],
        PlanningStep: [on_step],
        FinalAnswerStep: [on_final_answer],
    }
