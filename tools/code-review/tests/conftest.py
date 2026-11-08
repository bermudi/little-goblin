"""Shared fixtures: a two-commit git repository with a TypeScript change.

The fixture is intentionally tiny and dependency-free. Offline tests exercise
the declared-import and diff-driven paths; the semantic (tsgo) path is covered
separately and requires an endpoint-local TypeScript install.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from smolagents.models import (
    ChatMessage,
    ChatMessageToolCall,
    ChatMessageToolCallFunction,
    MessageRole,
    Model,
    TokenUsage,
)


def _git(repo: Path, *args: str) -> str:
    out = subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)
    return out.stdout.strip()


@pytest.fixture(scope="module", autouse=True)
def _test_key_envs():
    # The harness fails fast when a required key env var is absent; tests stub
    # inference themselves, so provide placeholders for every provider default.
    import os

    for name in ("LLM_API_KEY", "OPENAI_API_KEY", "HF_TOKEN", "AZURE_OPENAI_API_KEY"):
        os.environ.setdefault(name, "test-placeholder-key")


def make_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    src = path / "src"
    src.mkdir(exist_ok=True)
    (path / "package.json").write_text(json.dumps({"name": "fixture", "version": "1.0.0", "type": "module"}) + "\n")
    (path / "tsconfig.json").write_text(json.dumps({
        "compilerOptions": {"strict": True, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler"},
        "include": ["src"],
    }) + "\n")
    (src / "util.ts").write_text(
        "/** Multiply two numbers. Used across the app. */\n"
        "export function mul(a: number, b: number): number {\n"
        "  return a * b;\n"
        "}\n"
        "export function unusedHelper(): string { return \"x\"; }\n"
    )
    (src / "calc.ts").write_text(
        "import { mul } from \"./util\";\n"
        "export function area(w: number, h: number): number {\n"
        "  return mul(w, h);\n"
        "}\n"
        "export function perimeter(w: number, h: number): number {\n"
        "  return 2 * (w + h);\n"
        "}\n"
    )
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "fixture@example.com")
    _git(path, "config", "user.name", "fixture")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "base")
    _git(path, "checkout", "-qb", "feature")
    (src / "util.ts").write_text(
        "/** Multiply two numbers. Used across the app. */\n"
        "export function mul(a: number, b: number): number {\n"
        "  if (Number.isNaN(a) || Number.isNaN(b)) return 0;\n"
        "  return a * b;\n"
        "}\n"
        "export function unusedHelper(): string { return \"x\"; }\n"
    )
    (src / "report.ts").write_text(
        "import { area } from \"./calc\";\n"
        "export function label(w: number, h: number): string {\n"
        "  return `area=${area(w, h)}`;\n"
        "}\n"
    )
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "head: guard NaN, add report")
    return path


@pytest.fixture(scope="module")
def repo_path(tmp_path_factory) -> Path:
    return make_repo(tmp_path_factory.mktemp("fixture-repo"))


# ------------------------------------------------------------- stub models


class ScriptedModel(Model):
    """Deterministic offline Model for smolagents agents.

    `handler(model, messages, tools) -> ChatMessage`; the harness's own final
    answer schema checks do the rest.
    """

    def __init__(self, handler, model_id: str = "stub"):
        super().__init__(model_id=model_id)
        self.handler = handler
        self.generate_calls = 0

    def generate(self, messages, stop_sequences=None, response_format=None, tools_to_call_from=None, **kwargs):
        self.generate_calls += 1
        tools = tools_to_call_from or []
        return self.handler(self, list(messages), tools)


def tool_call(name: str, arguments: dict, call_id: str = "call_1") -> ChatMessageToolCall:
    return ChatMessageToolCall(
        function=ChatMessageToolCallFunction(name=name, arguments=json.dumps(arguments)),
        id=call_id,
        type="function",
    )


def assistant_message(*, content: str | None = None, calls: list[ChatMessageToolCall] | None = None,
                      input_tokens: int = 11, output_tokens: int = 7) -> ChatMessage:
    return ChatMessage(
        role=MessageRole.ASSISTANT,
        content=content,
        tool_calls=calls,
        token_usage=TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens),
    )


def last_user_text(messages) -> str:
    for msg in reversed(messages):
        role = getattr(msg, "role", None)
        content = getattr(msg, "content", None)
        role_value = role.value if hasattr(role, "value") else str(role)
        if role_value == "user":
            if isinstance(content, list):
                return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            return str(content or "")
    return ""


def discovery_handler_candidate_for_mul(model, messages, tools):
    """Propose one concrete candidate for the `mul` unit; nothing for others."""
    text = last_user_text(messages)
    if "mul" in text:
        candidate = {
            "changed_cause": "src/util.ts: mul now returns 0 for NaN inputs",
            "trigger": "a caller passes NaN (e.g. unparsed user input)",
            "execution_path": "src/report.ts:label -> src/calc.ts:area -> src/util.ts:mul",
            "violated_contract": "mul must not convert invalid numeric input into a valid-looking result",
            "consequence": "a label reports area=0 instead of surfacing invalid input",
            "locations": [{"endpoint": "head", "path": "src/util.ts", "start_line": 3, "end_line": 5}],
            "proposed_severity": "high",
            "severity_rationale": "silent wrong output on plausible untrusted input",
        }
        return assistant_message(calls=[tool_call("final_answer", {"answer": {"candidates": [candidate]}})])
    return assistant_message(calls=[tool_call("final_answer", {"answer": {"candidates": []}})])


def discovery_handler_no_candidates(model, messages, tools):
    return assistant_message(calls=[tool_call("final_answer", {"answer": {"candidates": []}})])


def discovery_handler_garbage(model, messages, tools):
    return assistant_message(calls=[tool_call("final_answer", {"answer": "not json at all {{{"})])


def discovery_handler_explosive(model, messages, tools):
    raise RuntimeError("model endpoint unreachable (boom)")


def challenge_handler_supported(model, messages, tools):
    verdict = {
        "outcome": "supported",
        "rationale": "cited lines hold the NaN guard; the path label->area->mul is real in the head snapshot; nothing else validates NaN first",
        "evidence": [{"endpoint": "head", "path": "src/util.ts", "start_line": 3, "end_line": 4}],
    }
    return assistant_message(calls=[tool_call("final_answer", {"answer": verdict})])


def challenge_handler_disproved(model, messages, tools):
    verdict = {"outcome": "disproved", "rationale": "the caller already validates inputs", "evidence": []}
    return assistant_message(calls=[tool_call("final_answer", {"answer": verdict})])


def challenge_handler_unresolved(model, messages, tools):
    verdict = {"outcome": "unresolved", "rationale": "insufficient evidence to decide", "evidence": []}
    return assistant_message(calls=[tool_call("final_answer", {"answer": verdict})])


def discovery_handler_search_then_candidate(model, messages, tools):
    """Call search_snapshot once, then answer; exercises the tool loop inside smolagents."""

    def role_of(msg):
        role = getattr(msg, "role", None)
        return getattr(role, "value", str(role))

    had_search = any(role_of(m) == "tool-response" for m in messages)
    if not had_search:
        return assistant_message(calls=[tool_call("search_snapshot", {"pattern": "Number.isNaN", "endpoint": "head"})])
    return discovery_handler_candidate_for_mul(model, messages, tools)


def challenge_handler_read_then_supported(model, messages, tools):
    def role_of(msg):
        role = getattr(msg, "role", None)
        return getattr(role, "value", str(role))

    had_read = any(role_of(m) == "tool-response" for m in messages)
    if not had_read:
        return assistant_message(calls=[tool_call(
            "read_snapshot_range", {"endpoint": "head", "path": "src/util.ts", "start_line": 1, "end_line": 6})])
    return challenge_handler_supported(model, messages, tools)


def make_stub_factory():
    """Returns (factory, calls) ; factory(spec) -> ScriptedModel keyed by model_id."""
    variants = {
        "discovery-stub": discovery_handler_candidate_for_mul,
        "discovery-search": discovery_handler_search_then_candidate,
        "discovery-empty": discovery_handler_no_candidates,
        "discovery-garbage": discovery_handler_garbage,
        "discovery-explosive": discovery_handler_explosive,
        "challenge-stub": challenge_handler_supported,
        "challenge-read": challenge_handler_read_then_supported,
        "challenge-disproved": challenge_handler_disproved,
        "challenge-unresolved": challenge_handler_unresolved,
    }

    class _Holder:
        calls = 0

    holder = _Holder()

    def factory(spec):
        handler = variants[spec.model_id]
        holder.calls += 1
        return ScriptedModel(handler, model_id=spec.model_id)

    return factory, holder
