"""Offline installer checks: synthetic values only; no network, no containers."""
from pathlib import Path
import stat
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
        # The appended comma lands inside the line comment, but the property
        # was already terminated by the comma before it — valid JSON5.
        self.assertIn("// trailing comment,\n  memory: {", updated)

    def test_no_double_comma_when_last_property_has_trailing_comma(self) -> None:
        updated = insert_json5_property("{\n  a: 1,\n}\n", "  memory: {}", "memory")
        self.assertNotIn(",,", updated)
        self.assertEqual(updated, "{\n  a: 1,\n  memory: {}\n}\n")

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


if __name__ == "__main__":
    unittest.main()
