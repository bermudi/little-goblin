"""Interactive installer for the Goblin memory stack (Hindsight + PostgreSQL).

One command. goblin's own registry is the source of truth: providers it
already uses are proposed as defaults, and their keys are resolved from
its auth store (in-process, never printed). Only genuinely-new providers
prompt for a key (hidden input). Keys belong to providers, not roles —
one key serves both Hindsight roles.

- database password: generated with secrets.token_urlsafe (URL-safe by
  construction), written to a 0600 env file, never printed
- model selection: search the provider's LIVE /models catalog with the
  key just resolved — substring in, short numbered list out, exact ids
  accepted; if the catalog is unreachable the reason is shown (a 401 is
  a key/endpoint mismatch worth knowing) and selection falls back to
  free text with a verified example
- endpoints fixed by the provider are derived silently; openai
  (compatible endpoints exist) asks, with its standard endpoint as the
  default
- the assembled config is validated by the launch guard (start.validate)
  BEFORE anything is written — an invalid answer cannot produce a config
  the container would reject
- starting the stack requires an explicit confirmation: first start can
  call the embedding provider (dimension detection) and costs money

Fail loud: every step reports what it is doing and aborts with context on
the first failure. Idempotent for assets; refuses to touch existing env
files unless --reconfigure (a new database password would NOT rotate an
existing role — see docs/memory.md). Provider knowledge lives in
providers.py; this file is the flow.

Usage: uv run python deploy/memory/install.py [--no-start] [--reconfigure]
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import secrets
import time
from typing import Callable, NoReturn
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import quote

from providers import (
    DEFAULT_OPENAI_BASE_URL,
    PROVIDERS,
    catalog_url_for,
    example_for,
    fetch_model_catalog,
    filter_catalog,
    providers_for,
    read_goblin_providers,
    resolve_auth_key,
)
from start import validate, validate_endpoint

MEMORY_DIR = Path(__file__).resolve().parent
REPO_ROOT = MEMORY_DIR.parent.parent
CFG_DIR = Path.home() / ".config" / "goblin-memory"
SYSTEMD_DIR = Path.home() / ".config" / "containers" / "systemd"
USER_UNIT_DIR = Path.home() / ".config" / "systemd" / "user"
POSTGRES_ENV = CFG_DIR / "postgres.env"
HINDSIGHT_ENV = CFG_DIR / "hindsight.env"
MEMORY_API_URL = "http://127.0.0.1:8888"
HEALTH_URL = MEMORY_API_URL + "/health/ready"
API_UNIT = "goblin-memory-api.service"
DB_UNIT = "goblin-memory-db.service"
WATCH_UNITS = ("goblin-memory-watch.service", "goblin-memory-watch.timer")
WATCH_TIMER = "goblin-memory-watch.timer"
GOBLIN_UNIT = "goblin.service"
# Digest-pinned, matching the Quadlet assets. Pre-pulled so systemd's
# TimeoutStartSec budget is spent on migrations, not downloads.
DB_IMAGE = (
    "docker.io/pgvector/pgvector:0.8.2-pg17-bookworm"
    "@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966"
)
API_IMAGE = (
    "ghcr.io/vectorize-io/hindsight-api:0.10.0-slim"
    "@sha256:bc3082ccb514fee1a7f7d66da308ba2c2018e2ea2c739d2341c993e3a3bd91b9"
)
BANK_ID_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
DEFAULT_BANK_ID = "goblin"
DEFAULT_MISSION = (
    "Remember the operator's preferences, decisions, commitments, people, "
    "and ongoing work. Assistant suggestions are not operator decisions. "
    "Date every fact."
)


@dataclass(frozen=True)
class Answers:
    llm_provider: str
    llm_model: str
    llm_base_url: str
    llm_api_key: str
    emb_provider: str
    emb_model: str
    emb_api_key: str
    emb_base_url: str | None  # required for (and only for) openai embeddings
    bank_id: str
    bank_mission: str


def fail(message: str) -> NoReturn:
    print(f"\ninstall: {message}", file=sys.stderr)
    sys.exit(1)


def info(message: str) -> None:
    print(f"install: {message}")


# --------------------------------------------------------------------------
# Pure config assembly — unit-tested, no I/O
# --------------------------------------------------------------------------


def build_database_uri(db_password: str) -> str:
    # token_urlsafe output never needs encoding, but quote() keeps this
    # correct for any operator-supplied password during --reconfigure reuse.
    return "postgresql://hindsight:" + quote(db_password, safe="") + "@db:5432/hindsight"


def build_hindsight_env(answers: Answers, db_password: str) -> dict[str, str]:
    prefix = f"HINDSIGHT_API_EMBEDDINGS_{answers.emb_provider.upper()}"
    env = {
        "HINDSIGHT_API_DATABASE_URL": build_database_uri(db_password),
        "HINDSIGHT_API_LLM_PROVIDER": answers.llm_provider,
        "HINDSIGHT_API_LLM_BASE_URL": answers.llm_base_url,
        "HINDSIGHT_API_LLM_MODEL": answers.llm_model,
        "HINDSIGHT_API_LLM_API_KEY": answers.llm_api_key,
        "HINDSIGHT_API_EMBEDDINGS_PROVIDER": answers.emb_provider,
        "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
        f"{prefix}_MODEL": answers.emb_model,
        f"{prefix}_API_KEY": answers.emb_api_key,
    }
    if answers.emb_provider == "openai":
        env[f"{prefix}_BASE_URL"] = answers.emb_base_url or ""
    for key, value in env.items():
        if "\n" in value or "\r" in value:
            raise ValueError(f"{key}: line breaks are not representable in env files")
    # The launch guard is the single source of truth for a valid config.
    # Raises ValueError before anything is written to disk.
    validate(env)
    return env


def render_env_file(env: dict[str, str]) -> str:
    order = [
        "HINDSIGHT_API_DATABASE_URL",
        "HINDSIGHT_API_LLM_PROVIDER",
        "HINDSIGHT_API_LLM_BASE_URL",
        "HINDSIGHT_API_LLM_MODEL",
        "HINDSIGHT_API_LLM_API_KEY",
        "HINDSIGHT_API_EMBEDDINGS_PROVIDER",
        "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL",
        "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY",
        "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
        "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
        "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL",
        "HINDSIGHT_API_RERANKER_PROVIDER",
    ]
    lines = [f"{key}={env[key]}" for key in order if key in env]
    unexpected = set(env) - set(order)
    if unexpected:
        raise ValueError(f"unexpected keys: {sorted(unexpected)}")
    return "\n".join(lines) + "\n"


def render_postgres_env(db_password: str) -> str:
    return f"POSTGRES_PASSWORD={db_password}\n"


def parse_postgres_env(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise ValueError("postgres.env: line without '='")
        key = key.strip()
        if key in result:
            raise ValueError(f"postgres.env: duplicate key {key}")
        result[key] = value
    if "POSTGRES_PASSWORD" not in result:
        raise ValueError("postgres.env: POSTGRES_PASSWORD missing")
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


def install_assets(memory_dir: Path, systemd_dir: Path, cfg_dir: Path,
                    user_unit_dir: Path) -> list[Path]:
    systemd_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cfg_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    user_unit_dir.mkdir(parents=True, exist_ok=True)
    installed: list[Path] = []
    for pattern in ("*.container", "*.network", "*.volume"):
        for src in sorted(memory_dir.glob(pattern)):
            dst = systemd_dir / src.name
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
    start_dst = cfg_dir / "start.py"
    shutil.copyfile(memory_dir / "start.py", start_dst)
    start_dst.chmod(0o644)
    installed.append(start_dst)
    return installed


# --------------------------------------------------------------------------
# System steps — logged, fail loud
# --------------------------------------------------------------------------


def run(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
    info("$ " + " ".join(command))
    try:
        proc = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        fail(f"command timed out after {timeout}s: {' '.join(command)}")
    if proc.returncode != 0:
        output = (proc.stderr.strip() or proc.stdout.strip())[:2000]
        fail(f"command failed ({proc.returncode}): {' '.join(command)}\n{output}")
    return proc


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
    run(["systemctl", "--user", "enable", API_UNIT])
    info(f"{API_UNIT} enabled — starts on boot (linger keeps the user manager alive)")
    # The watch units landed after the earlier daemon-reload; load them,
    # then start the timer now. It turns an unhealthy-but-alive container
    # into a unit restart (Restart=on-failure only sees process death).
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "--now", WATCH_TIMER])
    info(f"{WATCH_TIMER} enabled — health checked every 5 minutes")


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
            return
        detail = error.read().decode(errors="replace")[:500]
        fail(f"bank creation failed (HTTP {error.code}): {detail}")
    except OSError as error:
        fail(f"bank creation failed: {error}")


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


def wire_goblin(goblin_home: Path, bank_id: str) -> bool:
    """Patch goblin.json5 and restart goblin. Returns True only when the
    memory block is live. Any failure rolls the config back and verifies
    the rollback — never leave the operator's bot dead or patched-but-down.
    """
    config = goblin_home / "goblin.json5"
    snippet = build_goblin_memory_snippet(bank_id)
    if not config.is_file():
        info(f"{config} not found — add this block yourself:")
        print(snippet)
        return False
    text = config.read_text()
    try:
        updated = insert_json5_property(text, snippet, "memory")
    except ValueError as error:
        info(f"goblin.json5 not patched: {error} — add this block yourself:")
        print(snippet)
        return False
    mode = config.stat().st_mode & 0o777
    backup = config.with_name(config.name + ".pre-memory")
    write_file_atomic(backup, text, mode)
    write_file_atomic(config, updated, mode)
    info(f"memory block added to {config} (backup: {backup.name})")
    if not ask_yes("restart goblin now so memory goes live?", default=True):
        return False

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
    return True


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
                 api_key: str) -> list[str] | None:
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


def ask_secret(prompt: str) -> str:
    while True:
        value = getpass.getpass(f"{prompt} (hidden): ").strip()
        if value:
            return value
        print("  ✗ empty value; try again")


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
             + " — keys will be reused from its auth store")

    # Keys belong to providers, not roles: resolved once (auth store
    # first, hidden input otherwise) and shared by both Hindsight roles.
    keys: dict[str, str] = {}

    def key_for(provider: str) -> str:
        if provider in keys:
            return keys[provider]
        auth_name = goblin_providers.get(provider)
        if auth_name is not None:
            try:
                keys[provider] = resolve_auth_key(goblin_home, auth_name)
                info(f"{provider}: reusing goblin's stored key '{auth_name}'")
                return keys[provider]
            except ValueError as error:
                info(f"{provider}: stored key unusable ({error}) — enter it now")
        keys[provider] = ask_secret("API key")
        return keys[provider]

    print("\n— Providers — one key per provider; Hindsight's two roles draw from them")
    llm_provider = ask_provider("extraction/consolidation LLM", "llm", goblin_providers)
    emb_provider = ask_provider("embeddings", "emb", goblin_providers)
    llm_base_url = PROVIDERS[llm_provider].llm_base_url \
        or ask_url("base URL", DEFAULT_OPENAI_BASE_URL)
    emb_base_url: str | None = None
    if emb_provider == "openai":
        emb_base_url = ask_url("base URL (OpenAI or compatible endpoint)",
                               DEFAULT_OPENAI_BASE_URL)
    llm_api_key = key_for(llm_provider)
    emb_api_key = key_for(emb_provider)

    print("\n— LLM model —")
    catalog = load_catalog("llm", llm_provider, llm_base_url, llm_api_key)
    llm_model = ask_model_search("model", catalog, example_for(llm_provider, "llm"))

    print("\n— Embeddings model —")
    catalog = load_catalog("emb", emb_provider, emb_base_url, emb_api_key)
    emb_model = ask_model_search("model", catalog, example_for(emb_provider, "emb"))

    # Not a question: this launch profile supports exactly one reranker.
    print("\n— Reranker: rrf (model-free; the only option this profile "
          "supports — no reranking model, no extra provider calls) —")
    return Answers(
        llm_provider=llm_provider,
        llm_model=llm_model,
        llm_base_url=llm_base_url,
        llm_api_key=llm_api_key,
        emb_provider=emb_provider,
        emb_model=emb_model,
        emb_api_key=emb_api_key,
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
    print(f"""
— Summary (secrets never shown) —
  LLM:        {answers.llm_provider} / {answers.llm_model} @ {answers.llm_base_url}
  Embeddings: {answers.emb_provider} / {answers.emb_model}{embeddings_endpoint}
  Reranker:   rrf (model-free)
  Bank:       {bank_id}
  Files:      {POSTGRES_ENV} (generated password)
              {HINDSIGHT_ENV} (0600, contains your API keys)
              {SYSTEMD_DIR}/goblin-memory-*""")


def existing_install_status() -> None:
    info("existing installation detected:")
    for path in (POSTGRES_ENV, HINDSIGHT_ENV):
        print(f"  {'✓' if path.is_file() else '✗'} {path}")
    for unit in (DB_UNIT, API_UNIT):
        result = probe(["systemctl", "--user", "is-active", unit])
        state = (result.stdout if result else None) or "unknown"
        print(f"  {unit}: {state}")
    if http_ok(HEALTH_URL):
        print(f"  API: healthy at {MEMORY_API_URL}")
    print("  to change models/keys:  uv run python deploy/memory/install.py --reconfigure")


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
                             "(keeps database, volume, bank, goblin config)")
    parser.add_argument("--goblin-home", type=Path,
                        default=Path(os.environ.get("GOBLIN_HOME", str(Path.home() / "goblin"))))
    args = parser.parse_args(argv)
    if args.reconfigure and args.no_start:
        parser.error("--reconfigure restarts the API by design; --no-start contradicts it")

    print("Goblin memory stack installer — Hindsight 0.10.0-slim + PostgreSQL 17")
    preflight()

    if args.reconfigure:
        # Check BEFORE prompting: collecting two hidden keys and then
        # failing on a missing file is hostile.
        if not POSTGRES_ENV.is_file():
            fail(f"--reconfigure needs {POSTGRES_ENV}; run a fresh install instead")
        answers = prompt_answers(args.goblin_home)
        try:
            db_password = parse_postgres_env(POSTGRES_ENV.read_text())["POSTGRES_PASSWORD"]
        except (OSError, ValueError) as error:
            fail(f"cannot reuse database password: {error}")
        try:
            env = build_hindsight_env(answers, db_password)
        except ValueError as error:
            fail(f"launch guard rejected the configuration: {error}")

        # The rewrite replaces the API's live configuration. Keep the
        # previous file (and its mode) so a failed restart or health
        # check can put the working stack back instead of exiting with
        # the new — possibly broken — env left installed.
        previous_text: str | None = None
        previous_mode = 0o600
        if HINDSIGHT_ENV.is_file():
            previous_text = HINDSIGHT_ENV.read_text()
            previous_mode = HINDSIGHT_ENV.stat().st_mode & 0o777

        def rollback(reason: str) -> NoReturn:
            text = previous_text
            if text is None:
                # No config existed before this run (half-install
                # recovery): back to clean is the honest state.
                HINDSIGHT_ENV.unlink(missing_ok=True)
                fail(f"{reason}; removed the new hindsight.env — no previous "
                     "configuration existed to restore")
            write_file_atomic(HINDSIGHT_ENV, text, previous_mode)
            restart = probe(["systemctl", "--user", "restart", API_UNIT])
            recovered = (restart is not None and restart.returncode == 0
                         and api_healthy(120))
            suffix = "and verified the API is healthy again" if recovered else \
                f"but the API did NOT recover — journalctl --user -u {API_UNIT}"
            fail(f"{reason}; restored the previous hindsight.env {suffix}")

        write_file_atomic(HINDSIGHT_ENV, render_env_file(env), 0o600)
        info(f"rewrote {HINDSIGHT_ENV}; restarting API")
        restart = probe(["systemctl", "--user", "restart", API_UNIT])
        if restart is None or restart.returncode != 0:
            output = ("systemctl probe failed" if restart is None
                      else (restart.stderr or "").strip()[:500])
            rollback(f"API restart command failed ({output})")
        if not api_healthy(120):
            rollback("API not healthy after restart")
        info("done — bank and goblin config unchanged")
        return

    if HINDSIGHT_ENV.is_file():
        existing_install_status()
        return

    answers = prompt_answers(args.goblin_home)
    bank_id, mission = prompt_bank()
    print_summary(answers, bank_id)
    if not ask_yes("write config and install assets?", default=False):
        fail("aborted before writing anything")

    # Regenerating the password would silently desync PostgreSQL auth on
    # an initialized volume (a new password never rotates the role); if
    # hindsight.env was removed but this file survived, the stack exists.
    if POSTGRES_ENV.is_file():
        fail(f"{POSTGRES_ENV} already exists — refusing to regenerate the "
             "database password; run with --reconfigure to change models/keys")
    db_password = secrets.token_urlsafe(24)
    try:
        env = build_hindsight_env(answers, db_password)
    except ValueError as error:
        fail(f"launch guard rejected the configuration: {error}")
    write_file_atomic(POSTGRES_ENV, render_postgres_env(db_password), 0o600)
    write_file_atomic(HINDSIGHT_ENV, render_env_file(env), 0o600)
    installed = install_assets(MEMORY_DIR, SYSTEMD_DIR, CFG_DIR, USER_UNIT_DIR)
    for path in installed:
        info(f"installed {path}")

    if args.no_start:
        print("\nAssets installed, stack NOT started (and NOT enabled at boot —\n"
              "enablement happens with the first confirmed start). To start later:\n"
              "  systemctl --user daemon-reload\n"
              f"  systemctl --user start {API_UNIT}\n"
              "Then create the bank and wire goblin per docs/memory.md.")
        return

    print("\nStarting can call the embedding provider (dimension detection) "
          "and resume persisted background work — it is not free.")
    if not ask_yes("start the stack now?", default=False):
        print("Stack not started. Assets and config are in place; start with:\n"
              f"  systemctl --user daemon-reload && systemctl --user start {API_UNIT}")
        return

    pre_pull_images()
    start_stack()
    create_bank(bank_id, mission)
    wired = wire_goblin(args.goblin_home, bank_id)
    if wired:
        print("\nDone. Memory is live. In Telegram: /memory")
    else:
        print("\nStack and bank are live, but goblin was not wired — "
              "add the memory block printed above, then: "
              "systemctl --user restart goblin.service")


def cli() -> None:
    try:
        main()
    except KeyboardInterrupt:
        # Prompts happen before any write and writes are atomic, so an
        # interrupt can only leave CLEAN state: no file, or complete
        # files. A half-install (postgres.env without hindsight.env) is
        # detected on rerun and pointed at --reconfigure.
        print("\ninstall: interrupted — safe to rerun; existing files are "
              "detected and kept", file=sys.stderr)
        sys.exit(130)  # 128 + SIGINT, the convention shells understand
    except EOFError:
        print("\ninstall: input ended (Ctrl+D) — aborting; rerun to continue",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
