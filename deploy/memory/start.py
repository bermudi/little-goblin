"""Fail closed before Hindsight initialization; never print configuration values."""
from collections.abc import Mapping
import os
import sys
from urllib.parse import urlsplit

# Model IDs belong to the operator; only verified wire mappings are allowed.
LLM_PROVIDERS = {"zai", "openai", "openrouter"}
EMBEDDING_PROVIDERS = {"openrouter", "openai"}
REQUIRED = {
    "HINDSIGHT_API_DATABASE_URL",
    "HINDSIGHT_API_LLM_PROVIDER",
    "HINDSIGHT_API_LLM_MODEL",
    "HINDSIGHT_API_LLM_BASE_URL",
    "HINDSIGHT_API_LLM_API_KEY",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER",
    "HINDSIGHT_API_RERANKER_PROVIDER",
}
FIXED = {
    "HINDSIGHT_API_HOST": "0.0.0.0",
    "HINDSIGHT_API_PORT": "8888",
    "HINDSIGHT_API_LOG_LEVEL": "info",
    "HINDSIGHT_ENABLE_API": "true",
    "HINDSIGHT_ENABLE_CP": "false",
    "HINDSIGHT_API_VECTOR_EXTENSION": "pgvector",
    "HINDSIGHT_API_TEXT_SEARCH_EXTENSION": "native",
    "HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH": "false",
}


def validate_endpoint(key: str, value: str) -> None:
    try:
        url = urlsplit(value)
        valid = (url.scheme in {"https", "http"} and bool(url.hostname)
                 and url.username is None and url.password is None
                 and not url.query and not url.fragment
                 and not any(char.isspace() for char in value))
        url.port  # Reject malformed ports too, without printing the URL.
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(f"{key}: expected HTTP(S) base URL without credentials/query/fragment")


def validate(env: Mapping[str, str]) -> None:
    if env.get("HINDSIGHT_API_LLM_PROVIDER") not in LLM_PROVIDERS:
        raise ValueError("HINDSIGHT_API_LLM_PROVIDER: select zai, openai or openrouter")
    embedding = env.get("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "")
    if embedding not in EMBEDDING_PROVIDERS:
        raise ValueError("HINDSIGHT_API_EMBEDDINGS_PROVIDER: select openrouter or openai")
    prefix = f"HINDSIGHT_API_EMBEDDINGS_{embedding.upper()}"
    required = REQUIRED | {f"{prefix}_MODEL", f"{prefix}_API_KEY"}
    endpoints = {"HINDSIGHT_API_LLM_BASE_URL"}
    if embedding == "openai":
        endpoints.add(f"{prefix}_BASE_URL")
    required |= endpoints
    for key in required:
        if not env.get(key, "").strip():
            raise ValueError(f"{key}: required")
    if env["HINDSIGHT_API_RERANKER_PROVIDER"] != "rrf":
        raise ValueError("HINDSIGHT_API_RERANKER_PROVIDER: explicitly select model-free rrf")
    for key in env:
        if key.startswith("HINDSIGHT_") and key not in required | FIXED.keys():
            raise ValueError(f"{key}: unsupported override in this launch profile")
    for key in endpoints:
        validate_endpoint(key, env[key])
    for key, value in FIXED.items():
        if key in env and env[key] != value:
            raise ValueError(f"{key}: conflicts with this launch profile")
    try:
        db = urlsplit(env["HINDSIGHT_API_DATABASE_URL"])
        valid = (db.scheme == "postgresql" and db.hostname == "db" and db.port == 5432
                 and db.username == "hindsight" and bool(db.password)
                 and db.path == "/hindsight" and not db.query and not db.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("HINDSIGHT_API_DATABASE_URL: expected private db:5432/hindsight URI")


if __name__ == "__main__":
    try:
        validate(os.environ)
    except ValueError as error:
        print(f"goblin-memory configuration error: {error}", file=sys.stderr)
        sys.exit(1)
    os.environ.update(FIXED)
    # Defense in depth: even an accidental local-model path cannot fetch weights.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.execv("/app/start-all.sh", ["/app/start-all.sh"])
