"""Fail closed before Hindsight initialization; never print configuration values."""
import os
import sys
from urllib.parse import urlsplit

# This small launch profile deliberately supports only the verified mapping.
EXPECTED = {
    "HINDSIGHT_API_LLM_PROVIDER": "zai",
    "HINDSIGHT_API_LLM_BASE_URL": "https://api.z.ai/api/paas/v4",
    "HINDSIGHT_API_LLM_MODEL": "glm-5.3-flash",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "openrouter",
    "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL": "voyageai/voyage-4-lite",
    "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
}
REQUIRED = {
    "HINDSIGHT_API_DATABASE_URL",
    "HINDSIGHT_API_LLM_API_KEY",
    "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY",
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


def validate(env):
    for key, value in EXPECTED.items():
        if env.get(key) != value:
            raise ValueError(f"{key}: explicit verified selection required; see docs/memory.md")
    for key in REQUIRED:
        if not env.get(key, "").strip():
            raise ValueError(f"{key}: required")
    for key in env:
        if key.startswith("HINDSIGHT_") and key not in EXPECTED.keys() | REQUIRED | FIXED.keys():
            raise ValueError(f"{key}: unsupported override in this launch profile")
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
