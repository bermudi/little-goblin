"""Offline installer checks: synthetic values only; no network, no containers."""
import contextlib
from email.message import Message
import io
import json
import shlex
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from urllib.parse import urlsplit
import urllib.request as urlrequest

import install
from install import (
    Answers,
    build_database_uri,
    build_goblin_memory_snippet,
    build_hindsight_env,
    insert_json5_property,
    install_assets,
    parse_postgres_env,
    render_env_file,
    write_file_atomic,
)
from start import validate

SYNTHETIC_KEY = "synthetic-secret"
BOOT_QUERY = ["systemctl", "--user", "show", "-p", "Wants", "--value", "default.target"]


def synthetic_answers(
    llm_model: str = "operator-llm",
    llm_base_url: str = "https://example.invalid/v1",
    emb_provider: str = "openrouter",
    emb_base_url: str | None = None,
    emb_model: str = "operator-embedding",
) -> Answers:
    return Answers(
        llm_provider="zai",
        llm_model=llm_model,
        llm_base_url=llm_base_url,
        llm_api_key=SYNTHETIC_KEY,
        emb_provider=emb_provider,
        emb_model=emb_model,
        emb_api_key=SYNTHETIC_KEY,
        emb_base_url=emb_base_url,
        bank_id="goblin",
        bank_mission="synthetic mission",
    )


class BuildEnvTest(unittest.TestCase):
    def test_passes_launch_guard(self) -> None:
        env = build_hindsight_env(synthetic_answers(), "synthetic-password")
        validate(env)

    def test_openai_embeddings_require_base_url(self) -> None:
        answers = synthetic_answers(
            emb_provider="openai",
            emb_base_url="https://embed.example.invalid/v1",
        )
        env = build_hindsight_env(answers, "synthetic-password")
        self.assertEqual(env["HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL"],
                         "https://embed.example.invalid/v1")
        self.assertNotIn("HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL", env)
        with self.assertRaises(ValueError):
            build_hindsight_env(
                synthetic_answers(emb_provider="openai", emb_base_url=None),
                "synthetic-password",
            )

    def test_task_prefixes_written_for_prefix_models(self) -> None:
        answers = synthetic_answers(
            emb_provider="openai",
            emb_base_url="http://100.64.0.1:11435/v1",
            emb_model="embeddinggemma:latest")
        env = build_hindsight_env(answers, "synthetic-password")
        # Trailing spaces are significant to the embedder — assert them.
        self.assertEqual(env["HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX"],
                         "task: search result | query: ")
        self.assertEqual(env["HINDSIGHT_API_EMBEDDINGS_PASSAGE_PREFIX"],
                         "title: none | text: ")
        validate(env)

    def test_no_prefix_keys_for_unlisted_models(self) -> None:
        env = build_hindsight_env(synthetic_answers(), "synthetic-password")
        self.assertNotIn("HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX", env)
        self.assertNotIn("HINDSIGHT_API_EMBEDDINGS_PASSAGE_PREFIX", env)

    def test_newline_in_value_rejected_before_guard(self) -> None:
        with self.assertRaises(ValueError):
            build_hindsight_env(
                synthetic_answers(llm_model="bad\nmodel"), "synthetic-password")

    def test_invalid_url_rejected_by_guard(self) -> None:
        with self.assertRaises(ValueError):
            build_hindsight_env(
                synthetic_answers(llm_base_url="not a url"), "synthetic-password")

    def test_database_uri_roundtrip(self) -> None:
        # token_urlsafe output is a subset of URI-safe chars, but quote()
        # must keep hostile operator passwords representable.
        for password in ("plain", "p@ss:word/with?weird#chars", "synthetic-password"):
            uri = build_database_uri(password)
            parsed = urlsplit(uri)
            self.assertEqual(parsed.scheme, "postgresql")
            self.assertEqual(parsed.hostname, "db")
            self.assertEqual(parsed.port, 5432)
            self.assertEqual(parsed.username, "hindsight")
            self.assertEqual(parsed.path, "/hindsight")
            from urllib.parse import unquote
            self.assertEqual(unquote(parsed.password or ""), password)


class RenderEnvTest(unittest.TestCase):
    def test_exact_lines_and_only_chosen_provider(self) -> None:
        env = build_hindsight_env(synthetic_answers(), "synthetic-password")
        text = render_env_file(env)
        lines = text.splitlines()
        self.assertEqual(lines[0], "HINDSIGHT_API_DATABASE_URL=" + env["HINDSIGHT_API_DATABASE_URL"])
        self.assertIn("HINDSIGHT_API_LLM_MODEL=operator-llm", lines)
        self.assertIn("HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL=operator-embedding", lines)
        self.assertIn("HINDSIGHT_API_RERANKER_PROVIDER=rrf", lines)
        self.assertNotIn("OPENAI_MODEL", text)
        self.assertTrue(text.endswith("\n"))
        for line in lines:
            key, sep, _ = line.partition("=")
            self.assertTrue(sep, "literal KEY=value, no export/quotes")

    def test_prefix_line_keeps_significant_trailing_space(self) -> None:
        env = build_hindsight_env(
            synthetic_answers(emb_provider="openai",
                              emb_base_url="http://100.64.0.1:11435/v1",
                              emb_model="embeddinggemma"),
            "synthetic-password")
        lines = render_env_file(env).splitlines()
        self.assertIn(
            "HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX=task: search result | query: ",
            lines)
        self.assertIn(
            "HINDSIGHT_API_EMBEDDINGS_PASSAGE_PREFIX=title: none | text: ",
            lines)

    def test_unexpected_key_rejected(self) -> None:
        with self.assertRaises(ValueError):
            render_env_file({"HINDSIGHT_API_BOGUS": "x"})

    def test_postgres_env_roundtrip(self) -> None:
        text = install.render_postgres_env("synthetic-password")
        self.assertEqual(text, "POSTGRES_PASSWORD=synthetic-password\n")
        self.assertEqual(parse_postgres_env(text)["POSTGRES_PASSWORD"],
                         "synthetic-password")
        with self.assertRaises(ValueError):
            parse_postgres_env("POSTGRES_USER=x\n")
        self.assertEqual(
            parse_postgres_env("# comment\nPOSTGRES_PASSWORD=p\n")["POSTGRES_PASSWORD"], "p")

    def test_duplicate_keys_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_postgres_env(
                "POSTGRES_PASSWORD=a\nPOSTGRES_PASSWORD=b\n")


class AskSecretCharsetTest(unittest.TestCase):
    def test_real_key_shapes_render_verbatim(self) -> None:
        for value in ("sk-ant-api03-abc123DEF", "gsk_9x8y7z",
                      "AIzaSyD-123_456", "eyJhbGciOi.eyJzdWIi.s==",
                      "abc+def/ghi~jkl:mno=pqr"):
            self.assertTrue(install.UNQUOTED_ENV_VALUE.fullmatch(value), value)

    def test_env_breaking_values_are_rejected(self) -> None:
        # Quotes, whitespace, backslashes and friends change how the
        # KEY= line parses under systemd — ask_secret rejects them at
        # input instead of storing a silently different credential.
        for value in ('"sk-123', "sk 123", "sk\\123", "sk#123", "sk'123",
                      "sk;rm", "sk,123", "sk$123"):
            self.assertIsNone(install.UNQUOTED_ENV_VALUE.fullmatch(value), value)


class EmbedRelayEnvTest(unittest.TestCase):
    VALID = ("GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n"
             "GOBLIN_EMBED_MODEL=embeddinggemma\n")

    def test_valid_roundtrip_skips_comments(self) -> None:
        parsed = install.parse_embed_relay_env("# opt-in\n\n" + self.VALID)
        self.assertEqual(parsed["GOBLIN_EMBED_RELAY_ADDR"], "100.64.0.1")
        self.assertEqual(parsed["GOBLIN_EMBED_MODEL"], "embeddinggemma")

    def test_bad_ipv4_rejected_without_echoing_value(self) -> None:
        with self.assertRaises(ValueError) as raised:
            install.parse_embed_relay_env(
                "GOBLIN_EMBED_RELAY_ADDR=not-an-address\n"
                "GOBLIN_EMBED_MODEL=m\n")
        self.assertEqual(
            str(raised.exception),
            "embed-relay.env: GOBLIN_EMBED_RELAY_ADDR is not an IPv4 address",
        )
        self.assertNotIn("not-an-address", str(raised.exception))

    def test_unspecified_ipv4_rejected_without_echoing_value(self) -> None:
        with self.assertRaises(ValueError) as raised:
            install.parse_embed_relay_env(
                "GOBLIN_EMBED_RELAY_ADDR=0.0.0.0\n"
                "GOBLIN_EMBED_MODEL=m\n")
        self.assertIn("GOBLIN_EMBED_RELAY_ADDR", str(raised.exception))
        self.assertNotIn("0.0.0.0", str(raised.exception))

    def test_specific_addresses_do_not_require_cgnat_range(self) -> None:
        for address in ("127.0.0.1", "192.168.1.2", "10.0.0.2"):
            with self.subTest(address=address):
                parsed = install.parse_embed_relay_env(
                    f"GOBLIN_EMBED_RELAY_ADDR={address}\nGOBLIN_EMBED_MODEL=m\n")
                self.assertEqual(parsed["GOBLIN_EMBED_RELAY_ADDR"], address)

    def test_missing_keys_rejected(self) -> None:
        with self.assertRaises(ValueError):
            install.parse_embed_relay_env("GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n")
        with self.assertRaises(ValueError):
            install.parse_embed_relay_env("GOBLIN_EMBED_MODEL=m\n")

    def test_duplicate_and_whitespace_rejected(self) -> None:
        with self.assertRaises(ValueError):
            install.parse_embed_relay_env(
                "GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n"
                "GOBLIN_EMBED_RELAY_ADDR=100.64.0.2\n"
                "GOBLIN_EMBED_MODEL=m\n")
        with self.assertRaises(ValueError):
            install.parse_embed_relay_env(
                "GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n"
                "GOBLIN_EMBED_MODEL=bad model\n")

    def test_model_charset_rejects_systemd_lexers(self) -> None:
        # % and $ are live inside the pin unit's ExecStart -d payload;
        # quotes and backslashes break the unquoted env line itself.
        for model in ("a%b", "a$b", 'a"b', "a\\b", "a;rm", "a b"):
            with self.subTest(model=model):
                with self.assertRaises(ValueError):
                    install.parse_embed_relay_env(
                        "GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n"
                        f"GOBLIN_EMBED_MODEL={model}\n")

    def test_model_id_shapes_pass(self) -> None:
        # Real ollama ids: bare names, tags, namespaced hf.co refs.
        for model in ("embeddinggemma", "llama3.2:3b", "hf.co/ns/model:tag"):
            with self.subTest(model=model):
                parsed = install.parse_embed_relay_env(
                    "GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n"
                    f"GOBLIN_EMBED_MODEL={model}\n")
                self.assertEqual(parsed["GOBLIN_EMBED_MODEL"], model)


class PromptAnswersKeyReuseTest(unittest.TestCase):
    """A resolved auth-store value that can't render verbatim in an env
    file must fall back to the prompted path — the same charset gate
    pasted keys pass, or the boot mangles it into a misleading 401."""

    STUBBED = ("read_goblin_providers", "resolve_auth_key", "ask_provider",
               "ask_url", "ask_secret", "load_catalog", "ask_model_search")

    def setUp(self) -> None:
        self.saved = {name: getattr(install, name) for name in self.STUBBED}
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        for name, value in self.saved.items():
            setattr(install, name, value)

    def run_flow(self, resolved: str) -> tuple[object, list[str]]:
        install.read_goblin_providers = (
            lambda goblin_home, repo_root: ({"zai": "ZAI_KEY"}, None))
        install.resolve_auth_key = lambda goblin_home, name: resolved
        install.ask_provider = lambda *args: "zai"
        install.ask_url = lambda *args: "https://api.z.ai/v4"
        prompted: list[str] = []
        install.ask_secret = lambda prompt: (
            prompted.append(prompt), "sk-good")[1]
        install.load_catalog = lambda *args: None
        install.ask_model_search = lambda *args: "m"
        with contextlib.redirect_stdout(io.StringIO()):
            answers = install.prompt_answers(Path("/nowhere"))
        return answers, prompted

    def test_unrenderable_stored_key_falls_back_to_prompt(self) -> None:
        answers, prompted = self.run_flow("sk bad")
        self.assertEqual(prompted, ["API key"])
        self.assertEqual(answers.llm_api_key, "sk-good")

    def test_renderable_stored_key_reused_without_prompt(self) -> None:
        answers, prompted = self.run_flow("sk-good")
        self.assertEqual(prompted, [])
        self.assertEqual(answers.llm_api_key, "sk-good")


class SecretFileTest(unittest.TestCase):
    def test_mode_600_and_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secrets.env"
            write_file_atomic(path, "K=v\n", 0o600)
            self.assertEqual(path.read_text(), "K=v\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertFalse(list(path.parent.glob(".secrets.env.*.tmp")),
                             "tmp file must not survive")

    def test_overwrite_keeps_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secrets.env"
            write_file_atomic(path, "K=old\n", 0o600)
            write_file_atomic(path, "K=new\n", 0o600)
            self.assertEqual(path.read_text(), "K=new\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class InstallAssetsTest(unittest.TestCase):
    def seed_memory_dir(self, root: Path, with_embed: bool = True) -> Path:
        memory_dir = root / "src"
        memory_dir.mkdir()
        (memory_dir / "goblin-memory-api.container").write_text("[Container]\n")
        (memory_dir / "goblin-memory.network").write_text("[Network]\n")
        (memory_dir / "start.py").write_text("x = 1\n")
        (memory_dir / "healthcheck.py").write_text("x = 1\n")
        units = list(install.WATCH_UNITS)
        if with_embed:
            units += install.EMBED_UNITS
        for name in units:
            (memory_dir / name).write_text("[Unit]\n")
        return memory_dir

    def test_embed_units_absent_without_switch_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = self.seed_memory_dir(root)
            user_unit_dir = root / "user-units"
            installed = install_assets(memory_dir, root / "systemd",
                                       root / "cfg", user_unit_dir)
            for name in install.EMBED_UNITS:
                self.assertFalse((user_unit_dir / name).exists())
            self.assertFalse(
                any(path.name in install.EMBED_UNITS for path in installed))

    def test_embed_units_installed_with_valid_switch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = self.seed_memory_dir(root)
            cfg_dir = root / "cfg"
            cfg_dir.mkdir()
            (cfg_dir / "embed-relay.env").write_text(EmbedRelayEnvTest.VALID)
            user_unit_dir = root / "user-units"
            installed = install_assets(memory_dir, root / "systemd",
                                       cfg_dir, user_unit_dir)
            for name in install.EMBED_UNITS:
                dst = user_unit_dir / name
                self.assertTrue(dst.is_file(), name)
                self.assertEqual(stat.S_IMODE(dst.stat().st_mode), 0o644)
                self.assertIn(dst, installed)

    def test_invalid_switch_fails_before_copying_embed_units(self) -> None:
        bad_files = (
            "GOBLIN_EMBED_RELAY_ADDR=not-an-ip\nGOBLIN_EMBED_MODEL=m\n",
            "GOBLIN_EMBED_RELAY_ADDR=0.0.0.0\nGOBLIN_EMBED_MODEL=m\n",
            "GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n",
            "GOBLIN_EMBED_RELAY_ADDR=100.64.0.1\n"
            "GOBLIN_EMBED_RELAY_ADDR=100.64.0.2\nGOBLIN_EMBED_MODEL=m\n",
        )
        for bad in bad_files:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                memory_dir = self.seed_memory_dir(root)
                cfg_dir = root / "cfg"
                cfg_dir.mkdir()
                (cfg_dir / "embed-relay.env").write_text(bad)
                user_unit_dir = root / "user-units"
                with self.assertRaises(SystemExit):
                    install_assets(memory_dir, root / "systemd",
                                   cfg_dir, user_unit_dir)
                for name in install.EMBED_UNITS:
                    self.assertFalse((user_unit_dir / name).exists(), name)

    def test_copies_quadlet_guard_and_watch_with_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "src"
            systemd_dir = Path(tmp) / "systemd"
            cfg_dir = Path(tmp) / "cfg"
            user_unit_dir = Path(tmp) / "user-units"
            memory_dir.mkdir()
            (memory_dir / "goblin-memory-api.container").write_text("[Container]\n")
            (memory_dir / "goblin-memory.network").write_text("[Network]\n")
            (memory_dir / "start.py").write_text("x = 1\n")
            (memory_dir / "healthcheck.py").write_text("x = 1\n")
            for name in install.WATCH_UNITS:
                (memory_dir / name).write_text("[Unit]\n")
            installed = install_assets(memory_dir, systemd_dir, cfg_dir, user_unit_dir)
            names = {p.name for p in installed}
            self.assertEqual(names, {"goblin-memory-api.container",
                                     "goblin-memory.network", "start.py",
                                     "healthcheck.py",
                                     *install.WATCH_UNITS})
            for path in installed:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(systemd_dir.stat().st_mode), 0o700)
            # Watch units are plain user units, not Quadlet assets — they
            # must land in the systemd user dir where timers can be enabled.
            self.assertTrue((user_unit_dir / "goblin-memory-watch.timer").is_file())

    def test_refresh_keeps_operator_edited_quadlets(self) -> None:
        # Review finding: refresh_assets re-copied shipped Quadlets over
        # installed ones — destroying exactly the TimeoutStartSec edit
        # the health-gate failure message tells the operator to make.
        # A refresh must deliver new assets without touching files
        # already at the destination.
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "src"
            systemd_dir = Path(tmp) / "systemd"
            cfg_dir = Path(tmp) / "cfg"
            user_unit_dir = Path(tmp) / "user-units"
            memory_dir.mkdir()
            (memory_dir / "goblin-memory-api.container").write_text("[Container]\n")
            (memory_dir / "goblin-memory.network").write_text("[Network]\n")
            (memory_dir / "start.py").write_text("x = 1\n")
            (memory_dir / "healthcheck.py").write_text("x = 1\n")
            for name in install.WATCH_UNITS:
                (memory_dir / name).write_text("[Unit]\n")
            systemd_dir.mkdir()
            edited = systemd_dir / "goblin-memory-api.container"
            edited.write_text("[Container]\nTimeoutStartSec=900\n")
            with contextlib.redirect_stdout(io.StringIO()) as out:
                installed = install_assets(memory_dir, systemd_dir, cfg_dir,
                                           user_unit_dir,
                                           skip_existing_quadlets=True)
            self.assertIn("TimeoutStartSec=900", edited.read_text())
            self.assertNotIn(edited, installed)
            self.assertIn("not overwritten", out.getvalue())
            names = {p.name for p in installed}
            self.assertEqual(names, {"goblin-memory.network", "start.py",
                                     "healthcheck.py",
                                     *install.WATCH_UNITS})
            # Fresh-install overwrite semantics stay: without the skip
            # flag the shipped file wins, so deleting a Quadlet before a
            # reinstall remains the reset path.
            install_assets(memory_dir, systemd_dir, cfg_dir, user_unit_dir)
            self.assertEqual(edited.read_text(), "[Container]\n")

    def test_missing_watch_asset_fails_loud(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "src"
            memory_dir.mkdir()
            (memory_dir / "goblin-memory-api.container").write_text("[Container]\n")
            with self.assertRaises(SystemExit):
                install_assets(memory_dir, Path(tmp) / "systemd",
                               Path(tmp) / "cfg", Path(tmp) / "user-units")

    def test_missing_start_or_healthcheck_asset_fails_loud(self) -> None:
        # A broken checkout must fail with the named asset, not a raw
        # FileNotFoundError traceback — same contract as the watch units.
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "src"
            systemd_dir = Path(tmp) / "systemd"
            cfg_dir = Path(tmp) / "cfg"
            user_unit_dir = Path(tmp) / "user-units"
            memory_dir.mkdir()
            (memory_dir / "goblin-memory-api.container").write_text("[Container]\n")
            (memory_dir / "goblin-memory.network").write_text("[Network]\n")
            for name in install.WATCH_UNITS:
                (memory_dir / name).write_text("[Unit]\n")
            # start.py missing: nothing may land in cfg.
            (memory_dir / "healthcheck.py").write_text("x = 1\n")
            with self.assertRaises(SystemExit):
                install_assets(memory_dir, systemd_dir, cfg_dir, user_unit_dir)
            self.assertFalse((cfg_dir / "healthcheck.py").exists())
            # healthcheck.py missing: start.py copies first and stays.
            (memory_dir / "start.py").write_text("x = 1\n")
            (memory_dir / "healthcheck.py").unlink()
            with self.assertRaises(SystemExit):
                install_assets(memory_dir, systemd_dir, cfg_dir, user_unit_dir)
            self.assertTrue((cfg_dir / "start.py").is_file())

    def test_manual_recovery_commands_are_actionable(self) -> None:
        commands = install.manual_recovery_commands()
        self.assertEqual(len(commands), 3)
        for name in install.WATCH_UNITS:
            self.assertIn(name, commands[0])
        self.assertIn(str(install.USER_UNIT_DIR), commands[0])
        self.assertIn("goblin-memory-api.container", commands[1])
        self.assertIn("[Install]", commands[1])
        self.assertIn("WantedBy=default.target", commands[1])
        self.assertNotIn("ln -s", "\n".join(commands))
        self.assertIn("daemon-reload", commands[2])
        self.assertIn(install.WATCH_TIMER, commands[2])


class BootActivationTest(unittest.TestCase):
    def test_loaded_wants_requires_exact_unit_name(self) -> None:
        for output, expected in (
            (f"other.service {install.API_UNIT}\n", True),
            (f"{install.API_UNIT}.extra\n", False),
            ("", False),
        ):
            with self.subTest(output=output):
                result = subprocess.CompletedProcess(["systemctl"], 0, output, "")
                with patch("install.subprocess.run", return_value=result):
                    self.assertEqual(install.api_boot_hook_present(), expected)

    def test_unreadable_wants_fails_loudly(self) -> None:
        result = subprocess.CompletedProcess(["systemctl"], 1, "", "synthetic failure")
        with patch("install.subprocess.run", return_value=result):
            with self.assertRaises(SystemExit):
                install.api_boot_hook_present()

    def test_self_referential_link_is_not_reported_as_boot_activation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            user_units = Path(tmp) / "user-units"
            wants = user_units / "default.target.wants"
            wants.mkdir(parents=True)
            (wants / install.API_UNIT).symlink_to(install.API_UNIT)
            result = subprocess.CompletedProcess(["systemctl"], 0, "", "")
            with (
                patch.object(install, "USER_UNIT_DIR", user_units),
                patch("install.subprocess.run", return_value=result),
                patch("install.urlrequest.urlopen", side_effect=urllib.error.URLError("offline")),
                contextlib.redirect_stdout(io.StringIO()) as output,
            ):
                install.existing_install_status()
            self.assertIn("MISSING", output.getvalue())
            self.assertNotIn("✓ present", output.getvalue())

    def test_real_quadlet_generator_creates_resolvable_boot_link(self) -> None:
        candidates = (
            Path("/usr/lib/systemd/system-generators/podman-system-generator"),
            Path("/usr/libexec/podman/quadlet"),
        )
        generator = next((path for path in candidates if path.is_file()), None)
        if generator is None:
            self.skipTest("Quadlet generator not installed")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            generated = root / "generated"
            source.mkdir()
            generated.mkdir()
            # Exercise the shipped activation declaration with no containers
            # or credentials: the real generator only writes unit files.
            (source / "goblin-memory-api.container").write_text(
                (install.MEMORY_DIR / "goblin-memory-api.container").read_text())
            (source / "goblin-memory.network").write_text(
                (install.MEMORY_DIR / "goblin-memory.network").read_text())
            result = subprocess.run(
                [str(generator), "--user", str(generated)],
                env={**os.environ, "QUADLET_UNIT_DIRS": str(source)},
                text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            link = generated / "default.target.wants" / install.API_UNIT
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(strict=True), generated / install.API_UNIT)


class CreateBankTest(unittest.TestCase):
    """Bank creation must seed retain_mission, not just the generic
    mission — extraction reads retain_mission and Goblin never calls
    reflect(). urlopen is faked at the module edge; no network."""

    class _Resp:
        status = 200

        def __init__(self, body: bytes = b"") -> None:
            self._body = body

        def __enter__(self) -> "CreateBankTest._Resp":
            return self

        def __exit__(self, *exc: object) -> None:
            pass

        def read(self) -> bytes:
            return self._body

    def setUp(self) -> None:
        self.calls: list[tuple[str, str, object]] = []
        urlopen_patch = patch.object(urlrequest, "urlopen", self.fake)
        urlopen_patch.start()
        self.addCleanup(urlopen_patch.stop)

    def fake(self, request: urlrequest.Request, timeout: int = 0) -> "CreateBankTest._Resp":
        assert isinstance(request.data, bytes)
        self.calls.append((request.get_method(), request.full_url,
                           json.loads(request.data)))
        return self._Resp()

    def test_creates_and_patches_retain_mission(self) -> None:
        install.create_bank("goblin", "synthetic mission")
        self.assertEqual(
            self.calls,
            [
                ("PUT", f"{install.MEMORY_API_URL}/v1/default/banks/goblin",
                 {"mission": "synthetic mission"}),
                ("PATCH", f"{install.MEMORY_API_URL}/v1/default/banks/goblin/config",
                 {"updates": {
                     "retain_mission": "synthetic mission",
                     "observations_mission": install.DEFAULT_OBSERVATIONS_MISSION,
                 }}),
            ],
        )

    def fake_409(
        self, config: dict[str, object],
    ) -> contextlib.AbstractContextManager[object]:
        body = json.dumps(
            {"bank_id": "goblin", "config": config, "overrides": {}}).encode()

        def fake(request: urlrequest.Request, timeout: int = 0) -> "CreateBankTest._Resp":
            self.calls.append((request.get_method(), request.full_url, None))
            if request.get_method() == "PUT":
                raise urllib.error.HTTPError(
                    request.full_url, 409, "conflict", Message(), None)
            return self._Resp(body)

        return patch.object(urlrequest, "urlopen", fake)

    def test_existing_bank_never_patched(self) -> None:
        # PUT 409 → a GET to check drift, and nothing else — never a PATCH.
        with self.fake_409({
            "retain_mission": "synthetic mission",
            "observations_mission": install.DEFAULT_OBSERVATIONS_MISSION,
        }):
            install.create_bank("goblin", "synthetic mission")
        self.assertEqual(
            self.calls,
            [
                ("PUT", f"{install.MEMORY_API_URL}/v1/default/banks/goblin", None),
                ("GET", f"{install.MEMORY_API_URL}/v1/default/banks/goblin/config", None),
            ],
        )

    def test_drifted_existing_bank_warns_with_field_and_repair_line(self) -> None:
        stderr = io.StringIO()
        with self.fake_409({
            "retain_mission": "a drifted mission",
            "observations_mission": install.DEFAULT_OBSERVATIONS_MISSION,
        }), contextlib.redirect_stderr(stderr):
            install.create_bank("goblin", "the operator's mission")
        out = stderr.getvalue()
        self.assertIn("WARNING", out)
        self.assertIn("retain_mission", out)
        # The repair line must survive a paste into a shell even though
        # the canonical missions carry apostrophes.
        curl = next(line for line in out.splitlines() if "curl" in line)
        argv = shlex.split(curl)
        self.assertEqual(argv[argv.index("-X") + 1], "PATCH")
        body = json.loads(argv[argv.index("-d") + 1])
        self.assertEqual(body["updates"]["retain_mission"], "the operator's mission")

    def test_matching_existing_bank_warns_nothing(self) -> None:
        stderr = io.StringIO()
        with self.fake_409({
            "retain_mission": "synthetic mission",
            "observations_mission": install.DEFAULT_OBSERVATIONS_MISSION,
        }), contextlib.redirect_stderr(stderr):
            install.create_bank("goblin", "synthetic mission")
        self.assertNotIn("WARNING", stderr.getvalue())


class GoblinSnippetTest(unittest.TestCase):
    def test_snippet_shape(self) -> None:
        snippet = build_goblin_memory_snippet("goblin")
        self.assertIn("baseUrl: 'http://127.0.0.1:8888'", snippet)
        self.assertIn("bankId: 'goblin'", snippet)
        self.assertNotIn("auth", snippet)  # loopback needs none

    def test_bank_id_charset_enforced(self) -> None:
        with self.assertRaises(ValueError):
            build_goblin_memory_snippet("Bad Bank!")


class InsertJson5Test(unittest.TestCase):
    STRICT = '{\n  "model": "x",\n  "logLevel": "debug"\n}\n'
    JSON5 = """// goblin config
{
  model: 'provider/model',
  logLevel: 'debug', // trailing comment
}
"""

    def test_insert_strict_json(self) -> None:
        updated = insert_json5_property(self.STRICT, "  memory: {}", "memory")
        self.assertIn('"logLevel": "debug",\n  memory: {}', updated)
        self.assertTrue(updated.endswith("}\n"))

    def test_insert_json5_preserves_comments_and_trailing_comma(self) -> None:
        updated = insert_json5_property(self.JSON5, "  memory: {\n    bankId: 'goblin',\n  }", "memory")
        self.assertIn("// goblin config", updated)
        self.assertIn("logLevel: 'debug', // trailing comment", updated)
        # Comma precedes the comment, so the property is terminated: the
        # snippet follows with NO new separator (adding one would be
        # swallowed by the comment — see the corruption tests below).
        self.assertIn("// trailing comment\n  memory: {", updated)

    def test_no_double_comma_when_last_property_has_trailing_comma(self) -> None:
        updated = insert_json5_property("{\n  a: 1,\n}\n", "  memory: {}", "memory")
        self.assertNotIn(",,", updated)
        self.assertEqual(updated, "{\n  a: 1,\n  memory: {}\n}\n")

    def test_comment_after_unterminated_value_refused(self) -> None:
        # Proven corruption shape (review B1): no comma before the
        # comment — an appended separator lands inside the comment and
        # the output is invalid JSON5. Refusal is the contract.
        with self.assertRaises(ValueError):
            insert_json5_property(
                "{\n  logLevel: 'debug' // debug | info | warn\n}\n",
                "  memory: {}", "memory")

    def test_own_line_comment_after_unterminated_value_refused(self) -> None:
        with self.assertRaises(ValueError):
            insert_json5_property(
                "{\n  a: 1\n  // note\n}\n", "  memory: {}", "memory")

    def test_url_string_in_last_line_does_not_false_positive(self) -> None:
        # 'https://' inside a quoted string is not a comment; insertion
        # must succeed (over-refusal here would force manual edits on the
        # most common real-world shape).
        config = "{\n  publicUrl: 'https://x.ts.net:8788/'\n}\n"
        updated = insert_json5_property(config, "  memory: {}", "memory")
        self.assertIn("/',\n  memory: {}\n}\n", updated)

    def test_inline_duplicate_key_detected(self) -> None:
        # One-line configs: the line-start regex alone misses these and
        # json5 is last-wins — a silent replace. The inline pattern must
        # catch them.
        with self.assertRaises(ValueError):
            insert_json5_property("{ a: 1, memory: {}, b: 2 }", "  memory: {}", "memory")

    def test_existing_key_rejected(self) -> None:
        with self.assertRaises(ValueError):
            insert_json5_property(self.STRICT, "  x: 1", "model")

    def test_empty_object(self) -> None:
        updated = insert_json5_property("{\n}\n", "  memory: {}", "memory")
        self.assertEqual(updated, "{\n  memory: {}\n}\n")

    def test_real_world_shape_end_to_end(self) -> None:
        # The actual live config shape (unquoted keys, nested object last).
        live = """{
  providers: { zai: { baseUrl: 'https://api.example/v4' } },
  http: {
    port: 8788,
  },
  logLevel: 'debug',
}
"""
        snippet = build_goblin_memory_snippet("goblin")
        updated = insert_json5_property(live, snippet, "memory")
        self.assertIn("logLevel: 'debug',\n  memory: {\n", updated)
        self.assertIn("bankId: 'goblin',\n  }\n}\n", updated)


class PreflightTest(unittest.TestCase):
    """The 8888 bind check: a re-run finds its own API container holding
    the port — an info line, not the 'already in use' WARNING. The socket
    module is faked as a refused bind; the rest of preflight's checks are
    stubbed green so the bind branch is what runs."""

    class _RefusedSocket:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> "PreflightTest._RefusedSocket":
            return self

        def __exit__(self, *exc: object) -> None:
            pass

        def bind(self, addr: object) -> None:
            raise OSError("address already in use")

    class _SocketModule:
        AF_INET = 2
        SOCK_STREAM = 1

        @staticmethod
        def socket(*args: object) -> "PreflightTest._RefusedSocket":
            return PreflightTest._RefusedSocket()

    def run_preflight(self, probe_stdout: str) -> str:
        install.probe = lambda command: subprocess.CompletedProcess(
            command, 0, probe_stdout, "")
        stderr = io.StringIO()
        patchers: list[contextlib.AbstractContextManager[object]] = [
            patch.object(install.os, "geteuid", lambda: 1000),
            patch.object(install.shutil, "which", lambda cmd: "/usr/bin/podman"),
            patch.object(install, "run",
                         lambda command: subprocess.CompletedProcess(command, 0, "", "")),
            patch.object(install.getpass, "getuser", lambda: "tester"),
            patch.object(Path, "read_text",
                         lambda self, *a, **k: "tester:100000:65536\n"),
            patch.object(install, "socket", self._SocketModule),
            contextlib.redirect_stderr(stderr),
        ]
        with contextlib.ExitStack() as stack:
            for patcher in patchers:
                stack.enter_context(patcher)
            install.preflight()
        return stderr.getvalue()

    def setUp(self) -> None:
        self.real_probe = install.probe
        self.addCleanup(setattr, install, "probe", self.real_probe)

    def test_port_held_by_own_api_container_is_info_not_warning(self) -> None:
        stderr = self.run_preflight("true\n")
        self.assertNotIn("WARNING", stderr)

    def test_port_held_by_something_else_still_warns(self) -> None:
        stderr = self.run_preflight("false\n")
        self.assertIn("WARNING", stderr)
        self.assertIn("8888", stderr)


FAKED = ("preflight", "prompt_answers", "prompt_bank", "ask_yes", "run",
         "http_ok", "probe", "goblin_stable", "create_bank", "wire_goblin",
         "time", "CFG_DIR", "SYSTEMD_DIR",
         "POSTGRES_ENV", "HINDSIGHT_ENV", "main")


class AskModelSearchTest(unittest.TestCase):
    CATALOG = ["openai/gpt-5.3", "voyageai/voyage-4", "voyageai/voyage-4-lite",
               "zai/glm-5.3", "zai/glm-5.3-flash"]

    def run_inputs(self, inputs: list[str], catalog: list[str] | None) -> tuple[str | None, str]:
        import builtins
        feed = iter(inputs)
        original_input = builtins.input

        def fake_input(prompt: object = "") -> str:
            return next(feed)

        builtins.input = fake_input
        try:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                result = install.ask_model_search("model", catalog, "example-model")
        except StopIteration:
            return None, "ran out of inputs"
        finally:
            builtins.input = original_input
        return result, output.getvalue()

    def test_search_then_pick(self) -> None:
        result, output = self.run_inputs(["voyage", "1"], self.CATALOG)
        self.assertEqual(result, "voyageai/voyage-4")
        self.assertIn("1) voyageai/voyage-4\n", output)
        self.assertIn("2) voyageai/voyage-4-lite\n", output)

    def test_typed_pick_becomes_new_search(self) -> None:
        result, output = self.run_inputs(["glm", "voyage-4-lite", "1"], self.CATALOG)
        self.assertEqual(result, "voyageai/voyage-4-lite")
        self.assertIn("1) zai/glm-5.3\n", output)

    def test_exact_catalog_id_at_pick_accepted(self) -> None:
        result, _ = self.run_inputs(["glm", "zai/glm-5.3-flash"], self.CATALOG)
        self.assertEqual(result, "zai/glm-5.3-flash")

    def test_no_match_reprompts(self) -> None:
        result, output = self.run_inputs(["zzzz", "voyage", "2"], self.CATALOG)
        self.assertEqual(result, "voyageai/voyage-4-lite")
        self.assertIn("no models match 'zzzz'", output)

    def test_no_catalog_is_free_text(self) -> None:
        result, output = self.run_inputs(["typed-model"], None)
        self.assertEqual(result, "typed-model")
        self.assertIn("e.g. example-model", output)

    def test_long_match_lists_truncated(self) -> None:
        catalog = [f"vendor/model-{i}" for i in range(25)]
        result, output = self.run_inputs(["model", "1"], catalog)
        self.assertEqual(result, "vendor/model-0")
        self.assertIn("and 15 more", output)


class AskChoiceTest(unittest.TestCase):
    def test_menu_and_prompt_on_separate_lines(self) -> None:
        import builtins
        inputs = iter(["9", "zzz", "2"])
        seen: list[str] = []
        original_input = builtins.input

        def fake_input(prompt: object = "") -> str:
            seen.append(str(prompt))
            return next(inputs)

        builtins.input = fake_input
        try:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                choice = install.ask_choice("provider", ("zai", "openai", "openrouter"))
        finally:
            builtins.input = original_input
        self.assertEqual(choice, "openai")
        # The interactive prompt must be its own line, not glued to the
        # last menu option ("3) openrouter: ").
        self.assertEqual(seen, ["choice [1-3]: ", "choice [1-3]: ", "choice [1-3]: "])
        self.assertIn("  3) openrouter\n", output.getvalue())


class FakeClock:
    """Advances only on sleep(), so api_healthy's bounded poll loops run
    instantly in tests instead of sleeping out their full budget."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class MainFlowTest(unittest.TestCase):
    """Offline main()/wire_goblin() tests: fake the system edge (run/probe/
    prompts), keep file I/O real. Synthetic values only."""

    def setUp(self) -> None:
        self.saved = {name: getattr(install, name) for name in FAKED}
        self.addCleanup(self._restore)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        install.CFG_DIR = root / "goblin-memory"
        install.SYSTEMD_DIR = root / "systemd"
        install.USER_UNIT_DIR = root / "user-units"
        install.POSTGRES_ENV = install.CFG_DIR / "postgres.env"
        install.HINDSIGHT_ENV = install.CFG_DIR / "hindsight.env"
        self.goblin_home = root / "goblin"
        self.goblin_home.mkdir()
        (self.goblin_home / "goblin.json5").write_text(
            "{\n  model: 'zai/m',\n  logLevel: 'debug',\n}\n")

    def _restore(self) -> None:
        for name, value in self.saved.items():
            setattr(install, name, value)

    def fake_prompts(self) -> None:
        install.preflight = lambda: None
        install.prompt_answers = lambda goblin_home: synthetic_answers()
        install.prompt_bank = lambda: ("goblin", "synthetic mission")

    def fake_yes(self) -> None:
        install.ask_yes = lambda prompt, default: True

    def test_fresh_refuses_existing_postgres_env(self) -> None:
        # Review B2: a fresh run must never regenerate the database
        # password — the volume may already be initialized.
        self.fake_prompts()
        self.fake_yes()
        install.POSTGRES_ENV.parent.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        with self.assertRaises(SystemExit):
            install.main([])
        self.assertEqual(install.POSTGRES_ENV.read_text(),
                         "POSTGRES_PASSWORD=existing\n")
        self.assertFalse(install.HINDSIGHT_ENV.exists())

    def test_reconfigure_reuses_password_and_rewrites_only_hindsight(self) -> None:
        self.fake_prompts()
        install.POSTGRES_ENV.parent.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        install.HINDSIGHT_ENV.write_text("HINDSIGHT_API_LLM_MODEL=old\n")
        restarts: list[list[str]] = []
        runs: list[list[str]] = []

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            restarts.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        def fake_run(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            runs.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        install.probe = fake_probe
        install.run = fake_run
        install.http_ok = lambda url: True
        install.main(["--reconfigure"])
        self.assertEqual(install.POSTGRES_ENV.read_text(),
                         "POSTGRES_PASSWORD=existing\n")
        env = install.HINDSIGHT_ENV.read_text()
        self.assertIn("HINDSIGHT_API_LLM_MODEL=operator-llm", env)
        self.assertIn("postgresql://hindsight:existing@db:5432/hindsight", env)
        self.assertEqual(restarts, [["systemctl", "--user", "restart", install.API_UNIT]])
        # A reconfigure on an existing box must also refresh the assets
        # (watch units) and bring the timer live — fresh-install parity.
        self.assertEqual(runs, [["systemctl", "--user", "daemon-reload"],
                                ["systemctl", "--user", "enable", "--now",
                                 install.WATCH_TIMER]])
        self.assertTrue((install.USER_UNIT_DIR / install.WATCH_TIMER).is_file())

    def check_installed_guard(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        # Load the on-disk guard, not install.validate: the container sees
        # the installed file, which may lag behind the installer's source.
        return subprocess.run(
            [sys.executable, "-c",
             "import json, runpy, sys; "
             "runpy.run_path(sys.argv[1])['validate'](json.load(sys.stdin))",
             str(install.CFG_DIR / "start.py")],
            input=json.dumps(env), text=True, capture_output=True, check=False,
        )

    def run_baseline_upgrade(self, failure: str | None = None) -> None:
        self.fake_prompts()
        answers = synthetic_answers(
            emb_provider="openai", emb_base_url="http://100.64.0.1:11435/v1",
            emb_model="embeddinggemma")
        install.prompt_answers = lambda goblin_home: answers
        install.CFG_DIR.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        previous_env = build_hindsight_env(synthetic_answers(), "existing")
        previous_text = render_env_file(previous_env)
        write_file_atomic(install.HINDSIGHT_ENV, previous_text, 0o640)
        guard_path = install.CFG_DIR / "start.py"
        shipped_guard = (install.MEMORY_DIR / "start.py").read_text()
        # The baseline profile had the same required keys, but no optional
        # prefix allowance. Reproduce that installed-file contract offline.
        self.assertIn(" | OPTIONAL", shipped_guard)
        guard_path.write_text(shipped_guard.replace(" | OPTIONAL", ""))
        new_env = build_hindsight_env(answers, "existing")
        self.assertEqual(self.check_installed_guard(previous_env).returncode, 0)
        rejected = self.check_installed_guard(new_env)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("unsupported override", rejected.stderr)
        restarted_envs: list[dict[str, str]] = []
        runs: list[list[str]] = []

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            self.assertEqual(command, ["systemctl", "--user", "restart", install.API_UNIT])
            env = dict(line.split("=", 1)
                       for line in install.HINDSIGHT_ENV.read_text().splitlines())
            restarted_envs.append(env)
            checked = self.check_installed_guard(env)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            if failure == "restart" and len(restarted_envs) == 1:
                return subprocess.CompletedProcess(command, 1, "", "synthetic restart failure")
            return subprocess.CompletedProcess(command, 0, "", "")

        def fake_run(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            runs.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        install.probe = fake_probe
        install.run = fake_run
        install.http_ok = lambda url: (failure != "health" or
                                      install.HINDSIGHT_ENV.read_text() == previous_text)
        setattr(install, "time", FakeClock())
        with contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            if failure is None:
                install.main(["--reconfigure"])
            else:
                with self.assertRaises(SystemExit):
                    install.main(["--reconfigure"])
        self.assertEqual(guard_path.read_text(), shipped_guard)
        self.assertEqual(stat.S_IMODE(guard_path.stat().st_mode), 0o644)
        self.assertEqual(install.POSTGRES_ENV.read_text(), "POSTGRES_PASSWORD=existing\n")
        if failure is None:
            self.assertEqual(restarted_envs, [new_env])
            self.assertEqual(install.HINDSIGHT_ENV.read_text(), render_env_file(new_env))
            self.assertIn(["systemctl", "--user", "enable", "--now", install.WATCH_TIMER], runs)
        else:
            self.assertEqual(restarted_envs, [new_env, previous_env])
            self.assertEqual(install.HINDSIGHT_ENV.read_text(), previous_text)
            self.assertEqual(stat.S_IMODE(install.HINDSIGHT_ENV.stat().st_mode), 0o640)
            self.assertIn("verified the API is healthy again", errors.getvalue())
            self.assertEqual(runs, [], "failed upgrade must not enable the watcher")

    def test_baseline_upgrade_installs_guard_before_restart(self) -> None:
        self.run_baseline_upgrade()

    def test_baseline_upgrade_restores_env_after_restart_failure(self) -> None:
        self.run_baseline_upgrade("restart")

    def test_baseline_upgrade_restores_env_after_health_failure(self) -> None:
        self.run_baseline_upgrade("health")

    def test_reconfigure_restores_previous_env_when_restart_fails(self) -> None:
        # A restart command failure must not leave the new (untested) env
        # installed over a working stack's config.
        self.fake_prompts()
        install.POSTGRES_ENV.parent.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        install.HINDSIGHT_ENV.write_text("HINDSIGHT_API_LLM_MODEL=old\n")
        failed = subprocess.CompletedProcess([], 1, "", "unit not found")
        commands: list[list[str]] = []

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return failed

        install.probe = fake_probe
        install.http_ok = lambda url: True
        errors = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit):
                install.main(["--reconfigure"])
        self.assertEqual(install.HINDSIGHT_ENV.read_text(),
                         "HINDSIGHT_API_LLM_MODEL=old\n",
                         "previous env must be restored")
        self.assertEqual(
            commands,
            [["systemctl", "--user", "restart", install.API_UNIT]] * 2,
            "rollback must restart the restored (previous) config")
        self.assertIn("restored the previous hindsight.env", errors.getvalue())

    def test_reconfigure_restores_previous_env_when_never_healthy(self) -> None:
        # Structurally valid config (passes the launch guard) that the API
        # still refuses to serve: restore and verify the old stack.
        self.fake_prompts()
        install.POSTGRES_ENV.parent.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        install.HINDSIGHT_ENV.write_text("HINDSIGHT_API_LLM_MODEL=old\n")
        ok = subprocess.CompletedProcess([], 0, "", "")
        commands: list[list[str]] = []

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return ok

        install.probe = fake_probe
        install.http_ok = lambda url: False
        # setattr, not assignment: `time` is an imported module, and mypy
        # flags rebinding those directly. The clock runs api_healthy's
        # 120s budget instantly.
        setattr(install, "time", FakeClock())
        errors = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit):
                install.main(["--reconfigure"])
        self.assertEqual(install.HINDSIGHT_ENV.read_text(),
                         "HINDSIGHT_API_LLM_MODEL=old\n")
        self.assertEqual(len(commands), 2, "rollback restarts the prior config")
        self.assertIn("did NOT recover", errors.getvalue())

    def test_reconfigure_prompts_before_failing_on_missing_postgres_env(self) -> None:
        asked = {"prompts": False}

        def fake_answers(goblin_home: Path) -> Answers:
            asked["prompts"] = True
            return synthetic_answers()

        install.preflight = lambda: None
        install.prompt_answers = fake_answers
        with self.assertRaises(SystemExit):
            install.main(["--reconfigure"])
        self.assertFalse(asked["prompts"], "must fail before collecting hidden keys")

    def test_reconfigure_rejects_no_start(self) -> None:
        with self.assertRaises(SystemExit):
            install.main(["--reconfigure", "--no-start"])

    def existing_stack(self) -> None:
        install.preflight = lambda: None
        install.POSTGRES_ENV.parent.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        install.HINDSIGHT_ENV.write_text("HINDSIGHT_API_LLM_MODEL=old\n")

    def run_existing(self, api_state: str, argv: list[str]) -> list[list[str]]:
        """Run main() over an existing install; probe reports api_state
        for every is-active query (the API unit's is what gates the
        watch-timer enable). Captures run() commands — never real ones."""
        runs: list[list[str]] = []
        install.probe = lambda command: subprocess.CompletedProcess(
            command, 0, f"{api_state}\n", "")
        install.http_ok = lambda url: True

        def fake_run(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            runs.append(command)
            output = f"{install.API_UNIT}\n" if command == BOOT_QUERY else ""
            return subprocess.CompletedProcess(command, 0, output, "")

        install.run = fake_run
        with contextlib.redirect_stdout(io.StringIO()):
            install.main(argv)
        return runs

    def test_existing_install_refreshes_assets_and_enables_watch(self) -> None:
        # Review finding: install_assets ran only on a fresh install, so
        # re-running on an existing box left the health watcher inactive
        # forever. Stack up → copy + reload + timer live.
        self.existing_stack()
        runs = self.run_existing("active", [])
        self.assertEqual(runs, [BOOT_QUERY,
                               ["systemctl", "--user", "daemon-reload"],
                                ["systemctl", "--user", "enable", "--now",
                                 install.WATCH_TIMER]])
        for name in install.WATCH_UNITS:
            self.assertTrue((install.USER_UNIT_DIR / name).is_file(),
                            f"{name} must land in the user unit dir")

    def test_existing_install_preserves_operator_edited_quadlet(self) -> None:
        # Review finding: the status-path refresh re-copied shipped
        # Quadlets over installed ones — destroying the TimeoutStartSec
        # raise the health-gate failure message tells the operator to
        # make by hand.
        self.existing_stack()
        install.SYSTEMD_DIR.mkdir(parents=True, exist_ok=True)
        edited = install.SYSTEMD_DIR / "goblin-memory-api.container"
        edited.write_text("[Container]\nTimeoutStartSec=900\n")
        self.run_existing("active", [])
        self.assertIn("TimeoutStartSec=900", edited.read_text())
        self.assertTrue(
            (install.SYSTEMD_DIR / "goblin-memory-db.container").is_file(),
            "Quadlets missing at the destination must still be delivered")

    def test_existing_install_skips_watch_enable_when_stack_down(self) -> None:
        # A stopped stack is a deliberate operator choice: assets and
        # reload only, no enable.
        self.existing_stack()
        runs = self.run_existing("inactive", [])
        self.assertEqual(runs, [BOOT_QUERY, ["systemctl", "--user", "daemon-reload"]])

    def test_existing_install_respects_no_start(self) -> None:
        self.existing_stack()
        runs = self.run_existing("active", ["--no-start"])
        self.assertEqual(runs, [BOOT_QUERY, ["systemctl", "--user", "daemon-reload"]])

    def write_relay_switch(self) -> None:
        install.CFG_DIR.mkdir(parents=True, exist_ok=True)
        (install.CFG_DIR / "embed-relay.env").write_text(EmbedRelayEnvTest.VALID)

    def test_existing_install_enables_embed_relay_when_switched(self) -> None:
        self.existing_stack()
        self.write_relay_switch()
        runs = self.run_existing("active", [])
        self.assertEqual(runs, [
            BOOT_QUERY,
            ["systemctl", "--user", "daemon-reload"],
            ["systemctl", "--user", "daemon-reload"],
            ["systemctl", "--user", "enable", "--now",
             install.RELAY_UNIT, install.PIN_TIMER],
            ["systemctl", "--user", "enable", "--now", install.WATCH_TIMER]])
        for name in install.EMBED_UNITS:
            self.assertTrue((install.USER_UNIT_DIR / name).is_file(), name)

    def test_reconfigure_enables_relay_before_api_restart(self) -> None:
        # The API test-embeds during init: a switch to local embeddings on
        # reconfigure must have the relay live first.
        self.fake_prompts()
        install.POSTGRES_ENV.parent.mkdir(parents=True)
        install.POSTGRES_ENV.write_text("POSTGRES_PASSWORD=existing\n")
        install.HINDSIGHT_ENV.write_text("HINDSIGHT_API_LLM_MODEL=old\n")
        self.write_relay_switch()
        commands: list[list[str]] = []

        def record(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        install.run = record
        install.probe = record
        install.http_ok = lambda url: True
        with contextlib.redirect_stdout(io.StringIO()):
            install.main(["--reconfigure"])
        enable_cmd = ["systemctl", "--user", "enable", "--now",
                      install.RELAY_UNIT, install.PIN_TIMER]
        restart_cmd = ["systemctl", "--user", "restart", install.API_UNIT]
        self.assertIn(enable_cmd, commands)
        self.assertIn(restart_cmd, commands)
        self.assertLess(commands.index(enable_cmd),
                        commands.index(restart_cmd))
        for name in install.EMBED_UNITS:
            self.assertTrue((install.USER_UNIT_DIR / name).is_file(), name)

    def test_fresh_start_enables_relay_before_api_start(self) -> None:
        self.fake_prompts()
        self.fake_yes()
        self.write_relay_switch()
        commands: list[list[str]] = []

        def record(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            output = f"{install.API_UNIT}\n" if command == BOOT_QUERY else ""
            return subprocess.CompletedProcess(command, 0, output, "")

        install.run = record

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            if "is-active" in command:
                return subprocess.CompletedProcess(command, 0, "active\n", "")
            if "inspect" in command:
                return subprocess.CompletedProcess(command, 0, "healthy\n", "")
            if "show" in command:
                return subprocess.CompletedProcess(
                    command, 0, f"Wants={install.API_UNIT}\n", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        install.probe = fake_probe
        install.http_ok = lambda url: True
        install.create_bank = lambda bank_id, mission: None
        install.wire_goblin = lambda goblin_home, bank_id: "live"
        with contextlib.redirect_stdout(io.StringIO()):
            install.main(["--goblin-home", str(self.goblin_home)])
        enable_cmd = ["systemctl", "--user", "enable", "--now",
                      install.RELAY_UNIT, install.PIN_TIMER]
        api_start = ["systemctl", "--user", "start", install.API_UNIT]
        self.assertIn(enable_cmd, commands)
        self.assertIn(api_start, commands)
        self.assertLess(commands.index(enable_cmd),
                        commands.index(api_start))
        self.assertFalse(
            (install.USER_UNIT_DIR / "default.target.wants" / install.API_UNIT).is_symlink(),
            "Quadlet, not the installer, owns the generated boot link",
        )

    def test_invalid_relay_switch_fails_before_any_durable_state(self) -> None:
        # A present-but-invalid opt-in must refuse the whole install
        # before prompts or a single durable write — never prompts
        # answered and secrets written on top of a switch the relay
        # units would then fail on.
        install.preflight = lambda: None
        install.CFG_DIR.mkdir(parents=True)
        (install.CFG_DIR / "embed-relay.env").write_text(
            "GOBLIN_EMBED_RELAY_ADDR=\nGOBLIN_EMBED_MODEL=m\n")
        asked = {"prompts": False}

        def fake_answers(goblin_home: Path) -> Answers:
            asked["prompts"] = True
            return synthetic_answers()

        install.prompt_answers = fake_answers
        with self.assertRaises(SystemExit):
            install.main([])
        self.assertFalse(asked["prompts"], "must refuse before collecting answers")
        self.assertFalse(install.POSTGRES_ENV.exists())
        self.assertFalse(install.HINDSIGHT_ENV.exists())
        for name in install.EMBED_UNITS + install.WATCH_UNITS:
            self.assertFalse((install.USER_UNIT_DIR / name).exists(), name)
        self.assertFalse(install.USER_UNIT_DIR.exists(), "no unit dir created")

        # Correct the switch and rerun: the fresh path proceeds — relay
        # enabled before the API start, env files and units in place.
        (install.CFG_DIR / "embed-relay.env").write_text(EmbedRelayEnvTest.VALID)
        self.fake_prompts()
        self.fake_yes()
        commands: list[list[str]] = []

        def record(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            output = f"{install.API_UNIT}\n" if command == BOOT_QUERY else ""
            return subprocess.CompletedProcess(command, 0, output, "")

        install.run = record

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            if "is-active" in command:
                return subprocess.CompletedProcess(command, 0, "active\n", "")
            if "inspect" in command:
                return subprocess.CompletedProcess(command, 0, "healthy\n", "")
            if "show" in command:
                return subprocess.CompletedProcess(
                    command, 0, f"Wants={install.API_UNIT}\n", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        install.probe = fake_probe
        install.http_ok = lambda url: True
        banks: list[str] = []
        install.create_bank = lambda bank_id, mission: banks.append(bank_id)
        install.wire_goblin = lambda goblin_home, bank_id: "live"
        with contextlib.redirect_stdout(io.StringIO()):
            install.main(["--goblin-home", str(self.goblin_home)])
        self.assertTrue(install.POSTGRES_ENV.is_file())
        self.assertTrue(install.HINDSIGHT_ENV.is_file())
        self.assertEqual(banks, ["goblin"])
        for name in install.EMBED_UNITS:
            self.assertTrue((install.USER_UNIT_DIR / name).is_file(), name)
        enable_cmd = ["systemctl", "--user", "enable", "--now",
                      install.RELAY_UNIT, install.PIN_TIMER]
        api_start = ["systemctl", "--user", "start", install.API_UNIT]
        self.assertIn(enable_cmd, commands)
        self.assertIn(api_start, commands)
        self.assertLess(commands.index(enable_cmd), commands.index(api_start))

    def test_no_start_refuses_invalid_relay_switch_early(self) -> None:
        # The deferred-start branch shares the same early guard: an
        # invalid switch fails before prompts and durable state even
        # when no stack would be started.
        install.preflight = lambda: None
        install.CFG_DIR.mkdir(parents=True)
        (install.CFG_DIR / "embed-relay.env").write_text(
            "GOBLIN_EMBED_RELAY_ADDR=not-an-ip\nGOBLIN_EMBED_MODEL=m\n")
        asked = {"prompts": False}

        def fake_answers(goblin_home: Path) -> Answers:
            asked["prompts"] = True
            return synthetic_answers()

        install.prompt_answers = fake_answers
        with self.assertRaises(SystemExit):
            install.main(["--no-start"])
        self.assertFalse(asked["prompts"], "must refuse before collecting answers")
        self.assertFalse(install.POSTGRES_ENV.exists())
        self.assertFalse(install.HINDSIGHT_ENV.exists())
        self.assertFalse(install.USER_UNIT_DIR.exists(), "no unit dir created")

    def deferred_output(self, argv: list[str]) -> str:
        """Run a fresh install that defers the start; capture stdout and
        prove nothing at the system edge actually ran."""
        runs: list[list[str]] = []

        def fake_run(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
            runs.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        install.run = fake_run
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            install.main([*argv, "--goblin-home", str(self.goblin_home)])
        self.assertEqual(runs, [])
        return captured.getvalue()

    def deferred_lines(self, argv: list[str]) -> list[str]:
        return [line.strip() for line in self.deferred_output(argv).splitlines()]

    def test_no_start_installs_embed_assets_without_enabling(self) -> None:
        self.fake_prompts()
        self.fake_yes()
        self.write_relay_switch()
        lines = self.deferred_lines(["--no-start"])
        # The relay is still opt-in before the API: the continuation
        # orders it first, then the API, then the watch timer — the
        # same boot/watch policy a confirmed start applies.
        relay = (f"systemctl --user enable --now {install.RELAY_UNIT} "
                 f"{install.PIN_TIMER}")
        api = f"systemctl --user start {install.API_UNIT}"
        watch = f"systemctl --user enable --now {install.WATCH_TIMER}"
        for command in ("systemctl --user daemon-reload", relay, api, watch):
            self.assertIn(command, lines)
        self.assertLess(lines.index(relay), lines.index(api))
        self.assertLess(lines.index(api), lines.index(watch))
        for name in install.EMBED_UNITS:
            self.assertTrue((install.USER_UNIT_DIR / name).is_file(), name)

    def test_no_start_remote_only_omits_embed_units(self) -> None:
        self.fake_prompts()
        self.fake_yes()
        output = self.deferred_output(["--no-start"])
        self.assertNotIn("goblin-embed", output)
        self.assertIn(f"systemctl --user start {install.API_UNIT}", output)
        self.assertIn(f"systemctl --user enable --now {install.WATCH_TIMER}", output)
        for name in install.EMBED_UNITS:
            self.assertFalse((install.USER_UNIT_DIR / name).exists(), name)

    def test_declined_first_start_prints_same_deferred_continuation(self) -> None:
        self.fake_prompts()
        # Yes to writing config and assets, no to the first start.
        install.ask_yes = lambda prompt, default: "write config" in str(prompt)
        self.write_relay_switch()
        lines = self.deferred_lines([])
        relay = (f"systemctl --user enable --now {install.RELAY_UNIT} "
                 f"{install.PIN_TIMER}")
        api = f"systemctl --user start {install.API_UNIT}"
        watch = f"systemctl --user enable --now {install.WATCH_TIMER}"
        self.assertLess(lines.index(relay), lines.index(api))
        self.assertLess(lines.index(api), lines.index(watch))
        self.assertTrue(install.HINDSIGHT_ENV.is_file())
        for name in install.EMBED_UNITS:
            self.assertTrue((install.USER_UNIT_DIR / name).is_file(), name)

    def test_main_no_start_never_leaks_secrets_to_output(self) -> None:
        self.fake_prompts()
        self.fake_yes()
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            install.main(["--no-start", "--goblin-home", str(self.goblin_home)])
        output = captured.getvalue()
        self.assertNotIn(SYNTHETIC_KEY, output)
        pw = install.POSTGRES_ENV.read_text().split("=", 1)[1].strip()
        self.assertNotIn(pw, output)
        self.assertTrue(install.HINDSIGHT_ENV.is_file())

    def test_ctrl_c_exits_cleanly(self) -> None:
        def interrupted(argv: list[str] | None = None) -> None:
            raise KeyboardInterrupt()

        install.main = interrupted
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as raised:
                install.cli()
        self.assertEqual(raised.exception.code, 130)
        self.assertNotIn("Traceback", errors.getvalue())

    def test_ctrl_d_exits_cleanly(self) -> None:
        def ended(argv: list[str] | None = None) -> None:
            raise EOFError()

        install.main = ended
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as raised:
                install.cli()
        self.assertEqual(raised.exception.code, 1)
        self.assertNotIn("Traceback", errors.getvalue())


class WireGoblinRollbackTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = {name: getattr(install, name) for name in FAKED}
        self.addCleanup(self._restore)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.config = self.home / "goblin.json5"
        self.original = "{\n  model: 'zai/m',\n  logLevel: 'debug',\n}\n"
        self.config.write_text(self.original)

    def _restore(self) -> None:
        for name, value in self.saved.items():
            setattr(install, name, value)

    def run_wire(self, restart_result: subprocess.CompletedProcess[str], stable: bool) -> str:
        install.ask_yes = lambda prompt, default: True
        install.probe = lambda command: restart_result
        install.goblin_stable = lambda seconds: stable
        return install.wire_goblin(self.home, "goblin")

    def test_rollback_when_restart_command_fails(self) -> None:
        failed = subprocess.CompletedProcess([], 1, "", "unit not found")
        with self.assertRaises(SystemExit):
            self.run_wire(failed, stable=True)
        self.assertEqual(self.config.read_text(), self.original,
                         "config must be restored when the restart command fails")
        self.assertTrue((self.home / "goblin.json5.pre-memory").is_file())

    def test_rollback_when_goblin_unstable(self) -> None:
        ok = subprocess.CompletedProcess([], 0, "", "")
        with self.assertRaises(SystemExit):
            self.run_wire(ok, stable=False)
        self.assertEqual(self.config.read_text(), self.original,
                         "config must be restored when goblin crash-loops")

    def test_success_patches_and_reports_wired(self) -> None:
        ok = subprocess.CompletedProcess([], 0, "", "")
        self.assertEqual(self.run_wire(ok, stable=True), "live")
        self.assertIn("memory: {", self.config.read_text())

    def test_declined_restart_leaves_patch_with_backup(self) -> None:
        install.ask_yes = lambda prompt, default: False
        self.assertEqual(install.wire_goblin(self.home, "goblin"), "patched")
        text = self.config.read_text()
        self.assertIn("memory: {", text)
        self.assertTrue((self.home / "goblin.json5.pre-memory").is_file())


if __name__ == "__main__":
    unittest.main()
