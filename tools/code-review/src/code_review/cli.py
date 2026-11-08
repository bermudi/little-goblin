"""goblin-code-review CLI.

    goblin-code-review review --repo PATH --base REF --head REF \
        --discovery-provider litellm --discovery-model anthropic/claude-sonnet-4-5 \
        --challenge-provider openai --challenge-model gpt-4o

Model identities are explicit endpoint specs. There is no implicit provider
fallback and no silent identity substitution. API keys are read from the
environment; only the *name* of the key variable is recorded in artifacts.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .contracts import ComparisonMode, Limits, ModelSpec, ReviewRequest
from .pipeline import run_review


def _default_key_env(provider: str) -> str | None:
    return {
        "openai": "OPENAI_API_KEY",
        "azure": "AZURE_OPENAI_API_KEY",
        "inference": "HF_TOKEN",
        "litellm": "LLM_API_KEY",
        "bedrock": None,
        "transformers": None,
        "vllm": None,
        "mlx": None,
    }.get(provider)


def _spec(args: argparse.Namespace, which: str) -> ModelSpec:
    provider = getattr(args, f"{which}_provider")
    model = getattr(args, f"{which}_model")
    api_base = getattr(args, f"{which}_api_base")
    key_env = getattr(args, f"{which}_api_key_env") or _default_key_env(provider)
    extra_raw = getattr(args, f"{which}_extra")
    extra = json.loads(extra_raw) if extra_raw else {}
    if not isinstance(extra, dict):
        raise SystemExit(f"--{which}-extra must be a JSON object")
    return ModelSpec(provider=provider, model_id=model, api_base=api_base, api_key_env=key_env, extra=extra)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="goblin-code-review", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    review = sub.add_parser("review", help="review a committed change between two refs")
    review.add_argument("--repo", required=True, help="path to the git repository to review")
    review.add_argument("--base", required=True, help="base ref (for --mode fork-point this resolves the fork source; the merge base is reviewed)")
    review.add_argument("--head", required=True, help="head ref")
    review.add_argument("--mode", choices=[m.value for m in ComparisonMode], default="direct")
    review.add_argument("--scope", action="append", default=[], help="pathspec prefix to include (repeatable); default: whole repo")
    review.add_argument("--install-deps", action="store_true",
                        help="npm ci/install (scripts disabled) in the throwaway snapshots to enable semantic analysis")
    review.add_argument("--output", default=None,
                        help="artifact directory (default: a fresh temp directory, outside the repository)")

    for which in ("discovery", "challenge"):
        group = review.add_argument_group(f"{which} model")
        group.add_argument(f"--{which}-provider", required=True,
                           choices=["litellm", "openai", "inference", "bedrock", "azure", "transformers", "vllm", "mlx"])
        group.add_argument(f"--{which}-model", required=True, help="provider-specific model id")
        group.add_argument(f"--{which}-api-base", default=None, help="endpoint base URL (e.g. for OpenAI-compatible servers)")
        group.add_argument(f"--{which}-api-key-env", default=None,
                           help="environment variable holding the API key (recorded by name, never by value); defaults per provider")
        group.add_argument(f"--{which}-extra", default=None, help="JSON object of additional kwargs for the model class")

    limits = review.add_argument_group("limits")
    limits.add_argument("--max-units", type=int, default=Limits().max_units)
    limits.add_argument("--max-steps-per-unit", type=int, default=Limits().max_steps_per_unit)
    limits.add_argument("--max-steps-per-candidate", type=int, default=Limits().max_steps_per_candidate)
    limits.add_argument("--unit-token-ceiling", type=int, default=Limits().unit_token_ceiling)
    limits.add_argument("--challenge-token-ceiling", type=int, default=Limits().challenge_token_ceiling)
    limits.add_argument("--unit-wall-seconds", type=float, default=Limits().unit_wall_seconds)
    limits.add_argument("--challenge-wall-seconds", type=float, default=Limits().challenge_wall_seconds)
    limits.add_argument("--tool-budget-bytes", type=int, default=Limits().tool_budget_bytes)
    limits.add_argument("--tool-calls-per-unit", type=int, default=Limits().tool_calls_per_unit)
    limits.add_argument("--policy-bytes", type=int, default=Limits().policy_bytes)
    limits.add_argument("--unit-context-bytes", type=int, default=Limits().unit_context_bytes)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "review":
        raise SystemExit(f"unknown command: {args.command}")

    request = ReviewRequest(
        repository=os.path.realpath(args.repo),
        mode=ComparisonMode(args.mode),
        base_ref=args.base,
        head_ref=args.head,
        scope=list(args.scope),
        discovery_model=_spec(args, "discovery"),
        challenge_model=_spec(args, "challenge"),
        limits=Limits(
            max_units=args.max_units,
            max_steps_per_unit=args.max_steps_per_unit,
            max_steps_per_candidate=args.max_steps_per_candidate,
            unit_token_ceiling=args.unit_token_ceiling,
            challenge_token_ceiling=args.challenge_token_ceiling,
            unit_wall_seconds=args.unit_wall_seconds,
            challenge_wall_seconds=args.challenge_wall_seconds,
            tool_budget_bytes=args.tool_budget_bytes,
            tool_calls_per_unit=args.tool_calls_per_unit,
            policy_bytes=args.policy_bytes,
            unit_context_bytes=args.unit_context_bytes,
        ),
    )

    result = run_review(request, output_dir=args.output, install_deps=args.install_deps)
    status = result.get("status", "failed")
    findings = result.get("findings") or []
    out_dir = result.get("_artifact_dir")
    target = f" — artifacts written" if out_dir is None else f" — artifacts in {out_dir}"
    print(f"status: {status} — {len(findings)} supported finding(s){target}", file=sys.stderr)
    print(json.dumps({"status": status, "findings": len(findings)}, indent=2))
    if status == "complete":
        return 0
    if status == "partial":
        return 3
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
