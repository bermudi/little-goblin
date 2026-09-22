"""Interactive installer for the Goblin memory stack (Hindsight + PostgreSQL).

One command; every decision is prompted, never assumed:

- database password: generated with secrets.token_urlsafe (URL-safe by
  construction), written to a 0600 env file, never printed
- provider API keys: hidden input, written straight to the 0600 env file,
  never echoed, logged, or passed through command lines
- model choices: typed by the operator (examples shown, never defaults);
  provider endpoints have structural defaults (zai/openrouter are fixed
  upstream; openai prompts) and empty input accepts the shown default
  anything is written — an invalid answer cannot produce a config the
  container would reject
- starting the stack requires an explicit confirmation: first start can
  call the embedding provider (dimension detection) and costs money

Fail loud: every step reports what it is doing and aborts with context on
the first failure. Idempotent for assets; refuses to touch existing env
files unless --reconfigure (a new database password would NOT rotate an
existing role — see docs/memory.md).

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

from start import validate, validate_endpoint

MEMORY_DIR = Path(__file__).resolve().parent
CFG_DIR = Path.home() / ".config" / "goblin-memory"
SYSTEMD_DIR = Path.home() / ".config" / "containers" / "systemd"
POSTGRES_ENV = CFG_DIR / "postgres.env"
HINDSIGHT_ENV = CFG_DIR / "hindsight.env"
MEMORY_API_URL = "http://127.0.0.1:8888"
HEALTH_URL = MEMORY_API_URL + "/health/ready"
API_UNIT = "goblin-memory-api.service"
DB_UNIT = "goblin-memory-db.service"
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
LLM_PROVIDERS = ("zai", "openai", "openrouter")
EMBEDDING_PROVIDERS = ("openrouter", "openai")
# Fixed upstream endpoints for these providers; empty = operator must type one.
LLM_ENDPOINT_HINTS: dict[str, str] = {
    "zai": "https://api.z.ai/api/paas/v4",
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
}
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


def install_assets(memory_dir: Path, systemd_dir: Path, cfg_dir: Path) -> list[Path]:
    systemd_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cfg_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    installed: list[Path] = []
    for pattern in ("*.container", "*.network", "*.volume"):
        for src in sorted(memory_dir.glob(pattern)):
            dst = systemd_dir / src.name
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
            return
        time.sleep(5)
    fail(f"{API_UNIT} not ready after 480s — journalctl --user -u {API_UNIT}; "
         "first-run migrations can exceed systemd's TimeoutStartSec=300: "
         "raise it deliberately in the installed Quadlet and re-run install")


def http_ok(url: str) -> bool:
    try:
        with urlrequest.urlopen(url, timeout=5) as response:
            return bool(response.status == 200)
    except (urlerror.URLError, OSError):
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
    menu = "\n".join(f"  {i}) {option}" for i, option in enumerate(options, 1))
    def check(value: str) -> str:
        if value.isdigit() and 1 <= int(value) <= len(options):
            return options[int(value) - 1]
        if value in options:
            return value
        raise ValueError(f"choose 1-{len(options)}")
    return ask(f"{prompt}\n{menu}", check)


def ask_url(prompt: str, hint: str, required: bool) -> str:
    def check(value: str) -> str:
        if not value and hint and not required:
            return hint
        if not value:
            raise ValueError("endpoint URL is required")
        validate_endpoint("(input)", value)
        return value
    suffix = "" if required else f" [default: {hint}]"
    return ask(f"{prompt}{suffix}", check)


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


def prompt_answers() -> Answers:
    print("\n— Extraction/consolidation LLM —")
    llm_provider = ask_choice("provider", LLM_PROVIDERS)
    example = "glm-5.3-flash" if llm_provider == "zai" else "operator-chosen model id"
    llm_model = ask(f"model id (example only, not a default: {example})",
                    ask_nonempty("model id"))
    llm_base_url = ask_url(
        "base URL", LLM_ENDPOINT_HINTS[llm_provider],
        required=llm_provider == "openai")
    llm_api_key = ask_secret("API key")

    print("\n— Embeddings —")
    emb_provider = ask_choice("provider", EMBEDDING_PROVIDERS)
    emb_example = ("voyageai/voyage-4-lite" if emb_provider == "openrouter"
                   else "operator-chosen embedding model id")
    emb_model = ask(f"model id (example only, not a default: {emb_example})",
                    ask_nonempty("model id"))
    emb_api_key = ask_secret("API key")
    emb_base_url: str | None = None
    if emb_provider == "openai":
        emb_base_url = ask_url("base URL (OpenAI or compatible endpoint)",
                               "https://api.openai.com/v1", required=True)

    print("\n— Reranker —")
    print("  Only the model-free 'rrf' option is supported by this launch "
          "profile: no cross-encoder download, no reranking provider call, "
          "slightly weaker recall ordering than a learned reranker.")
    if not ask_yes("use rrf?", default=True):
        fail("no alternative is supported; see docs/memory.md (BYO deployment)")
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
                        help="write config and install assets, do not start")
    parser.add_argument("--reconfigure", action="store_true",
                        help="re-prompt LLM/embeddings and rewrite hindsight.env "
                             "(keeps database, volume, bank, goblin config)")
    parser.add_argument("--goblin-home", type=Path,
                        default=Path(os.environ.get("GOBLIN_HOME", str(Path.home() / "goblin"))))
    args = parser.parse_args(argv)

    print("Goblin memory stack installer — Hindsight 0.10.0-slim + PostgreSQL 17")
    preflight()

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
        answers = prompt_answers()
        try:
            db_password = parse_postgres_env(POSTGRES_ENV.read_text())["POSTGRES_PASSWORD"]
        except (OSError, ValueError) as error:
            fail(f"cannot reuse database password: {error}")
        try:
            env = build_hindsight_env(answers, db_password)
        except ValueError as error:
            fail(f"launch guard rejected the configuration: {error}")
        write_file_atomic(HINDSIGHT_ENV, render_env_file(env), 0o600)
        info(f"rewrote {HINDSIGHT_ENV}; restarting API")
        run(["systemctl", "--user", "restart", API_UNIT])
        time.sleep(10)
        if not http_ok(HEALTH_URL):
            fail(f"API not healthy after restart — journalctl --user -u {API_UNIT}")
        info("done — bank and goblin config unchanged")
        return

    if HINDSIGHT_ENV.is_file():
        existing_install_status()
        return

    answers = prompt_answers()
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
    installed = install_assets(MEMORY_DIR, SYSTEMD_DIR, CFG_DIR)
    for path in installed:
        info(f"installed {path}")

    if args.no_start:
        print("\nAssets installed, stack NOT started. To start later:\n"
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


if __name__ == "__main__":
    main()
