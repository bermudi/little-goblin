"""Model factory and smolagents session construction.

Two distinct identities, always: discovery and challenge. There is no
provider fallback, no silent substitution, and no SDK-level retry loop —
provider failure stays failed/partial.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from .budget import BudgetState
from .contracts import ModelSpec


class ModelConfigError(ValueError):
    pass


def _import_model(class_name: str, extra: str):
    try:
        import smolagents

        return getattr(smolagents, class_name)
    except (ModuleNotFoundError, AttributeError) as exc:
        raise ModelConfigError(
            f"this install of smolagents cannot provide {class_name}; "
            f"install the matching extra: pip install 'smolagents[{extra}]' (or 'goblin-code-review[{extra}]')"
        ) from exc


def build_model(spec: ModelSpec):
    """Instantiate a smolagents Model from an explicit ModelSpec."""
    key_env = spec.api_key_env
    api_key = os.environ.get(key_env) if key_env else None
    if key_env and not api_key:
        raise ModelConfigError(f"environment variable {key_env} is not set (required by {spec.provider}:{spec.model_id})")

    if spec.provider == "litellm":
        LiteLLMModel = _import_model("LiteLLMModel", "litellm")

        kwargs = dict(spec.extra)
        kwargs.setdefault("temperature", 0)
        if spec.api_base:
            kwargs["api_base"] = spec.api_base
        if api_key:
            kwargs["api_key"] = api_key
        return LiteLLMModel(model_id=spec.model_id, **kwargs)

    if spec.provider == "openai":
        OpenAIModel = _import_model("OpenAIModel", "openai")

        client_kwargs = {"max_retries": 0}
        client_kwargs.update({k: v for k, v in spec.extra.items()})
        return OpenAIModel(model_id=spec.model_id, api_base=spec.api_base, api_key=api_key, client_kwargs=client_kwargs)

    if spec.provider == "inference":
        InferenceClientModel = _import_model("InferenceClientModel", "inference")

        kwargs = dict(spec.extra)
        if api_key:
            kwargs["api_key"] = api_key
        return InferenceClientModel(model_id=spec.model_id, **kwargs)

    if spec.provider == "bedrock":
        AmazonBedrockModel = _import_model("AmazonBedrockModel", "bedrock")

        # Auth: standard boto3 credential chain / AWS_BEARER_TOKEN_BEDROCK.
        # api_key_env is not mapped anywhere for Bedrock.
        return AmazonBedrockModel(model_id=spec.model_id, **dict(spec.extra))

    if spec.provider == "azure":
        AzureOpenAIModel = _import_model("AzureOpenAIModel", "azure")

        kwargs = dict(spec.extra)
        if spec.api_base:
            kwargs["azure_endpoint"] = spec.api_base
        if api_key:
            kwargs["api_key"] = api_key
        return AzureOpenAIModel(model_id=spec.model_id, **kwargs)

    if spec.provider == "transformers":
        TransformersModel = _import_model("TransformersModel", "transformers")

        return TransformersModel(model_id=spec.model_id, **spec.extra)

    if spec.provider == "vllm":
        VLLMModel = _import_model("VLLMModel", "vllm")

        return VLLMModel(model_id=spec.model_id, **spec.extra)

    if spec.provider == "mlx":
        MLXModel = _import_model("MLXModel", "mlx")

        return MLXModel(model_id=spec.model_id, **spec.extra)

    raise ModelConfigError(f"unknown provider: {spec.provider!r} (no fallback is provided)")


def check_distinct(discovery: ModelSpec, challenge: ModelSpec) -> None:
    if discovery.identity() == challenge.identity():
        raise ModelConfigError(
            f"discovery and challenge name the same identity ({discovery.provider}:{discovery.model_id}); refusing before inference"
        )


def check_key_envs(request) -> None:
    """Fail fast when a required key environment variable is absent.

    Catches configuration mistakes before capture/index spend time (e.g. an
    npm install) on a run that cannot call its models. Model construction
    re-checks this; this only moves the same failure earlier.
    """
    for label, spec in (("discovery", request.discovery_model), ("challenge", request.challenge_model)):
        if spec.api_key_env and not os.environ.get(spec.api_key_env):
            raise ModelConfigError(
                f"{label} model requires environment variable {spec.api_key_env} "
                f"(set it; key values are never logged or recorded)"
            )


# ------------------------------------------------------------- JSON output


_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)


def extract_json(text: str) -> dict | None:
    """Tolerant extraction of the outermost JSON object from model output."""
    if not text:
        return None
    candidate = text.strip()
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", candidate, re.DOTALL)
    if fence:
        try:
            parsed = json.loads(fence.group(1))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    match = _JSON_BLOCK_RE.search(candidate)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return None
    return None


# ------------------------------------------------------- final-answer gate


def make_schema_check(pydantic_model):
    """final_answer_checks callable: strict pydantic validation of the answer."""

    def schema_check(final_answer, memory, agent):  # noqa: ARG001 - smolagents signature
        text = final_answer if isinstance(final_answer, str) else json.dumps(final_answer)
        parsed = extract_json(text)
        if parsed is None:
            return False
        try:
            pydantic_model.model_validate(parsed)
        except Exception:
            return False
        return True

    return schema_check
