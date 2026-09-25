"""Offline checks: synthetic values only; no containers or provider requests."""
import configparser
from pathlib import Path
import unittest

from start import FIXED, validate

ROOT = Path(__file__).parent


class MemoryAssetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.env = dict(FIXED)
        self.env.update({
            "HINDSIGHT_API_LLM_PROVIDER": "zai",
            "HINDSIGHT_API_LLM_BASE_URL": "https://example.invalid/v1",
            "HINDSIGHT_API_LLM_MODEL": "operator-llm",
            "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "openrouter",
            "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL": "operator-embedding",
            "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
        })
        self.env.update({
            "HINDSIGHT_API_DATABASE_URL": "postgresql://hindsight:synthetic@db:5432/hindsight",
            "HINDSIGHT_API_LLM_API_KEY": "synthetic",
            "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY": "synthetic",
        })

    def test_explicit_model_free_selection(self) -> None:
        validate(self.env)

    def test_missing_required_values_fail(self) -> None:
        for key in self.env.keys() - FIXED.keys():
            with self.subTest(key=key):
                env = self.env.copy()
                del env[key]
                with self.assertRaises(ValueError):
                    validate(env)

    def test_no_implicit_models_or_overrides(self) -> None:
        for key, value in [
            ("HINDSIGHT_API_RERANKER_PROVIDER", ""),
            ("HINDSIGHT_API_RERANKER_PROVIDER", "local"),
            ("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "local"),
            ("HINDSIGHT_API_RETAIN_LLM_MODEL", "unrequested"),
            ("HINDSIGHT_API_LLM_1_MODEL", "unrequested"),
            ("HINDSIGHT_API_LLM_PROVIDER", "zai,openai"),
            ("HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL", "unselected"),
            ("HINDSIGHT_API_EMBEDDINGS_OPENROUTER_BASE_URL", "https://ignored.invalid"),
            ("HINDSIGHT_API_DATABASE_URL", "postgresql://hindsight:synthetic@public:5432/hindsight"),
            ("HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH", "true"),
        ]:
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError) as result:
                    validate(dict(self.env, **{key: value}))
                self.assertNotIn("synthetic", str(result.exception))

    def test_all_provider_mappings(self) -> None:
        for llm in ["zai", "openai", "openrouter"]:
            for embedding in ["openrouter", "openai"]:
                with self.subTest(llm=llm, embedding=embedding):
                    env = self.env.copy()
                    env["HINDSIGHT_API_LLM_PROVIDER"] = llm
                    env["HINDSIGHT_API_EMBEDDINGS_PROVIDER"] = embedding
                    del env["HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL"]
                    del env["HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY"]
                    prefix = f"HINDSIGHT_API_EMBEDDINGS_{embedding.upper()}"
                    env[f"{prefix}_MODEL"] = "another-operator-model"
                    env[f"{prefix}_API_KEY"] = "synthetic"
                    if embedding == "openai":
                        env[f"{prefix}_BASE_URL"] = "https://example.invalid/v1"
                    validate(env)
                    for key in env.keys() - FIXED.keys():
                        for empty in [None, "", "   "]:
                            broken = env.copy()
                            if empty is None:
                                del broken[key]
                            else:
                                broken[key] = empty
                            with self.assertRaises(ValueError):
                                validate(broken)
                    for key in [k for k in env if k.endswith("BASE_URL")]:
                        for bad in ["relative", "ftp://example.invalid", "https://u:synthetic@host", "https://host:bad"]:
                            with self.assertRaises(ValueError) as result:
                                validate(dict(env, **{key: bad}))
                            self.assertNotIn("synthetic", str(result.exception))

    def test_example_fails_closed(self) -> None:
        env = dict(line.split("=", 1) for line in
                   (ROOT / "hindsight.env.example").read_text().splitlines()
                   if line and not line.startswith("#"))
        with self.assertRaises(ValueError):
            validate(env)

    def test_quadlet_boundaries(self) -> None:
        for role in ["api", "db"]:
            unit = configparser.ConfigParser(interpolation=None)
            unit.read(ROOT / f"goblin-memory-{role}.container")
            container = unit["Container"]
            self.assertRegex(container["Image"], r"@sha256:[a-f0-9]{64}$")
            self.assertEqual(container["Network"], "goblin-memory.network")
            self.assertEqual(container["Notify"], "healthy")
            self.assertEqual(container["LogDriver"], "journald")
            self.assertEqual(unit["Service"]["Restart"], "on-failure")
            if role == "api":
                self.assertEqual(container["PublishPort"], "127.0.0.1:8888:8888")
                # Boot-enabled like goblin itself — the confirmed first start
                # belongs to the installer, not to every reboot. The db rides
                # along via Requires/After; only the API unit needs the hook.
                self.assertEqual(unit["Install"]["WantedBy"], "default.target")
            else:
                self.assertNotIn("PublishPort", container)
                self.assertIn("/var/lib/postgresql/data", container["Volume"])
                self.assertNotIn("Install", unit)

    def test_watch_units(self) -> None:
        """The health watch restarts only a running-but-unhealthy stack."""
        service = (ROOT / "goblin-memory-watch.service").read_text()
        timer = (ROOT / "goblin-memory-watch.timer").read_text()
        self.assertIn('"{{.State.Health.Status}}" goblin-memory-api', service)
        self.assertIn('= unhealthy ]', service)
        self.assertIn('systemctl --user restart goblin-memory-api.service', service)
        # Absent container exits 0 — a deliberate stop must stick.
        self.assertIn('|| exit 0', service)
        self.assertIn('OnUnitActiveSec=5min', timer)
        self.assertIn('[Install]', timer)


if __name__ == "__main__":
    unittest.main()
