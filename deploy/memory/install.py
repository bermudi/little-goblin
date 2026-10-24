"""Interactive installer for the Goblin memory stack (Hindsight + PostgreSQL).

One command. goblin's own registry is the source of truth: providers it
already uses are proposed as defaults, and credentials come from its auth
store as `!` command records — the command itself becomes a podman shell
secret's lookup, so the container resolves the value at every start.
Credentials are never written to env files, never printed, never stored
by podman: only the lookup command is registered.

- the database has NO password: api and db run in one quadlet pod, so the
  API reaches Postgres over the pod's own loopback, which pg_hba already
  trusts; Postgres listens on 127.0.0.1 inside the pod — no socket is
  reachable from outside it
- provider credentials are podman shell-driver secrets named for the env
  var they feed (e.g. HINDSIGHT_API_LLM_API_KEY), mounted as tmpfs files
  under /run/secrets and exported by start.py; the lookup command runs
  `pass-keys get goblin-dev NAME` — the same auth record goblin uses
- model selection: search the provider's LIVE /models catalog with the
  key just resolved — substring in, short numbered list out, exact ids
  accepted; if the catalog is unreachable the reason is shown (a 401 is
  a key/endpoint mismatch worth knowing) and selection falls back to
  free text with a verified example
- endpoints fixed by the provider are derived silently; openai
  (compatible endpoints exist) asks, with its standard endpoint as the
  default; a loopback or embed-relay base URL gets the `local-ollama`
  sentinel — ollama ignores credentials — instead of a real secret
- the assembled config is validated by the launch guard (start.validate)
  BEFORE anything is written — an invalid answer cannot produce a config
  the container would reject; embedding models in providers.EMBEDDING_PREFIXES
  get their task prefixes written automatically (any provider)
- local embeddings (optional): the operator-written
  ~/.config/goblin-memory/embed-relay.env switches on the goblin-embed-*
  units — installed with the other assets, and the relay is enabled
  BEFORE the API starts (it test-embeds during init)
- starting the stack requires an explicit confirmation: first start can
  call the embedding provider (dimension detection) and costs money

Fail loud: every step reports what it is doing and aborts with context on
the first failure. Idempotent for assets; refuses to touch existing env
files unless --reconfigure. An install interrupted between the env write
and its first secret registration is completed — never rewritten — by
the next run. Provider knowledge lives in providers.py; this file is the
flow.

Usage: uv run python deploy/memory/install.py [--no-start] [--reconfigure]
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
# Redundant-alias imports are deliberate re-exports (strict mypy requires
# them): tests patch preflight's stdlib edge through install's namespace.
import getpass as getpass
import ipaddress
import json
import os as os
from pathlib import Path
import re
import shutil as shutil
import socket
import subprocess
import sys
import shlex
import time
from typing import Callable, NoReturn
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlsplit

from providers import (
    DEFAULT_OPENAI_BASE_URL,
    PROVIDERS,
    # Re-exported on purpose: the flow resolves these through this
    # module's namespace so tests can patch install.<name> (strict mypy
    # requires the explicit `as`).
    auth_command_for as auth_command_for,
    catalog_url_for,
    embedding_prefixes,
    example_for,
    fetch_model_catalog,
    filter_catalog,
    providers_for,
    read_goblin_providers as read_goblin_providers,
    resolve_auth_key as resolve_auth_key,
)
from start import validate, validate_endpoint

MEMORY_DIR = Path(__file__).resolve().parent
REPO_ROOT = MEMORY_DIR.parent.parent
CFG_DIR = Path.home() / ".config" / "goblin-memory"
SYSTEMD_DIR = Path.home() / ".config" / "containers" / "systemd"
USER_UNIT_DIR = Path.home() / ".config" / "systemd" / "user"
POSTGRES_ENV = CFG_DIR / "postgres.env"  # legacy: pre-pod installs only
HINDSIGHT_ENV = CFG_DIR / "hindsight.env"
MEMORY_API_URL = "http://127.0.0.1:8888"
HEALTH_URL = MEMORY_API_URL + "/health/ready"
API_UNIT = "goblin-memory-api.service"
DB_UNIT = "goblin-memory-db.service"
API_CONTAINER = API_UNIT.removesuffix(".service")
WATCH_UNITS = ("goblin-memory-watch.service", "goblin-memory-watch.timer")
WATCH_TIMER = "goblin-memory-watch.timer"
# Opt-in local-embeddings relay: the operator writes embed-relay.env from
# the shipped example (the installer never creates it); its presence
# switches the goblin-embed-* units on during install/refresh.
EMBED_RELAY_ENV = CFG_DIR / "embed-relay.env"
EMBED_UNITS = ("goblin-embed-relay.service", "goblin-embed-pin.service",
               "goblin-embed-pin.timer")
RELAY_UNIT = "goblin-embed-relay.service"
PIN_TIMER = "goblin-embed-pin.timer"
GOBLIN_UNIT = "goblin.service"
# Digest-pinned, matching the Quadlet assets. Pre-pulled so systemd's
# TimeoutStartSec budget is spent on migrations, not downloads.
DB_IMAGE = (
    "docker.io/pgvector/pgvector:0.8.2-pg17-bookworm"
    "@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966"
)
API_IMAGE = (
    "ghcr.io/vectorize-io/hindsight-api:1.0.0-slim"
    "@sha256:1e889b5f44a3546a40765d084162cf0807c0b08c97fb29f64d0705597f1ef3b6"
)
BANK_ID_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")

# Ollama model ids (name:tag, namespaced hf.co refs): alphanumerics plus
# . _ ~ : / -. Anything else — %, $, whitespace, quotes, backslashes —
# is a systemd-lexer or JSON-payload hazard in the pin unit's ExecStart.
EMBED_MODEL_PATTERN = re.compile(r"[A-Za-z0-9._~:/-]+")
# Podman secret names this installer registers: env-var names derived
# from the provider entries. Reconstructed env names that miss this are
# a mangled env file, not a registration (a corrupt name would end up
# verbatim in the Quadlet's Secret= lines).
SECRET_NAME_PATTERN = re.compile(r"HINDSIGHT_API_[A-Z0-9_]+")
# The database listens on the pod's loopback and pg_hba trusts loopback —
# there is no password to issue, store, or keep in sync.
DATABASE_URL = "postgresql://hindsight@127.0.0.1:5432/hindsight"
# Sentinel for local embeddings (openai provider pointed at the embed
# relay or loopback): ollama ignores credentials, but the launch guard
# requires a non-empty value. This is a placeholder, not a secret.
LOCAL_EMBED_KEY = "local-ollama"
# A podman shell-driver secret stores COMMANDS, not the credential:
# `lookup` resolves the value on every container start; the other three
# verbs are deliberate no-ops because pass-keys owns the value lifecycle
# (there is nothing external to enumerate, store, or delete).
SECRET_DRIVER_TAIL = "store=cat >/dev/null,list=true,delete=true"
# Region of the installed API Quadlet the installer rewrites when the
# provider set changes. Both markers live inside [Container].
SECRET_BLOCK_BEGIN = "# goblin:secrets-begin"
SECRET_BLOCK_END = "# goblin:secrets-end"
DEFAULT_BANK_ID = "goblin"
DEFAULT_MISSION = (
    "Remember the operator's preferences, decisions, commitments, people, "
    "and ongoing work. Assistant suggestions are not operator decisions. "
    "Date every fact. Extract every fact in English regardless of the "
    "conversation language; keep proper nouns, product names, and quoted "
    "terms verbatim."
)
# Consolidation's own mission — it sits in observations_mission, another
# knob the generic PUT mission never reaches. Same English pin: facts
# entering consolidation are English, facts leaving it must stay so.
DEFAULT_OBSERVATIONS_MISSION = (
    "Consolidate the operator's preferences, decisions, commitments, "
    "people, and ongoing work. Assistant suggestions are not operator "
    "decisions. Preserve corrections as dated evolution. Write "
    "consolidated facts in English; keep proper nouns, product names, "
    "and quoted terms verbatim."
)


@dataclass(frozen=True)
class SecretSpec:
    """A credential the container needs, delivered as a podman shell
    secret named for the env var it feeds. `lookup` is the shell command
    stored as the secret's only data — run at every container start."""
    env_name: str
    lookup: str


@dataclass(frozen=True)
class Answers:
    llm_provider: str
    llm_model: str
    llm_base_url: str
    llm_secret: SecretSpec
    emb_provider: str
    emb_model: str
    emb_secret: SecretSpec | None  # None → the LOCAL_EMBED_KEY sentinel
    emb_base_url: str | None  # required for (and only for) openai embeddings
    bank_id: str
    bank_mission: str


def needed_secrets(answers: Answers) -> list[SecretSpec]:
    specs = [answers.llm_secret]
    if answers.emb_secret is not None:
        specs.append(answers.emb_secret)
    return specs


def fail(message: str) -> NoReturn:
    print(f"\ninstall: {message}", file=sys.stderr)
    sys.exit(1)


def info(message: str) -> None:
    print(f"install: {message}")


# --------------------------------------------------------------------------
# Pure config assembly — unit-tested, no I/O
# --------------------------------------------------------------------------


def build_hindsight_env(answers: Answers) -> dict[str, str]:
    """The FILE side of the container's environment — non-secret settings
    only. Every credential arrives as a podman secret mount instead; the
    launch guard still sees them, because validate() runs on the union."""
    prefix = f"HINDSIGHT_API_EMBEDDINGS_{answers.emb_provider.upper()}"
    env = {
        "HINDSIGHT_API_DATABASE_URL": DATABASE_URL,
        "HINDSIGHT_API_LLM_PROVIDER": answers.llm_provider,
        "HINDSIGHT_API_LLM_BASE_URL": answers.llm_base_url,
        "HINDSIGHT_API_LLM_MODEL": answers.llm_model,
        "HINDSIGHT_API_EMBEDDINGS_PROVIDER": answers.emb_provider,
        "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
        f"{prefix}_MODEL": answers.emb_model,
    }
    if answers.emb_secret is None:
        env[f"{prefix}_API_KEY"] = LOCAL_EMBED_KEY
    if answers.emb_provider == "openai":
        env[f"{prefix}_BASE_URL"] = answers.emb_base_url or ""
    prefixes = embedding_prefixes(answers.emb_model)
    if prefixes is not None:
        env["HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX"] = prefixes[0]
        env["HINDSIGHT_API_EMBEDDINGS_PASSAGE_PREFIX"] = prefixes[1]
    for key, value in env.items():
        if "\n" in value or "\r" in value:
            raise ValueError(f"{key}: line breaks are not representable in env files")
    # The launch guard is the single source of truth for a valid config —
    # check it against what the container actually runs: file values plus
    # the injected secret names.
    runtime = dict(env)
    for spec in needed_secrets(answers):
        runtime[spec.env_name] = "injected-by-podman-secret"
    validate(runtime)
    return env


def render_env_file(env: dict[str, str]) -> str:
    order = [
        "HINDSIGHT_API_DATABASE_URL",
        "HINDSIGHT_API_LLM_PROVIDER",
        "HINDSIGHT_API_LLM_BASE_URL",
        "HINDSIGHT_API_LLM_MODEL",
        "HINDSIGHT_API_EMBEDDINGS_PROVIDER",
        "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL",
        "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
        "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
        "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL",
        "HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX",
        "HINDSIGHT_API_EMBEDDINGS_PASSAGE_PREFIX",
        "HINDSIGHT_API_RERANKER_PROVIDER",
    ]
    # Hard rule: credentials never render into env files. The only
    # *_API_KEY allowed is the documented local-embeddings sentinel —
    # everything else arrives as a podman secret mount.
    for key, value in env.items():
        if re.search(r"_(API_KEY|PASSWORD)$", key) and value != LOCAL_EMBED_KEY:
            raise ValueError(
                f"{key}: credentials are podman secrets, not env-file values")
    lines = [f"{key}={env[key]}" for key in order if key in env]
    unexpected = set(env) - set(order)
    if unexpected:
        raise ValueError(f"unexpected keys: {sorted(unexpected)}")
    return "\n".join(lines) + "\n"


def parse_embed_relay_env(text: str) -> dict[str, str]:
    """The embed-relay opt-in switch: both keys or the file is rejected.

    The relay binds socat to the address verbatim, so it must be a real
    IPv4 literal — not a hostname that could resolve to a LAN address.
    Error messages name keys only, never the rejected values.
    """
    result: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise ValueError("embed-relay.env: line without '='")
        key = key.strip()
        if key in result:
            raise ValueError(f"embed-relay.env: duplicate key {key}")
        result[key] = value
    for required in ("GOBLIN_EMBED_RELAY_ADDR", "GOBLIN_EMBED_MODEL"):
        if not result.get(required):
            raise ValueError(f"embed-relay.env: {required} missing")
    try:
        address = ipaddress.IPv4Address(result["GOBLIN_EMBED_RELAY_ADDR"])
    except ValueError:
        raise ValueError(
            "embed-relay.env: GOBLIN_EMBED_RELAY_ADDR is not an IPv4 address"
        ) from None
    if address.is_unspecified:
        raise ValueError(
            "embed-relay.env: GOBLIN_EMBED_RELAY_ADDR must not be unspecified"
        )
    if not EMBED_MODEL_PATTERN.fullmatch(result["GOBLIN_EMBED_MODEL"]):
        raise ValueError(
            "embed-relay.env: GOBLIN_EMBED_MODEL must be an ollama model id")
    return result


def build_goblin_memory_snippet(bank_id: str, base_url: str = MEMORY_API_URL) -> str:
    if not BANK_ID_PATTERN.fullmatch(bank_id):
        raise ValueError(f"bank id charset: {bank_id!r}")
    # No `auth` key: loopback deployment needs none (DESIGN.md slice 2).
    return f"  memory: {{\n    baseUrl: '{base_url}',\n    bankId: '{bank_id}',\n  }}"


def insert_json5_property(text: str, snippet: str, key: str) -> str:
    """Surgically append one top-level property, preserving all formatting.

    goblin.json5 is JSON5 (unquoted keys, comments, trailing commas); a
    JSON round-trip would destroy it. Handled shapes: empty object, last
    property already comma-terminated (no double comma), and a comment
    after a terminating comma. REFUSES (raises) when a comment follows
    an unterminated property: the separator we would append lands
    inside the comment and the result is invalid JSON5 (proven against
    the json5 parser). Refusal is always safe — the caller falls back
    to printing the snippet for a manual add. Quoted spans are stripped
    before comment detection so URLs in strings ('https://…') do not
    false-positive; a mis-split quote can only over-refuse, never
    corrupt.
    """
    inline = re.compile(rf"[{{,]\s*[\"']?{re.escape(key)}[\"']?\s*:")
    if re.search(rf"(?m)^\s*[\"']?{re.escape(key)}[\"']?\s*:", text) or inline.search(text):
        raise ValueError(f"top-level key already present: {key}")
    stripped = text.rstrip()
    if not stripped.endswith("}"):
        raise ValueError("config does not end with a top-level closing brace")
    body = stripped[:-1].rstrip()
    if body.endswith("{") or body.endswith(","):
        return f"{body}\n{snippet}\n}}\n"
    last_line = body.splitlines()[-1] if body else ""
    without_strings = re.sub(r"'[^']*'|\"[^\"]*\"", "", last_line)
    comment_at = len(without_strings)
    for token in ("//", "/*"):
        found = without_strings.find(token)
        if found != -1:
            comment_at = min(comment_at, found)
    if comment_at < len(without_strings):
        # A comment with no comma before it: a separator appended at end
        # of line lands inside the comment and the result is invalid
        # JSON5 (proven against the json5 parser). Refuse — the caller
        # falls back to a manual add. With a comma before the comment the
        # property is already terminated; insert without a new separator.
        # Strings are stripped first so URLs ('https://…') do not
        # false-positive; a mis-split quote can only over-refuse, never
        # corrupt. Block comments are conservatively treated like line
        # comments — over-refusal is safe, corruption is not.
        if not without_strings[:comment_at].rstrip().endswith(","):
            raise ValueError(
                "comment at the end of the config without a preceding comma; "
                "cannot place the separator safely — add the block manually")
        return f"{body}\n{snippet}\n}}\n"
    return f"{body},\n{snippet}\n}}\n"


# --------------------------------------------------------------------------
# File I/O — durable, mode-correct, secret-safe
# --------------------------------------------------------------------------


def write_file_atomic(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        # The os.open mode is masked by umask; set it explicitly so 0600
        # secrets and preserved config modes hold regardless of umask.
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)  # the rename itself must survive power loss
        finally:
            os.close(dir_fd)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def validate_embed_relay_config(cfg_dir: Path) -> None:
    """Fail loud on a present-but-invalid embed-relay.env BEFORE any
    durable state is written — an invalid opt-in must not coexist with
    half-installed units or env files. Absent switch = remote embeddings,
    always valid; a good switch is left untouched."""
    switch = cfg_dir / EMBED_RELAY_ENV.name
    if not switch.is_file():
        return
    try:
        parse_embed_relay_env(switch.read_text())
    except (OSError, ValueError) as error:
        fail(f"{switch}: {error}")


def install_assets(memory_dir: Path, systemd_dir: Path, cfg_dir: Path,
                    user_unit_dir: Path,
                    skip_existing_quadlets: bool = False) -> list[Path]:
    """Copy shipped assets into place. With skip_existing_quadlets, a
    Quadlet already at the destination is left untouched — the installed
    Quadlets are operator-editable (slow first-run migrations are fixed by
    raising TimeoutStartSec in the installed file, per the health-gate
    failure message), so a refresh hands over new assets without clobbering
    operator edits. Fresh installs keep overwrite semantics — deleting a
    Quadlet before a fresh install is the reset path."""
    validate_embed_relay_config(cfg_dir)
    systemd_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cfg_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    user_unit_dir.mkdir(parents=True, exist_ok=True)
    installed: list[Path] = []
    for pattern in ("*.container", "*.network", "*.volume", "*.pod"):
        for src in sorted(memory_dir.glob(pattern)):
            dst = systemd_dir / src.name
            if skip_existing_quadlets and dst.exists():
                info(f"kept existing {dst} — operator-editable, not overwritten")
                continue
            shutil.copyfile(src, dst)
            dst.chmod(0o644)
            installed.append(dst)
    for name in WATCH_UNITS:
        src = memory_dir / name
        if not src.is_file():
            fail(f"missing deploy asset: {src}")
        dst = user_unit_dir / name
        shutil.copyfile(src, dst)
        dst.chmod(0o644)
        installed.append(dst)
    installed.extend(install_embed_units(memory_dir, cfg_dir, user_unit_dir))
    start_src = memory_dir / "start.py"
    if not start_src.is_file():
        fail(f"missing deploy asset: {start_src}")
    start_dst = cfg_dir / "start.py"
    shutil.copyfile(start_src, start_dst)
    start_dst.chmod(0o644)
    installed.append(start_dst)
    # Always copied like start.py (quadlets above are the only
    # operator-editable assets): the container healthcheck must track
    # the shipped probe, never drift on an installed box.
    health_src = memory_dir / "healthcheck.py"
    if not health_src.is_file():
        fail(f"missing deploy asset: {health_src}")
    health_dst = cfg_dir / "healthcheck.py"
    shutil.copyfile(health_src, health_dst)
    health_dst.chmod(0o644)
    installed.append(health_dst)
    return installed


def install_embed_units(memory_dir: Path, cfg_dir: Path,
                        user_unit_dir: Path) -> list[Path]:
    """Copy the goblin-embed-* units when the operator opted in.

    The opt-in is the operator-written embed-relay.env; absent file = the
    units stay uninstalled (an existing install is never torn down). A
    present-but-invalid switch fails BEFORE any unit lands, so the relay
    can't come up half-configured."""
    switch = cfg_dir / EMBED_RELAY_ENV.name
    validate_embed_relay_config(cfg_dir)
    if not switch.is_file():
        return []
    user_unit_dir.mkdir(parents=True, exist_ok=True)
    installed: list[Path] = []
    for name in EMBED_UNITS:
        src = memory_dir / name
        if not src.is_file():
            fail(f"missing deploy asset: {src}")
        dst = user_unit_dir / name
        shutil.copyfile(src, dst)
        dst.chmod(0o644)
        installed.append(dst)
    return installed


def enable_embed_relay(cfg_dir: Path) -> None:
    """Start+enable the relay and pin timer when the operator opted in.

    No-op without the switch file — remote-only installs never see these
    units. Callers order this BEFORE the API starts: the API test-embeds
    during init and refuses to boot when its endpoint is dead."""
    if not (cfg_dir / EMBED_RELAY_ENV.name).is_file():
        return
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "--now", RELAY_UNIT, PIN_TIMER])
    info("embed relay enabled — an already-running relay keeps its old "
         "definition until 'systemctl --user restart goblin-embed-relay'")


def deferred_start_commands(cfg_dir: Path) -> list[str]:
    """The continuation printed when the stack was installed but not
    started (--no-start or a declined first start). PRINTED only — this
    helper runs nothing.

    Same boot/watch policy a confirmed start applies: reload so Quadlet
    generates the API's boot dependency (and the watch units load),
    relay before the API when local embeddings are opted in (the API
    test-embeds during init), API start, then the health watch timer."""
    commands = ["systemctl --user daemon-reload"]
    if (cfg_dir / EMBED_RELAY_ENV.name).is_file():
        commands.append(
            f"systemctl --user enable --now {RELAY_UNIT} {PIN_TIMER}")
    commands.append(f"systemctl --user start {API_UNIT}")
    commands.append(f"systemctl --user enable --now {WATCH_TIMER}")
    return commands


# --------------------------------------------------------------------------
# System steps — logged, fail loud
# --------------------------------------------------------------------------


def run(command: list[str], timeout: float = 600,
        stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    info("$ " + " ".join(command))
    try:
        proc = subprocess.run(command, text=True, capture_output=True,
                              timeout=timeout, input=stdin)
    except subprocess.TimeoutExpired:
        fail(f"command timed out after {timeout}s: {' '.join(command)}")
    if proc.returncode != 0:
        output = (proc.stderr.strip() or proc.stdout.strip())[:2000]
        fail(f"command failed ({proc.returncode}): {' '.join(command)}\n{output}")
    return proc


# --------------------------------------------------------------------------
# Podman shell secrets — the store holds lookup commands, never values
# --------------------------------------------------------------------------


def secret_lookup(command: str) -> str:
    """An auth record's `!` command becomes the secret's lookup verbatim,
    under two fixes. Units run with PATH missing ~/.local/bin (pass-keys
    lives there), so prepend it via $HOME — never a literal operator home.
    And the shell driver returns stdout byte-exact, so defend against a
    trailing newline breaking the credential."""
    return f"env PATH=$HOME/.local/bin:$PATH {command} | tr -d '\\n'"


def ensure_secret(spec: SecretSpec) -> None:
    run(["podman", "secret", "create", "--replace", "--driver", "shell",
         "--driver-opts", f"lookup={spec.lookup},{SECRET_DRIVER_TAIL}",
         spec.env_name, "-"],
        # The value piped at create is discarded by the no-op store: podman
        # requires input syntactically, the lookup supplies the real one.
        stdin="managed-by-goblin-auth-store\n")


def managed_secrets() -> dict[str, dict[str, str]]:
    """name → stored driver opts for our shell secrets (HINDSIGHT_API_*).

    Fail closed: callers act on this snapshot (prune orphans, restore on
    rollback), so an indeterminate answer must not read as 'no managed
    registrations'. Every failure path names the operation and the
    secret name only — never raw output, options, or a lookup.
    """
    result = probe(["podman", "secret", "ls", "--format", "{{.Name}}\t{{.Driver}}"])
    if result is None or result.returncode != 0:
        fail("cannot list podman secrets — refusing to snapshot the "
             "managed registrations (is `podman secret` reachable?)")
    found: dict[str, dict[str, str]] = {}
    for line in (result.stdout or "").splitlines():
        name, _, driver = line.partition("\t")
        if driver.strip() != "shell" or not name.startswith("HINDSIGHT_API_"):
            continue
        inspect = probe(["podman", "secret", "inspect", name,
                         "--format", "{{json .Spec.Driver.Options}}"])
        if inspect is None or inspect.returncode != 0:
            fail(f"cannot inspect podman secret '{name}'")
        try:
            options = json.loads(inspect.stdout)
        except ValueError:
            fail(f"podman secret '{name}' driver options did not decode")
        if not isinstance(options, dict):
            fail(f"podman secret '{name}' driver options are not an object")
        if not all(isinstance(k, str) and isinstance(v, str)
                   for k, v in options.items()):
            fail(f"podman secret '{name}' driver options are not string pairs")
        if not isinstance(options.get("lookup"), str) or not options["lookup"].strip():
            fail(f"podman secret '{name}' has no usable lookup registration")
        found[name] = options
    return found


def sync_secrets(needed: list[SecretSpec]) -> None:
    """Create/replace the secrets the profile needs and unregister
    HINDSIGHT_API_* secrets it no longer does (a provider switch leaves
    an orphan registration otherwise)."""
    for spec in needed:
        ensure_secret(spec)
        info(f"podman secret '{spec.env_name}' → lookup via auth store")
    prune_secrets({s.env_name for s in needed})


def prune_secrets(keep: set[str]) -> None:
    """Unregister managed secrets the profile no longer needs (a provider
    switch leaves an orphan registration otherwise)."""
    for stale in sorted(set(managed_secrets()) - keep):
        run(["podman", "secret", "rm", stale])
        info(f"podman secret '{stale}' removed — no longer configured")


def restore_secrets(previous: dict[str, dict[str, str]]) -> None:
    """Rollback helper: recreate the pre-change secret registrations and
    drop names the previous set did not have."""
    for name, opts in previous.items():
        lookup = opts.get("lookup")
        if not lookup:
            continue
        run(["podman", "secret", "create", "--replace", "--driver", "shell",
             "--driver-opts", f"lookup={lookup},{SECRET_DRIVER_TAIL}", name, "-"],
            stdin="managed-by-goblin-auth-store\n")
    for extra in set(managed_secrets()) - set(previous):
        run(["podman", "secret", "rm", extra])


def apply_secret_block(path: Path, env_names: list[str]) -> None:
    """Write the provider-scoped Secret= lines into the installed API
    Quadlet's marked region. Lines carry no values — each names a secret
    whose mount start.py exports."""
    text = path.read_text()
    lines = [f"Secret={name},type=mount" for name in env_names]
    block = SECRET_BLOCK_BEGIN + "\n" + "\n".join(lines)
    block += ("\n" if lines else "") + SECRET_BLOCK_END
    if SECRET_BLOCK_BEGIN not in text or SECRET_BLOCK_END not in text:
        fail(f"{path} has no managed-secrets markers — the installed "
             "Quadlet predates podman secrets; copy the shipped file first "
             "(docs/memory.md → migration)")
    before, _, rest = text.partition(SECRET_BLOCK_BEGIN)
    _, _, after = rest.partition(SECRET_BLOCK_END)
    write_file_atomic(path, before + block + after,
                      path.stat().st_mode & 0o777)


def probe(command: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(command, text=True, capture_output=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        return None


def preflight() -> None:
    if os.geteuid() == 0:
        fail("running as root; this stack is rootless Podman by design")
    if shutil.which("podman") is None:
        fail("podman not found in PATH")
    run(["podman", "--version"])
    run(["systemctl", "--user", "show-environment"])
    user = getpass.getuser()
    for mapping_file in ("/etc/subuid", "/etc/subgid"):
        path = Path(mapping_file)
        try:
            text = path.read_text()
        except OSError as error:
            fail(f"cannot read {mapping_file} (rootless requirement): {error}")
        if not any(line.startswith(f"{user}:") for line in text.splitlines()):
            fail(f"{user} missing from {mapping_file}; run usermod --add-subuids/--add-subgids")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 8888))
    except OSError:
        # A re-run hits its own stack first: the API container is the
        # one legitimate holder of the port. Anything else still warns.
        running = probe(["podman", "container", "inspect", "--format",
                         "{{.State.Running}}", API_CONTAINER])
        if (running is not None and running.returncode == 0
                and (running.stdout or "").strip() == "true"):
            info(f"127.0.0.1:8888 is held by the running {API_CONTAINER} "
                 "container — a re-run, not a conflict")
        else:
            print("install: WARNING: 127.0.0.1:8888 already in use; "
                  "the API container cannot publish there", file=sys.stderr)


def pre_pull_images() -> None:
    for image in (DB_IMAGE, API_IMAGE):
        digest = image.split("@", 1)[1][:19]
        info(f"pulling {image.rsplit(':', 1)[0].split('/', 1)[0]} "
             f"({image.split('/', 1)[-1].split('@')[0]}, digest {digest}…)")
        run(["podman", "pull", image])


def start_stack() -> None:
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "start", DB_UNIT])
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        state = probe(["systemctl", "--user", "is-active", DB_UNIT])
        if state is not None and (state.stdout or "").strip() == "failed":
            fail(f"{DB_UNIT} failed — journalctl --user -u {DB_UNIT}")
        status = probe(["podman", "inspect", "--format",
                        "{{.State.Health.Status}}", "goblin-memory-db"])
        if status is not None and (status.stdout or "").strip() == "healthy":
            break
        time.sleep(5)
    else:
        fail(f"{DB_UNIT} not healthy after 180s — "
             f"journalctl --user -u {DB_UNIT}")
    info("database healthy; starting API")
    # Local-embeddings opt-in: the API test-embeds during init, so the
    # relay must be live before it starts.
    enable_embed_relay(CFG_DIR)
    run(["systemctl", "--user", "start", API_UNIT])
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        if http_ok(HEALTH_URL):
            info("API healthy")
            break
        time.sleep(5)
    else:
        fail(f"{API_UNIT} not ready after 480s — journalctl --user -u {API_UNIT}; "
             "first-run migrations can exceed systemd's TimeoutStartSec=300: "
             "raise it deliberately in the installed Quadlet and re-run install")
    # A healthy stack is not enough: it must also survive the next boot.
    # Enabling is a runtime claim, not a config write — deliberately after
    # the health gate, so a broken stack never hooks itself into boot.
    # Quadlet's [Install] creates the boot dependency in its generator
    # directory. A same-name relative link in user units points to itself.
    # The watch units landed after the earlier daemon-reload; load them,
    # then start the timer now. It turns an unhealthy-but-alive container
    # into a unit restart (Restart=on-failure only sees process death).
    run(["systemctl", "--user", "daemon-reload"])
    # Fail loud if the manager did not accept the boot hook: a silently
    # dead wants-link is exactly the day-long-outage failure mode the
    # hook exists to close.
    if not api_boot_hook_present():
        fail(f"{API_UNIT} not in default.target Wants after daemon-reload — "
             "ensure the installed API Quadlet has [Install] / "
             "WantedBy=default.target")
    info(f"{API_UNIT} generated dependency of default.target — starts on boot "
         "(linger keeps the user manager alive)")
    run(["systemctl", "--user", "enable", "--now", WATCH_TIMER])
    info(f"{WATCH_TIMER} enabled — health checked every 5 minutes")


def _env_assignment(text: str, key: str) -> str | None:
    """One KEY=value assignment's value, shlex-parsed (never evaluated).
    None when the key is absent, malformed, multi-token, or assigned
    more than once — the live environment would read the last value,
    so a duplicate can never prove compatibility."""
    found: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        name, sep, value = stripped.partition("=")
        if sep and name.strip() == key:
            if found is not None:
                return None
            try:
                parts = shlex.split(value)
            except ValueError:
                return None
            if len(parts) != 1:
                return None
            found = parts[0]
    return found


def _quadlet_pod(text: str) -> str | None:
    """The [Container] section's Pod= value, shlex-parsed. None when the
    section lacks it or names it twice — a Pod in [Unit] or elsewhere is
    not a pod binding."""
    section = ""
    found: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1].strip()
            continue
        name, sep, value = stripped.partition("=")
        if sep and name.strip() == "Pod" and section == "Container":
            if found is not None:
                return None
            try:
                parts = shlex.split(value)
            except ValueError:
                return None
            if len(parts) != 1:
                return None
            found = parts[0]
    return found


def _compatible_install_problem() -> str | None:
    """Why this installed stack cannot take an asset refresh, else None.

    A refresh lands only on the pod-era, passwordless profile: the
    installed env's database URI must be exactly the supported
    DATABASE_URL and an incumbent API Quadlet must live in
    goblin-memory.pod. Anything else is a legacy or hand-rolled stack —
    copying fresh assets over it would silently half-migrate it."""
    try:
        env_text = HINDSIGHT_ENV.read_text()
    except OSError as error:
        return f"cannot read {HINDSIGHT_ENV.name}: {error}"
    if _env_assignment(env_text, "HINDSIGHT_API_DATABASE_URL") != DATABASE_URL:
        return ("the installed database URI is not this profile's "
                "passwordless pod loopback")
    quadlet = SYSTEMD_DIR / "goblin-memory-api.container"
    if quadlet.is_file():
        try:
            quadlet_text = quadlet.read_text()
        except OSError as error:
            return f"cannot read {quadlet.name}: {error}"
        if _quadlet_pod(quadlet_text) != "goblin-memory.pod":
            return (f"{quadlet.name} is not bound to goblin-memory.pod — a "
                    "non-pod Quadlet needs migration, not a refresh")
    return None


def assert_compatible_install() -> None:
    """Refuse a refresh/reconfigure against a non-pod-era install."""
    problem = _compatible_install_problem()
    if problem is not None:
        fail(f"unsupported installed memory stack: {problem} — migrate "
             "per docs/memory.md → Migration, then re-run")


def refresh_assets(enable_watch: bool) -> None:
    """Idempotent asset install + manager reload for boxes that already
    have a stack. install_assets() is otherwise reached only on a fresh
    install, so a re-run (status path, --reconfigure) never picked up the
    watch units — the health watcher stayed inactive forever. Same
    enablement start_stack uses when the timer should be live. Existing
    Quadlets are never overwritten: the operator may have tuned them
    (TimeoutStartSec), and this path only needs to deliver new assets
    and the watch units."""
    if HINDSIGHT_ENV.is_file():
        assert_compatible_install()
    installed = install_assets(MEMORY_DIR, SYSTEMD_DIR, CFG_DIR, USER_UNIT_DIR,
                               skip_existing_quadlets=True)
    for path in installed:
        info(f"installed {path}")
    run(["systemctl", "--user", "daemon-reload"])
    if enable_watch:
        enable_embed_relay(CFG_DIR)
        run(["systemctl", "--user", "enable", "--now", WATCH_TIMER])
        info(f"{WATCH_TIMER} enabled — health checked every 5 minutes")


def _specs_from_installed_env(goblin_home: Path) -> list[SecretSpec]:
    """Reconstruct the secret registrations the installed hindsight.env
    needs: the env file's provider entries plus goblin's own provider
    registry — the same specs prompt_answers would have produced for
    this config. No key values are resolved (only the model catalog
    ever needed one); the lookup command is all a podman shell secret
    stores."""
    env_text = HINDSIGHT_ENV.read_text()
    llm_provider = _env_assignment(env_text, "HINDSIGHT_API_LLM_PROVIDER")
    emb_provider = _env_assignment(env_text, "HINDSIGHT_API_EMBEDDINGS_PROVIDER")
    if llm_provider is None or emb_provider is None:
        fail(f"cannot reconstruct the needed secrets from "
             f"{HINDSIGHT_ENV.name}: provider entries are missing")
    emb_key = f"HINDSIGHT_API_EMBEDDINGS_{emb_provider.upper()}_API_KEY"
    if SECRET_NAME_PATTERN.fullmatch(emb_key) is None:
        fail(f"{HINDSIGHT_ENV.name}: unsupported embeddings provider entry")
    registry, problem = read_goblin_providers(goblin_home, REPO_ROOT)
    if problem is not None:
        fail(f"{problem} — the interrupted install registers its secrets "
             "from goblin's provider registry; fix it and rerun")

    def spec_for(provider: str, env_name: str) -> SecretSpec:
        auth_name = registry.get(provider)
        if auth_name is None:
            fail(f"{provider}: not in goblin's provider registry — the "
                 "interrupted install registered its secrets from that "
                 "registry. Run: pass-keys add goblin-dev <NAME> Keys/<item>, "
                 f"then set providers.{provider}.auth in goblin.json5 and rerun")
        try:
            command = auth_command_for(goblin_home, auth_name)
        except ValueError as error:
            fail(f"{provider}: {error}")
        return SecretSpec(env_name, secret_lookup(command))

    specs = [spec_for(llm_provider, "HINDSIGHT_API_LLM_API_KEY")]
    # The local-embeddings sentinel is render_env_file's one allowed
    # *_API_KEY line: its presence means no embeddings secret exists.
    if _env_assignment(env_text, emb_key) != LOCAL_EMBED_KEY:
        specs.append(spec_for(emb_provider, emb_key))
    return specs


def complete_half_install(goblin_home: Path) -> None:
    """Converge a fresh install that died between writing hindsight.env
    and registering its first podman secret — an install_assets or
    apply_secret_block failure, a failed first `podman secret create`,
    or Ctrl+C in that window. Every rerun path previously dead-ended
    there: the status path only refreshed assets, --resume could not
    start an API whose Quadlet mounts never-created secrets, and
    --reconfigure refuses an empty managed set. The env file is the
    config of record and is NOT rewritten (the no-rewrite contract
    holds): assets land with fresh-install semantics — this state can
    only come from the crashed fresh path, whose own Quadlet copies are
    minutes old — the Quadlet's managed block is refilled, and the
    secret registrations are reconstructed against the env file.
    Refuses before any mutation when the env is not this profile's
    pod-era config (a legacy install needs migration, not completion)."""
    assert_compatible_install()
    specs = _specs_from_installed_env(goblin_home)
    info(f"{HINDSIGHT_ENV.name} is present with no registered podman "
         "secrets — an interrupted install; completing asset install and "
         "secret registration (config kept as-is)")
    installed = install_assets(MEMORY_DIR, SYSTEMD_DIR, CFG_DIR, USER_UNIT_DIR)
    for path in installed:
        info(f"installed {path}")
    apply_secret_block(SYSTEMD_DIR / "goblin-memory-api.container",
                       [s.env_name for s in specs])
    sync_secrets(specs)
    info("interrupted install completed: assets and podman secrets are in place")


def http_ok(url: str) -> bool:
    try:
        with urlrequest.urlopen(url, timeout=5) as response:
            return bool(response.status == 200)
    except (urlerror.URLError, OSError):
        return False


def api_healthy(seconds: float) -> bool:
    """Poll the API health endpoint until it answers or the budget runs
    out. A restart of an already-migrated stack is normally quick, but a
    single check 10s in would judge a merely slow restart as broken —
    and callers act on that verdict (see the --reconfigure rollback)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if http_ok(HEALTH_URL):
            return True
        time.sleep(5)
    return False


def create_bank(bank_id: str, mission: str) -> None:
    url = f"{MEMORY_API_URL}/v1/default/banks/{bank_id}"
    body = json.dumps({"mission": mission}).encode()
    request = urlrequest.Request(url, data=body, method="PUT",
                                 headers={"content-type": "application/json"})
    try:
        with urlrequest.urlopen(request, timeout=30) as response:
            info(f"bank '{bank_id}' created (HTTP {response.status})")
    except urlerror.HTTPError as error:
        if error.code == 409:
            info(f"bank '{bank_id}' already exists — kept as-is")
            warn_bank_drift(url, bank_id, mission)
            return
        detail = error.read().decode(errors="replace")[:500]
        fail(f"bank creation failed (HTTP {error.code}): {detail}")
    except OSError as error:
        fail(f"bank creation failed: {error}")
    # The PUT mission above lands as reflect_mission; extraction reads
    # retain_mission and consolidation reads observations_mission
    # (docs/memory.md). Point both at the canonical texts — without
    # this the mission is dead config for those two paths.
    patch = json.dumps({
        "updates": {
            "retain_mission": mission,
            "observations_mission": DEFAULT_OBSERVATIONS_MISSION,
        }
    }).encode()
    patch_req = urlrequest.Request(
        f"{url}/config", data=patch, method="PATCH",
        headers={"content-type": "application/json"})
    try:
        with urlrequest.urlopen(patch_req, timeout=30) as response:
            info(f"bank '{bank_id}' retain_mission set (HTTP {response.status})")
    except urlerror.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        fail(f"retain_mission patch failed (HTTP {error.code}): {detail}")
    except OSError as error:
        fail(f"retain_mission patch failed: {error}")


def warn_bank_drift(url: str, bank_id: str, mission: str) -> None:
    """The 409 path: an existing bank is NEVER patched, but silent drift
    between its live missions and the canonical texts is how a bank
    quietly stops extracting the way docs/memory.md promises — compare
    and warn with the repair line (the same PATCH the creation path and
    docs send). A read failure warns too; neither ever fails the install."""
    get_req = urlrequest.Request(f"{url}/config", method="GET")
    try:
        with urlrequest.urlopen(get_req, timeout=30) as response:
            payload = json.loads(response.read().decode())
    except urlerror.HTTPError as error:
        print(f"install: WARNING: could not read bank '{bank_id}' config "
              f"(HTTP {error.code}) — cannot check mission drift",
              file=sys.stderr)
        return
    except (OSError, ValueError) as error:
        print(f"install: WARNING: could not read bank '{bank_id}' config "
              f"({error}) — cannot check mission drift",
              file=sys.stderr)
        return
    config = payload.get("config") if isinstance(payload, dict) else None
    if not isinstance(config, dict):
        print(f"install: WARNING: bank '{bank_id}' config response has an "
              "unexpected shape — cannot check mission drift",
              file=sys.stderr)
        return
    repair = json.dumps({
        "updates": {
            "retain_mission": mission,
            "observations_mission": DEFAULT_OBSERVATIONS_MISSION,
        }
    })
    for field, canonical in (
        ("retain_mission", mission),
        ("observations_mission", DEFAULT_OBSERVATIONS_MISSION),
    ):
        if config.get(field) == canonical:
            continue
        print(f"install: WARNING: bank '{bank_id}' {field} differs from the "
              "canonical text — not patched (existing banks are kept as-is); "
              "to repair run:\n"
              f"  curl -s -X PATCH {url}/config "
              "-H 'content-type: application/json' "
              f"-d {shlex.quote(repair)}",
              file=sys.stderr)


def goblin_stable(seconds: float) -> bool:
    """Type=simple reports 'active' the moment bun spawns; require the
    unit to STAY active with zero restarts, else a boot-time config
    crash can read as success."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        state = probe(["systemctl", "--user", "show", GOBLIN_UNIT,
                       "--property=ActiveState", "--property=NRestarts"])
        if state is None:
            return False
        props = dict(
            line.split("=", 1)
            for line in (state.stdout or "").splitlines() if "=" in line
        )
        if props.get("ActiveState") != "active" or int(props.get("NRestarts", "0")) > 0:
            return False
        time.sleep(2)
    return True


def wire_goblin(goblin_home: Path, bank_id: str) -> str:
    """Patch goblin.json5 and restart goblin. Returns one of:
    "live"    — memory block patched AND goblin confirmed stable on it
    "patched" — config written, restart declined: it is already in
                place, only the restart is outstanding
    "manual"  — nothing written; the block to add was printed above
    Any failure rolls the config back and verifies the rollback —
    never leave the operator's bot dead or patched-but-down.
    """
    config = goblin_home / "goblin.json5"
    snippet = build_goblin_memory_snippet(bank_id)
    if not config.is_file():
        info(f"{config} not found — add this block yourself:")
        print(snippet)
        return "manual"
    text = config.read_text()
    try:
        updated = insert_json5_property(text, snippet, "memory")
    except ValueError as error:
        info(f"goblin.json5 not patched: {error} — add this block yourself:")
        print(snippet)
        return "manual"
    mode = config.stat().st_mode & 0o777
    backup = config.with_name(config.name + ".pre-memory")
    write_file_atomic(backup, text, mode)
    write_file_atomic(config, updated, mode)
    info(f"memory block added to {config} (backup: {backup.name})")
    if not ask_yes("restart goblin now so memory goes live?", default=True):
        return "patched"

    def rollback(reason: str) -> None:
        write_file_atomic(config, text, mode)
        restart = probe(["systemctl", "--user", "restart", GOBLIN_UNIT])
        recovered = restart is not None and restart.returncode == 0 and goblin_stable(15)
        suffix = "and verified goblin is back up" if recovered else \
            "but goblin did NOT come back — check: systemctl --user status goblin"
        fail(f"{reason}; rolled back to the pre-memory config {suffix}")

    restart = probe(["systemctl", "--user", "restart", GOBLIN_UNIT])
    if restart is None or restart.returncode != 0:
        output = ("systemctl probe failed" if restart is None
                  else (restart.stderr or "").strip()[:500])
        rollback(f"goblin restart command failed ({output})")
    if not goblin_stable(30):
        rollback("goblin did not stay up with the memory block "
                 "(config rejected or crash-looping)")
    info("goblin restarted, stable — send /memory in Telegram to check status")
    return "live"


def report_wiring(wired: str) -> None:
    """The shared tail of fresh install and --resume."""
    if wired == "live":
        print("\nDone. Memory is live. In Telegram: /memory")
    elif wired == "patched":
        # The block is already in goblin.json5 — printing it again would
        # invite a double-add the next installer run rejects.
        print("\nStack and bank are live, and goblin.json5 is already patched — "
              "restart goblin when ready:\n"
              "  systemctl --user restart goblin.service")
    else:
        print("\nStack and bank are live, but goblin was not wired — "
              "add the memory block printed above, then: "
              "systemctl --user restart goblin.service")


# --------------------------------------------------------------------------
# Interactive prompts — the only place input is collected
# --------------------------------------------------------------------------


def ask(prompt: str, check: Callable[[str], str]) -> str:
    while True:
        raw = input(f"{prompt}: ").strip()
        try:
            return check(raw)
        except ValueError as error:
            print(f"  ✗ {error}")


def ask_nonempty(label: str) -> Callable[[str], str]:
    def check(value: str) -> str:
        if not value:
            raise ValueError(f"{label} is required")
        if any(ch.isspace() for ch in value):
            raise ValueError(f"{label} must not contain whitespace")
        return value
    return check


def ask_choice(prompt: str, options: tuple[str, ...]) -> str:
    # Print the menu, THEN ask on a fresh line — passing a multi-line
    # string to input() glues the ": " prompt onto the last option and
    # the typed answer looks like part of the menu.
    print(prompt)
    for index, option in enumerate(options, 1):
        print(f"  {index}) {option}")

    def check(value: str) -> str:
        if value.isdigit() and 1 <= int(value) <= len(options):
            return options[int(value) - 1]
        if value in options:
            return value
        raise ValueError(f"choose 1-{len(options)}")

    return ask(f"choice [1-{len(options)}]", check)


def ask_url(prompt: str, hint: str) -> str:
    def check(value: str) -> str:
        if not value:
            return hint
        validate_endpoint("(input)", value)
        return value
    return ask(f"{prompt} [default: {hint}]", check)


def relay_address() -> str | None:
    """The embed relay's bind address when the operator opted in — the
    non-loopback endpoint that still means 'local ollama, no real key'.
    The switch was validated before any prompt; a parse failure can only
    mean it vanished mid-run — treat as no relay rather than guess."""
    path = CFG_DIR / EMBED_RELAY_ENV.name
    if not path.is_file():
        return None
    try:
        return parse_embed_relay_env(path.read_text())["GOBLIN_EMBED_RELAY_ADDR"]
    except (OSError, ValueError):
        return None


def is_local_embeddings_endpoint(base_url: str) -> bool:
    """True when the embeddings base URL terminates on this host — the
    loopback case and the embed-relay case both reach ollama, which
    ignores credentials, so no secret is needed (sentinel instead)."""
    host = urlsplit(base_url).hostname
    if host in ("127.0.0.1", "localhost", "::1"):
        return True
    return host is not None and host == relay_address()


def ask_model_search(label: str, catalog: list[str] | None, example: str) -> str:
    """Search-then-pick over the live catalog. Numbers are good UX when
    the list is filtered to a handful; typing a substring any time
    re-searches; typing an exact catalog id accepts it directly."""
    if not catalog:
        print(f"  live catalog unavailable — type a model id (e.g. {example})")
        return ask("model id", ask_nonempty("model id"))
    print(f"{label}: {len(catalog)} models — search by substring, pick by number")
    query = ""
    while True:
        if not query:
            query = input("search: ").strip()
            if not query:
                print("  ✗ type a substring (e.g. 'voyage') or Ctrl+C to abort")
                continue
        matches = [model for model in catalog if query.lower() in model.lower()]
        shown = matches[:10]
        if not shown:
            print(f"  ✗ no models match '{query}' — try a shorter substring")
            query = ""
            continue
        for index, model in enumerate(shown, 1):
            print(f"  {index}) {model}")
        if len(matches) > 10:
            print(f"  … and {len(matches) - 10} more — refine the search to narrow")
        pick = input(f"pick [1-{len(shown)}], or type a new search: ").strip()
        if pick.isdigit() and 1 <= int(pick) <= len(shown):
            return shown[int(pick) - 1]
        if pick in catalog:
            return pick
        query = pick  # empty = re-ask for a search; non-numeric = new search


def load_catalog(role: str, provider: str, base_url: str | None,
                 api_key: str | None) -> list[str] | None:
    url = catalog_url_for(provider, role, base_url)
    if url is None:
        return None
    catalog, reason = fetch_model_catalog(url, api_key)
    if catalog is None:
        info(f"{provider} catalog unavailable: {reason} — typing fallback")
        return None
    catalog = filter_catalog(provider, role, catalog)
    info(f"fetched {len(catalog)} {provider} models")
    return catalog


def ask_yes(prompt: str, default: bool) -> bool:
    suffix = " [Y/n]" if default else " [y/N]"
    raw = input(f"{prompt}{suffix}: ").strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes")


def ask_provider(label: str, role: str, goblin_providers: dict[str, str]) -> str:
    """Menu of role-compatible providers; ones goblin already uses are
    marked and the first is the Enter-accepting default — the registry is
    the operator's own record, not a guess."""
    options = tuple(p.name for p in providers_for(role))
    from_goblin = [p for p in options if p in goblin_providers]
    if not from_goblin:
        return ask_choice(label, options)
    default = from_goblin[0]
    print(label)
    for index, option in enumerate(options, 1):
        mark = "  (already in goblin)" if option in goblin_providers else ""
        print(f"  {index}) {option}{mark}")

    def check(value: str) -> str:
        if not value:
            return default
        if value.isdigit() and 1 <= int(value) <= len(options):
            return options[int(value) - 1]
        if value in options:
            return value
        raise ValueError(f"choose 1-{len(options)} or Enter for {default}")

    return ask(f"provider [default: {default}]", check)


def prompt_answers(goblin_home: Path) -> Answers:
    goblin_providers, problem = read_goblin_providers(goblin_home, REPO_ROOT)
    if problem is not None:
        info(f"{problem} — entering providers manually")
    elif goblin_providers:
        info("goblin already uses " + ", ".join(sorted(goblin_providers))
             + " — credentials come from its auth store")

    # Credentials belong to providers, not roles. Each must be a `!`
    # command record — the command becomes the container's secret lookup,
    # and the value is resolved once, in-process, for the catalog fetch.
    def credential_for(provider: str, env_name: str) -> tuple[SecretSpec, str | None]:
        auth_name = goblin_providers.get(provider)
        if auth_name is None:
            fail(f"{provider}: not in goblin's provider registry — the key must "
                 "live behind an auth-store `!` command before it can reach the "
                 f"container. Run: pass-keys add goblin-dev <NAME> Keys/<item>, "
                 f"then set providers.{provider}.auth in goblin.json5 and re-run")
        try:
            command = auth_command_for(goblin_home, auth_name)
        except ValueError as error:
            fail(f"{provider}: {error}")
        try:
            value = resolve_auth_key(goblin_home, auth_name)
        except ValueError as error:
            # The secret does not need the value — only the catalog does.
            # Keep going; free-text model entry covers an unlocked-later key.
            info(f"{provider}: key '{auth_name}' not resolvable now ({error}) "
                 "— model search falls back to free text")
            value = None
        info(f"{provider}: container resolves '{auth_name}' at every start "
             "(podman secret; value never touches a file)")
        return SecretSpec(env_name, secret_lookup(command)), value

    print("\n— Providers — credentials come from goblin's auth store, one per provider")
    llm_provider = ask_provider("extraction/consolidation LLM", "llm", goblin_providers)
    emb_provider = ask_provider("embeddings", "emb", goblin_providers)
    llm_base_url = PROVIDERS[llm_provider].llm_base_url \
        or ask_url("base URL", DEFAULT_OPENAI_BASE_URL)
    emb_base_url: str | None = None
    emb_secret: SecretSpec | None = None
    emb_value: str | None = None
    if emb_provider == "openai":
        emb_base_url = ask_url("base URL (OpenAI or compatible endpoint)",
                               DEFAULT_OPENAI_BASE_URL)
        if is_local_embeddings_endpoint(emb_base_url):
            info(f"local embeddings endpoint — the '{LOCAL_EMBED_KEY}' "
                 "sentinel is written; no credential needed")
        else:
            emb_secret, emb_value = credential_for(
                "openai", "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY")
    else:
        emb_secret, emb_value = credential_for(
            "openrouter", "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY")
    llm_secret, llm_value = credential_for(
        llm_provider, "HINDSIGHT_API_LLM_API_KEY")

    print("\n— LLM model —")
    catalog = load_catalog("llm", llm_provider, llm_base_url, llm_value)
    llm_model = ask_model_search("model", catalog, example_for(llm_provider, "llm"))

    print("\n— Embeddings model —")
    catalog = load_catalog("emb", emb_provider, emb_base_url, emb_value)
    emb_model = ask_model_search("model", catalog, example_for(emb_provider, "emb"))
    if embedding_prefixes(emb_model) is not None:
        info(f"{emb_model} is an asymmetric embedder — its task prefixes "
             "will be written into the env")

    # Not a question: this launch profile supports exactly one reranker.
    print("\n— Reranker: rrf (model-free; the only option this profile "
          "supports — no reranking model, no extra provider calls) —")
    return Answers(
        llm_provider=llm_provider,
        llm_model=llm_model,
        llm_base_url=llm_base_url,
        llm_secret=llm_secret,
        emb_provider=emb_provider,
        emb_model=emb_model,
        emb_secret=emb_secret,
        emb_base_url=emb_base_url,
        bank_id=DEFAULT_BANK_ID,
        bank_mission=DEFAULT_MISSION,
    )


def prompt_bank() -> tuple[str, str]:
    def check_bank(value: str) -> str:
        if not value:
            return DEFAULT_BANK_ID
        if not BANK_ID_PATTERN.fullmatch(value):
            raise ValueError("lowercase alphanumerics and dashes, 1-64 chars")
        return value
    bank_id = ask(f"bank id [default: {DEFAULT_BANK_ID}]", check_bank)
    print(f"  mission [default]: {DEFAULT_MISSION}")
    mission = input("mission (Enter = default): ").strip() or DEFAULT_MISSION
    return bank_id, mission


def print_summary(answers: Answers, bank_id: str) -> None:
    embeddings_endpoint = f" @ {answers.emb_base_url}" if answers.emb_base_url else ""
    prefix_line = ""
    if embedding_prefixes(answers.emb_model) is not None:
        prefix_line = ("  Prefixes:   model task prefixes "
                       f"({answers.emb_model.split(':', 1)[0]})\n")
    print(f"""
— Summary (secrets never shown) —
  LLM:        {answers.llm_provider} / {answers.llm_model} @ {answers.llm_base_url}
  Embeddings: {answers.emb_provider} / {answers.emb_model}{embeddings_endpoint}
{prefix_line}  Reranker:   rrf (model-free)
  Bank:       {bank_id}
  Secrets:    podman shell secrets {sorted(s.env_name for s in needed_secrets(answers))}
              (each stores a lookup command; pass-keys owns the values)
  Files:      {HINDSIGHT_ENV} (0600, no secrets — the pod has no DB password)
              {SYSTEMD_DIR}/goblin-memory-*""")


def api_boot_hook_present() -> bool:
    wants = run(["systemctl", "--user", "show", "-p", "Wants",
                 "--value", "default.target"])
    return API_UNIT in wants.stdout.split()


def manual_recovery_commands() -> list[str]:
    """The by-hand equivalent of install_assets + start_stack's enablement.

    Existing Quadlets are operator-owned. Repair their [Install] section,
    then reload so the generator creates the dependency; never hand-link
    a generated unit.
    """
    return [
        f"install -m 644 {MEMORY_DIR}/{WATCH_UNITS[0]} {MEMORY_DIR}/{WATCH_UNITS[1]} "
        f"{USER_UNIT_DIR}/",
        f"${{EDITOR:-vi}} {SYSTEMD_DIR}/goblin-memory-api.container "
        "# ensure [Install] / WantedBy=default.target",
        f"systemctl --user daemon-reload && "
        f"systemctl --user enable --now {WATCH_TIMER}",
    ]


def existing_install_status() -> str:
    """Print the installed stack's status. Returns the API unit's
    is-active state — main keys the watch-timer enablement off it."""
    info("existing installation detected:")
    print(f"  {'✓' if HINDSIGHT_ENV.is_file() else '✗'} {HINDSIGHT_ENV}")
    if POSTGRES_ENV.is_file():
        print(f"  ! {POSTGRES_ENV} — dead config from a pre-pod install; "
              "the database has no password now, delete this file")
    secrets = managed_secrets()
    print(f"  podman secrets: {', '.join(sorted(secrets)) or 'none registered'}")
    api_state = "unknown"
    for unit in (DB_UNIT, API_UNIT):
        result = probe(["systemctl", "--user", "is-active", unit])
        state = ((result.stdout if result else None) or "unknown").strip()
        if unit == API_UNIT:
            api_state = state
        print(f"  {unit}: {state}")
    # A dangling or self-referential symlink is not boot activation.
    boot_hook = api_boot_hook_present()
    print(f"  boot hook (default.target Wants={API_UNIT}): "
          f"{'✓ present' if boot_hook else '✗ MISSING — stack will not survive a reboot'}")
    if not boot_hook:
        print("  manual recovery:")
        for command in manual_recovery_commands():
            print(f"    {command}")
    watch = probe(["systemctl", "--user", "is-active", WATCH_TIMER])
    watch_state = ((watch.stdout if watch else None) or "unknown").strip()
    print(f"  {WATCH_TIMER}: {watch_state}")
    if http_ok(HEALTH_URL):
        print(f"  API: healthy at {MEMORY_API_URL}")
    print("  to change models/keys:  uv run python deploy/memory/install.py --reconfigure")
    return api_state


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-start", action="store_true",
                        help="write config and install assets; do not start or enable "
                             "(enablement rides the confirmed first start)")
    parser.add_argument("--reconfigure", action="store_true",
                        help="re-prompt LLM/embeddings and rewrite hindsight.env "
                             "(keeps database, volume, bank, goblin config; "
                             "pod-era installs only — a postgres.env install "
                             "needs migration per docs/memory.md)")
    parser.add_argument("--resume", action="store_true",
                        help="finish a partial install whose config already "
                             "exists: start the stack, create the bank, wire goblin")
    parser.add_argument("--goblin-home", type=Path,
                        default=Path(os.environ.get("GOBLIN_HOME", str(Path.home() / "goblin"))))
    args = parser.parse_args(argv)
    if args.reconfigure and args.no_start:
        parser.error("--reconfigure restarts the API by design; --no-start contradicts it")
    if args.resume and (args.reconfigure or args.no_start):
        parser.error("--resume finishes a partial install by starting the stack; "
                     "--reconfigure and --no-start contradict it")

    print("Goblin memory stack installer — Hindsight 1.0.0-slim + PostgreSQL 17")
    preflight()
    # A present-but-invalid embed-relay switch fails here, before any
    # prompt, env write or unit copy in ANY branch below — the refusal
    # must leave zero durable state behind.
    validate_embed_relay_config(CFG_DIR)

    if args.reconfigure:
        # Check BEFORE prompting: walking providers and then failing on a
        # missing file is hostile. A pre-pod install (no registered
        # secrets, env files carrying credentials) is not reconfigurable —
        # it needs the migration path, not a config rewrite.
        if not HINDSIGHT_ENV.is_file() or not managed_secrets():
            fail("--reconfigure needs a pod-era install (hindsight.env plus "
                 "registered podman secrets); migrate per docs/memory.md "
                 "→ Migration, then re-run")
        assert_compatible_install()
        answers = prompt_answers(args.goblin_home)
        try:
            env = build_hindsight_env(answers)
        except ValueError as error:
            fail(f"launch guard rejected the configuration: {error}")

        # The rewrite replaces the API's live configuration. Keep the
        # previous file, quadlet block and secret registrations so a
        # failed restart or health check puts the working stack back
        # instead of exiting with the new — possibly broken — config live.
        previous_text: str | None = None
        previous_mode = 0o600
        if HINDSIGHT_ENV.is_file():
            previous_text = HINDSIGHT_ENV.read_text()
            previous_mode = HINDSIGHT_ENV.stat().st_mode & 0o777
        quadlet_path = SYSTEMD_DIR / "goblin-memory-api.container"
        previous_quadlet = quadlet_path.read_text() if quadlet_path.is_file() else None
        previous_quadlet_mode = (quadlet_path.stat().st_mode & 0o777
                                 if quadlet_path.is_file() else 0o644)
        previous_secrets = managed_secrets()

        def rollback(reason: str) -> NoReturn:
            if previous_quadlet is not None:
                write_file_atomic(quadlet_path, previous_quadlet,
                                  previous_quadlet_mode)
            if previous_text is None:
                # No config existed before this run (half-install
                # recovery): back to clean is the honest state.
                HINDSIGHT_ENV.unlink(missing_ok=True)
                fail(f"{reason}; removed the new hindsight.env — no previous "
                     "configuration existed to restore")
            write_file_atomic(HINDSIGHT_ENV, previous_text, previous_mode)
            try:
                restore_secrets(previous_secrets)
            except (Exception, SystemExit, KeyboardInterrupt):
                fail(f"{reason}; restored the previous hindsight.env and "
                     "Quadlet but secret restoration failed — the API was "
                     "not restarted onto an incomplete rollback; "
                     f"journalctl --user -u {API_UNIT}")
            reload = probe(["systemctl", "--user", "daemon-reload"])
            if reload is None or reload.returncode != 0:
                fail(f"{reason}; restored the previous hindsight.env and "
                     "Quadlet but the rollback daemon-reload failed — the "
                     "API was not restarted against an unverified unit set; "
                     f"journalctl --user -u {API_UNIT}")
            restart = probe(["systemctl", "--user", "restart", API_UNIT])
            recovered = (restart is not None and restart.returncode == 0
                         and api_healthy(120))
            suffix = "and verified the API is healthy again" if recovered else \
                f"but the API did NOT recover — journalctl --user -u {API_UNIT}"
            fail(f"{reason}; restored the previous hindsight.env {suffix}")

        # The new env may use keys an older installed guard rejects. Land
        # the compatible guard before changing config; keep it on rollback
        # because it also accepts the previous env's launch profile.
        start_dst = CFG_DIR / "start.py"
        failed_stage: str | None = None
        try:
            stage = "installed launch guard"
            write_file_atomic(start_dst, (MEMORY_DIR / "start.py").read_text(), 0o644)
            info(f"installed {start_dst}")

            # A reconfigure that adopts local embeddings needs the relay live
            # BEFORE the API restarts on the new env — it test-embeds during
            # init and refuses to boot on a dead endpoint. refresh_assets
            # below runs after the restart, too late; land the units here.
            stage = "embed relay units"
            install_embed_units(MEMORY_DIR, CFG_DIR, USER_UNIT_DIR)
            enable_embed_relay(CFG_DIR)
            stage = "hindsight.env rewrite"
            write_file_atomic(HINDSIGHT_ENV, render_env_file(env), 0o600)
            stage = "API Quadlet secret block"
            apply_secret_block(quadlet_path,
                               [s.env_name for s in needed_secrets(answers)])
            stage = "systemd daemon-reload"
            run(["systemctl", "--user", "daemon-reload"])
            stage = "podman secret registration"
            for spec in needed_secrets(answers):
                ensure_secret(spec)
            info(f"rewrote {HINDSIGHT_ENV}; restarting API")
            stage = "API restart"
            restart = probe(["systemctl", "--user", "restart", API_UNIT])
            if restart is None or restart.returncode != 0:
                output = ("systemctl probe failed" if restart is None
                          else (restart.stderr or "").strip()[:500])
                fail(f"API restart command failed ({output})")
            stage = "API health check"
            if not api_healthy(120):
                fail("API not healthy after restart")
        except (Exception, SystemExit, KeyboardInterrupt) as error:
            if isinstance(error, OSError):
                detail = (f"{type(error).__name__}: "
                          f"{os.strerror(error.errno) if error.errno is not None else 'unknown'}")
            else:
                detail = type(error).__name__
            failed_stage = f"reconfigure {stage} failed ({detail})"
        if failed_stage is not None:
            rollback(failed_stage)
        # The stack is confirmed live on the new config — prune secrets a
        # provider switch orphaned, then the same asset refresh a fresh
        # install gets so a reconfigure on an older box picks up the
        # watch units. (--no-start is rejected above.)
        prune_secrets({s.env_name for s in needed_secrets(answers)})
        refresh_assets(enable_watch=True)
        info("done — bank and goblin config unchanged")
        return

    if args.resume:
        # A first install that died after writing env files left every
        # rerun on the status path — bank creation and goblin wiring
        # unreachable without hand-deleting 0600 files. Resume finishes
        # exactly that tail; each step is idempotent.
        if not HINDSIGHT_ENV.is_file():
            fail(f"--resume needs the config a partial install left "
                 f"({HINDSIGHT_ENV}); run without flags for a fresh install")
        if not managed_secrets():
            # Same crash window the plain rerun converges: finish the
            # secret registration BEFORE starting, or the API's first
            # start fails on its never-created secret mounts.
            complete_half_install(args.goblin_home)
        bank_id, mission = prompt_bank()
        state = probe(["systemctl", "--user", "is-active", API_UNIT])
        if ((state.stdout if state else "") or "").strip() != "active":
            pre_pull_images()
            start_stack()
        else:
            info("stack already running — finishing bank and goblin wiring")
        create_bank(bank_id, mission)
        report_wiring(wire_goblin(args.goblin_home, bank_id))
        return

    if HINDSIGHT_ENV.is_file():
        if not managed_secrets():
            # A complete pod-era install always has its secrets
            # registered (the LLM key is unconditional), so this state
            # is the fresh path's crash window: converge it instead of
            # dead-ending on the status path.
            complete_half_install(args.goblin_home)
        api_state = existing_install_status()
        # install_assets is fresh-install-only otherwise: a re-run on an
        # existing box never picked up the watch units. Idempotent copy
        # + reload; the timer goes live only while the stack is actually
        # used (a stopped stack is a deliberate operator choice — see
        # the watch unit) and --no-start keeps enablement off.
        refresh_assets(enable_watch=api_state == "active" and not args.no_start)
        if api_state != "active" and not args.no_start:
            print("  stack is not running — if the first install never "
                  "finished, rerun with --resume to start it and complete "
                  "bank creation / goblin wiring")
        return

    # A stray postgres.env means a pre-pod install's dead file survived —
    # it carries a password nothing reads anymore. Warn, don't refuse:
    # fresh installs past that era legitimately have neither file.
    if POSTGRES_ENV.is_file():
        info(f"{POSTGRES_ENV} is dead config from a pre-pod install — the "
             "database has no password now; delete it after this run")

    answers = prompt_answers(args.goblin_home)
    bank_id, mission = prompt_bank()
    print_summary(answers, bank_id)
    if not ask_yes("write config and install assets?", default=False):
        fail("aborted before writing anything")

    try:
        env = build_hindsight_env(answers)
    except ValueError as error:
        fail(f"launch guard rejected the configuration: {error}")
    write_file_atomic(HINDSIGHT_ENV, render_env_file(env), 0o600)
    installed = install_assets(MEMORY_DIR, SYSTEMD_DIR, CFG_DIR, USER_UNIT_DIR)
    for path in installed:
        info(f"installed {path}")
    # The shipped quadlet carries the marker region; fill it for this
    # provider set and register the shell secrets BEFORE the first start
    # — podman resolves the lookup at container create.
    apply_secret_block(SYSTEMD_DIR / "goblin-memory-api.container",
                       [s.env_name for s in needed_secrets(answers)])
    sync_secrets(needed_secrets(answers))

    if args.no_start:
        print("\nAssets installed, stack NOT started (and NOT enabled at boot —\n"
              "enablement happens with the first confirmed start). To finish later:\n"
              "  uv run python deploy/memory/install.py --resume\n"
              "Or start manually (then create the bank and wire goblin per docs/memory.md):")
        for command in deferred_start_commands(CFG_DIR):
            print(f"  {command}")
        return

    print("\nStarting can call the embedding provider (dimension detection) "
          "and resume persisted background work — it is not free.")
    if not ask_yes("start the stack now?", default=False):
        print("Stack not started. Assets and config are in place; finish later with:\n"
              "  uv run python deploy/memory/install.py --resume\n"
              "Or start manually (then create the bank and wire goblin per docs/memory.md):")
        for command in deferred_start_commands(CFG_DIR):
            print(f"  {command}")
        return

    pre_pull_images()
    start_stack()
    create_bank(bank_id, mission)
    report_wiring(wire_goblin(args.goblin_home, bank_id))


def cli() -> None:
    try:
        main()
    except KeyboardInterrupt:
        # Prompts happen before any write and writes are atomic. An
        # interrupt between the hindsight.env write and the first secret
        # registration leaves the env with zero registered secrets —
        # the next run (plain or --resume) detects that and completes
        # the install. A later partial (config written, stack never
        # started) is finished by --resume.
        print("\ninstall: interrupted — safe to rerun; existing files are "
              "detected and kept", file=sys.stderr)
        sys.exit(130)  # 128 + SIGINT, the convention shells understand
    except EOFError:
        print("\ninstall: input ended (Ctrl+D) — aborting; rerun to continue",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
