"""Installer-side provider knowledge for the memory stack.

Which providers can fill which Hindsight role, their endpoints and model
catalogs, and how to resolve API keys from goblin's own stores (config
registry + auth.jsonl). start.py — the in-container launch guard — stays
the single authority on accepted wire configuration and is deliberately
self-contained (it is bind-mounted alone into the container); this module
owns everything only the installer needs.

Secrets discipline: values from auth.jsonl travel file → memory only —
resolved once for the live catalog fetch, never printed, logged, written
to an env file, or embedded in a command line. What the container gets is
the record's `!` command itself, stored verbatim as a podman shell
secret's lookup: the credential lives in pass-keys alone.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import select
import subprocess
import time
from urllib import error as urlerror
from urllib import request as urlrequest

DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"

# `pass-cli` as a shell word at command position — start or after
# whitespace/`;&|()"'\`` — optionally path-prefixed, followed by a
# separator or end. Deliberately conservative: `echo pass-cli` trips it
# too. Mirrors src/auth.ts's invokesPassCliDirectly.
_INVOKES_PASS_CLI_DIRECTLY = re.compile(
    r"(?:^|[\s;&|()\"'`])(?:[^\s;&|()\"'`/]*\/)*pass-cli(?:[\s;&|)\"'`]|$)"
)

# A secret is a line of text. Far more means the command is wrong — cap
# it rather than buffering a flood; mirrors src/auth.ts's boundedRun
# (MAX_OUTPUT / RESOLVE_TIMEOUT_MS).
_AUTH_CMD_MAX_OUTPUT = 64 * 1024
_AUTH_CMD_TIMEOUT = 30.0


def _run_auth_command(command: str, auth_name: str) -> tuple[int, bytes]:
    """Run a `!` auth record with capped stdout — reads stop at
    _AUTH_CMD_MAX_OUTPUT+1 so a flooding command can't balloon installer
    memory, and the timeout kills rather than hangs."""
    proc = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    assert proc.stdout is not None
    deadline = time.monotonic() + _AUTH_CMD_TIMEOUT
    buf = bytearray()
    oversized = False
    try:
        while True:
            if len(buf) > _AUTH_CMD_MAX_OUTPUT:
                oversized = True
                proc.kill()
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                proc.kill()
                break
            ready, _, _ = select.select([proc.stdout], [], [], remaining)
            if not ready:
                proc.kill()
                break
            chunk = os.read(
                proc.stdout.fileno(), _AUTH_CMD_MAX_OUTPUT + 1 - len(buf))
            if not chunk:
                break
            buf += chunk
    except OSError as error:
        proc.kill()
        raise ValueError(f"auth command for '{auth_name}' failed: "
                         f"{error.__class__.__name__}") from error
    finally:
        proc.stdout.close()
    try:
        proc.wait(timeout=max(deadline - time.monotonic(), 0.1))
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    if oversized:
        raise ValueError(
            f"auth command for '{auth_name}' produced oversized output")
    if time.monotonic() > deadline:
        raise ValueError(f"auth command for '{auth_name}' timed out")
    return proc.returncode, bytes(buf)


_BUN_JSON5 = (
    "const {parse} = require('json5'); const fs = require('fs');"
    "process.stdout.write(JSON.stringify(parse(fs.readFileSync("
    "process.argv[1], 'utf8'))))"
)


@dataclass(frozen=True)
class Provider:
    name: str
    llm: bool                       # can fill the extraction/consolidation role
    embeddings: bool                # can fill the embeddings role
    llm_base_url: str | None        # fixed upstream; None = compatible endpoints exist, ask
    llm_catalog_url: str | None     # /models for LLM search
    embeddings_catalog_url: str | None
    example_llm: str | None         # verified fallback when a catalog is unreachable
    example_embeddings: str | None


PROVIDERS: dict[str, Provider] = {
    "zai": Provider(
        name="zai", llm=True, embeddings=False,
        llm_base_url="https://api.z.ai/api/paas/v4",
        llm_catalog_url="https://api.z.ai/api/paas/v4/models",
        embeddings_catalog_url=None,
        example_llm="glm-5.3-flash", example_embeddings=None),
    "openai": Provider(
        name="openai", llm=True, embeddings=True,
        llm_base_url=None,  # OpenAI-compatible endpoints vary — the installer asks
        llm_catalog_url=None, embeddings_catalog_url=None,  # derived from the chosen base
        example_llm=None, example_embeddings=None),
    "openrouter": Provider(
        name="openrouter", llm=True, embeddings=True,
        llm_base_url="https://openrouter.ai/api/v1",
        llm_catalog_url="https://openrouter.ai/api/v1/models",
        embeddings_catalog_url="https://openrouter.ai/api/v1/embeddings/models",
        example_llm=None, example_embeddings="voyageai/voyage-4-lite"),
}


# (query, passage) task prefixes for asymmetric embedders, keyed by the
# model's base id — the part before any ":tag". Values are written into
# the env verbatim: trailing whitespace is significant to the embedder.
EMBEDDING_PREFIXES: dict[str, tuple[str, str]] = {
    "embeddinggemma": ("task: search result | query: ",
                       "title: none | text: "),
}


def embedding_prefixes(model: str) -> tuple[str, str] | None:
    """Task prefixes for models that need them, else None.

    Matches the base id exactly: ollama ids arrive tagged
    ("embeddinggemma:latest"), while namespaced ids like
    "google/embeddinggemma-300m" deliberately miss — prefixes are
    per-deployment wiring, not a model-family guess.
    """
    return EMBEDDING_PREFIXES.get(model.split(":", 1)[0])


def providers_for(role: str) -> tuple[Provider, ...]:
    """Providers that can fill a Hindsight role ("llm" or "emb")."""
    if role == "llm":
        return tuple(p for p in PROVIDERS.values() if p.llm)
    if role == "emb":
        return tuple(p for p in PROVIDERS.values() if p.embeddings)
    raise ValueError(f"unknown role: {role}")


def catalog_url_for(provider: str, role: str, base_url: str | None) -> str | None:
    info = PROVIDERS.get(provider)
    if info is None:
        return None
    if provider == "openai":  # compatible endpoints: the catalog follows the chosen base
        return f"{base_url}/models" if base_url else None
    return info.llm_catalog_url if role == "llm" else info.embeddings_catalog_url


def filter_catalog(provider: str, role: str, models: list[str]) -> list[str]:
    if provider == "openai" and role == "emb":
        # openai's /models mixes roles; embedding ids carry the word.
        return [m for m in models if "embedding" in m.lower()]
    return models


def example_for(provider: str, role: str) -> str:
    info = PROVIDERS.get(provider)
    fallback = "any embedding model" if role == "emb" else "any supported model"
    if info is None:
        return fallback
    value = info.example_llm if role == "llm" else info.example_embeddings
    return value or fallback


def read_goblin_providers(goblin_home: Path,
                          repo_root: Path) -> tuple[dict[str, str], str | None]:
    """Providers goblin already uses: name → auth record name.

    goblin's registry is the operator's source of truth — keys get reused,
    endpoints deliberately do NOT (goblin's zai URL is the coding endpoint;
    Hindsight needs the standard one). Returns (mapping, problem): on any
    failure the mapping is empty and `problem` says why, so the installer
    can fall back to asking the operator instead of guessing. goblin.json5
    is JSON5; parsed with goblin's own parser (bun + the repo's json5),
    strict-JSON configs parse directly.
    """
    config = goblin_home / "goblin.json5"
    if not config.is_file():
        return {}, None
    parsed: object = None
    try:
        proc = subprocess.run(
            ["bun", "-e", _BUN_JSON5, str(config)],
            capture_output=True, text=True, timeout=30, cwd=repo_root)
    except (OSError, subprocess.TimeoutExpired):
        proc = None
    if proc is not None and proc.returncode == 0 and proc.stdout.strip():
        try:
            parsed = json.loads(proc.stdout)
        except ValueError:
            parsed = None
    if parsed is None:
        try:
            parsed = json.loads(config.read_text())
        except (OSError, ValueError) as error:
            return {}, f"could not parse {config} ({error.__class__.__name__})"
    registry: dict[str, str] = {}
    if isinstance(parsed, dict) and isinstance(parsed.get("providers"), dict):
        for name, entry in parsed["providers"].items():
            if not isinstance(entry, dict):
                continue
            auth = entry.get("auth")
            registry[str(name)] = (str(auth) if isinstance(auth, str) and auth
                                   else str(name))
    return registry, None


def read_auth_record(goblin_home: Path, auth_name: str) -> str:
    """Raw `value` of the named auth.jsonl record (may be a literal or a
    "!command"). Raises ValueError naming the record — never the value."""
    path = goblin_home / "auth.jsonl"
    records: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError as error:
        raise ValueError(f"auth store unreadable: {error.__class__.__name__}") from error
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if (isinstance(record, dict) and isinstance(record.get("name"), str)
                and isinstance(record.get("value"), str)):
            records[record["name"]] = record["value"]
    if auth_name not in records:
        raise ValueError(f"no auth record named '{auth_name}'")
    return records[auth_name]


def auth_command_for(goblin_home: Path, auth_name: str) -> str:
    """The `!` command behind an auth record — becomes a podman shell
    secret's lookup verbatim, so the container resolves the value itself
    at every start. Literal (non-`!`) records cannot be looked up:
    credentials must live behind a command, normally `!pass-keys get …`.
    """
    value = read_auth_record(goblin_home, auth_name)
    if not value.startswith("!"):
        raise ValueError(
            f"auth record '{auth_name}' stores a literal value — container "
            "credentials must be a `!` command so the store can be queried "
            "at every start (e.g. !pass-keys get goblin-dev NAME)")
    command = value[1:]
    if _INVOKES_PASS_CLI_DIRECTLY.search(command):
        raise ValueError(
            f"auth record '{auth_name}' invokes pass-cli directly — it "
            "would run as the owner session; route it through pass-keys")
    return command


def resolve_auth_key(goblin_home: Path, auth_name: str) -> str:
    """Value of an auth.jsonl record, resolving "!cmd" records in-process.

    The value goes file → memory only; it is never printed, logged, or
    written to disk. Raises ValueError (message without the value) when
    the store or record is unusable.
    """
    value = read_auth_record(goblin_home, auth_name)
    if value.startswith("!"):
        # The same poison lint goblin's own loader enforces (src/auth.ts):
        # a `!` command invoking pass-cli would run as the OWNER session —
        # full account, no audit trail. The loader refuses such records;
        # the installer must not become the bypass. Name the record, never
        # the value.
        if _INVOKES_PASS_CLI_DIRECTLY.search(value[1:]):
            raise ValueError(
                f"auth record '{auth_name}' invokes pass-cli directly — it "
                "would run as the owner session; route it through pass-keys"
            )
        returncode, stdout = _run_auth_command(value[1:], auth_name)
        if returncode != 0 or not stdout.strip():
            raise ValueError(f"auth command for '{auth_name}' failed "
                             f"(exit {returncode})")
        return stdout.strip().decode()
    return value


def fetch_model_catalog(url: str, api_key: str | None,
                        timeout: float = 10.0) -> tuple[list[str] | None, str]:
    """Live model ids from a provider's /models endpoint, with a REASON
    when unavailable (HTTP status vs network vs bad payload) — a 401 is
    a key/endpoint mismatch the operator needs to see. Callers fall back
    to free text; the install never blocks on this.
    """
    request = urlrequest.Request(url)
    if api_key:
        request.add_header("authorization", f"Bearer {api_key}")
    try:
        with urlrequest.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode())
    except urlerror.HTTPError as error:
        return None, f"HTTP {error.code}"
    except (urlerror.URLError, OSError) as error:
        return None, f"unreachable ({getattr(error, 'reason', error)})"
    except ValueError:
        return None, "unparseable response"
    if not isinstance(body, dict):
        return None, "unparseable response"
    data = body.get("data")
    if not isinstance(data, list):
        return None, "unparseable response"
    ids = {item.get("id") for item in data if isinstance(item, dict)}
    models = sorted(model for model in ids if isinstance(model, str) and model)
    if not models:
        return None, "empty catalog"
    return models, "ok"
