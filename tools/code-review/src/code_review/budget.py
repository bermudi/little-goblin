"""Per-unit budget accounting. The host — never the model — owns this."""

from __future__ import annotations

import time


class BudgetExhausted(Exception):
    def __init__(self, which: str, detail: str = ""):
        super().__init__(f"{which} budget exhausted" + (f": {detail}" if detail else ""))
        self.which = which
        self.detail = detail


class BudgetState:
    def __init__(self, *, wall_seconds: float, token_ceiling: int | None,
                 bytes_ceiling: int | None = None, calls_ceiling: int | None = None):
        self.wall_seconds = wall_seconds
        self.token_ceiling = token_ceiling
        self.bytes_ceiling = bytes_ceiling
        self.calls_ceiling = calls_ceiling
        self.bytes_returned = 0
        self.tool_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.tokens_reported = False
        self.started = time.monotonic()
        self.exhausted: str | None = None

    # -- accounting ----------------------------------------------------------

    def add_bytes(self, n: int) -> bool:
        self.bytes_returned += n
        return True

    def add_tool_call(self) -> None:
        self.tool_calls += 1

    def add_tokens(self, input_tokens: int | None, output_tokens: int | None) -> None:
        if input_tokens is not None and output_tokens is not None:
            self.tokens_reported = True
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens

    # -- enforcement ---------------------------------------------------------

    def check(self) -> None:
        """Raise BudgetExhausted if any ceiling is breached."""
        if time.monotonic() - self.started > self.wall_seconds:
            self.exhausted = "wall-time"
            raise BudgetExhausted("wall-time", f"{self.wall_seconds:.0f}s")
        if self.token_ceiling is not None and self.tokens_reported:
            if self.input_tokens + self.output_tokens > self.token_ceiling:
                self.exhausted = "tokens"
                raise BudgetExhausted("tokens", f"{self.input_tokens + self.output_tokens} > {self.token_ceiling}")
        if self.bytes_ceiling is not None and self.bytes_returned > self.bytes_ceiling:
            self.exhausted = "bytes"
            raise BudgetExhausted("bytes", f"{self.bytes_returned} > {self.bytes_ceiling}")
        if self.calls_ceiling is not None and self.tool_calls > self.calls_ceiling:
            self.exhausted = "tool-calls"
            raise BudgetExhausted("tool-calls", f"{self.tool_calls} > {self.calls_ceiling}")

    def summary(self) -> dict:
        return {
            "tool_calls": self.tool_calls,
            "bytes_returned": self.bytes_returned,
            "input_tokens": self.input_tokens if self.tokens_reported else None,
            "output_tokens": self.output_tokens if self.tokens_reported else None,
            "wall_seconds": round(time.monotonic() - self.started, 3),
            "exhausted": self.exhausted,
        }
