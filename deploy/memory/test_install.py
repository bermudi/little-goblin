"""Offline installer checks: synthetic values only; no network, no containers."""
import contextlib
import io
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from urllib.parse import urlsplit

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


def synthetic_answers(
    llm_model: str = "operator-llm",
    llm_base_url: str = "https://example.invalid/v1",
    emb_provider: str = "openrouter",
    emb_base_url: str | None = None,
) -> Answers:
    return Answers(
        llm_provider="zai",
        llm_model=llm_model,
        llm_base_url=llm_base_url,
        llm_api_key=SYNTHETIC_KEY,
        emb_provider=emb_provider,
        emb_model="operator-embedding",
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


class SecretFileTest(unittest.TestCase):
    def test_mode_600_and_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secrets.env"
            write_file_atomic(path, "K=v\n", 0o600)
            self.assertEqual(path.read_text(), "K=v\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertFalse(list(path.parent.glob(".secrets.env.tmp")),
                             "tmp file must not survive")

    def test_overwrite_keeps_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secrets.env"
            write_file_atomic(path, "K=old\n", 0o600)
            write_file_atomic(path, "K=new\n", 0o600)
            self.assertEqual(path.read_text(), "K=new\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class InstallAssetsTest(unittest.TestCase):
    def test_copies_quadlet_and_guard_with_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "src"
            systemd_dir = Path(tmp) / "systemd"
            cfg_dir = Path(tmp) / "cfg"
            memory_dir.mkdir()
            (memory_dir / "goblin-memory-api.container").write_text("[Container]\n")
            (memory_dir / "goblin-memory.network").write_text("[Network]\n")
            (memory_dir / "start.py").write_text("x = 1\n")
            installed = install_assets(memory_dir, systemd_dir, cfg_dir)
            names = {p.name for p in installed}
            self.assertEqual(names, {"goblin-memory-api.container",
                                     "goblin-memory.network", "start.py"})
            for path in installed:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(systemd_dir.stat().st_mode), 0o700)


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


FAKED = ("preflight", "prompt_answers", "prompt_bank", "ask_yes", "run",
         "http_ok", "probe", "goblin_stable", "time", "CFG_DIR", "SYSTEMD_DIR",
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


class FetchCatalogTest(unittest.TestCase):
    def test_parses_openai_style_catalog(self) -> None:
        import unittest.mock as mock
        from urllib import request as urlrequest
        payload = io.BytesIO(b'{"data": [{"id": "b"}, {"id": "a"}, {"not": "id"}]}')
        response = mock.MagicMock()
        response.__enter__.return_value = payload
        response.__exit__.return_value = False
        with mock.patch.object(urlrequest, "urlopen", return_value=response):
            catalog = install.fetch_model_catalog("https://example.invalid/models", "k")
        self.assertEqual(catalog, ["a", "b"])

    def test_unreachable_returns_none_not_crash(self) -> None:
        import unittest.mock as mock
        from urllib import error as urlerror
        from urllib import request as urlrequest
        with mock.patch.object(
                urlrequest, "urlopen",
                side_effect=urlerror.URLError("nope")):
            catalog = install.fetch_model_catalog("https://example.invalid/models", None)
        self.assertIsNone(catalog)


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
        install.prompt_answers = lambda: synthetic_answers()
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

        def fake_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
            restarts.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        install.probe = fake_probe
        install.http_ok = lambda url: True
        install.main(["--reconfigure"])
        self.assertEqual(install.POSTGRES_ENV.read_text(),
                         "POSTGRES_PASSWORD=existing\n")
        env = install.HINDSIGHT_ENV.read_text()
        self.assertIn("HINDSIGHT_API_LLM_MODEL=operator-llm", env)
        self.assertIn("postgresql://hindsight:existing@db:5432/hindsight", env)
        self.assertEqual(restarts, [["systemctl", "--user", "restart", install.API_UNIT]])

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

        def fake_answers() -> Answers:
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

    def run_wire(self, restart_result: subprocess.CompletedProcess[str], stable: bool) -> None:
        install.ask_yes = lambda prompt, default: True
        install.probe = lambda command: restart_result
        install.goblin_stable = lambda seconds: stable
        install.wire_goblin(self.home, "goblin")

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
        self.run_wire(ok, stable=True)
        self.assertIn("memory: {", self.config.read_text())

    def test_declined_restart_leaves_patch_with_backup(self) -> None:
        install.ask_yes = lambda prompt, default: False
        install.wire_goblin(self.home, "goblin")
        text = self.config.read_text()
        self.assertIn("memory: {", text)
        self.assertTrue((self.home / "goblin.json5.pre-memory").is_file())


if __name__ == "__main__":
    unittest.main()
