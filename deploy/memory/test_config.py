"""Offline checks: synthetic values only; no containers or provider requests."""
import configparser
from pathlib import Path
import unittest

from start import EXPECTED, FIXED, validate

ROOT = Path(__file__).parent


class MemoryAssetsTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(EXPECTED, **FIXED)
        self.env.update({
            "HINDSIGHT_API_DATABASE_URL": "postgresql://hindsight:synthetic@db:5432/hindsight",
            "HINDSIGHT_API_LLM_API_KEY": "synthetic",
            "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY": "synthetic",
        })

    def test_explicit_model_free_selection(self):
        validate(self.env)

    def test_missing_required_values_fail(self):
        for key in self.env.keys() - FIXED.keys():
            with self.subTest(key=key):
                env = self.env.copy()
                del env[key]
                with self.assertRaises(ValueError):
                    validate(env)

    def test_no_implicit_models_or_overrides(self):
        for key, value in [
            ("HINDSIGHT_API_RERANKER_PROVIDER", ""),
            ("HINDSIGHT_API_RERANKER_PROVIDER", "local"),
            ("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "local"),
            ("HINDSIGHT_API_RETAIN_LLM_MODEL", "unrequested"),
            ("HINDSIGHT_API_LLM_1_MODEL", "unrequested"),
            ("HINDSIGHT_API_DATABASE_URL", "postgresql://hindsight:synthetic@public:5432/hindsight"),
            ("HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH", "true"),
        ]:
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError) as result:
                    validate(dict(self.env, **{key: value}))
                self.assertNotIn("synthetic", str(result.exception))

    def test_example_fails_closed(self):
        env = dict(line.split("=", 1) for line in
                   (ROOT / "hindsight.env.example").read_text().splitlines()
                   if line and not line.startswith("#"))
        with self.assertRaises(ValueError):
            validate(env)

    def test_quadlet_boundaries(self):
        for role in ["api", "db"]:
            unit = configparser.ConfigParser(interpolation=None)
            unit.read(ROOT / f"goblin-memory-{role}.container")
            container = unit["Container"]
            self.assertRegex(container["Image"], r"@sha256:[a-f0-9]{64}$")
            self.assertEqual(container["Network"], "goblin-memory.network")
            self.assertEqual(container["Notify"], "healthy")
            self.assertEqual(container["LogDriver"], "journald")
            self.assertEqual(unit["Service"]["Restart"], "on-failure")
            self.assertNotIn("Install", unit)
            if role == "api":
                self.assertEqual(container["PublishPort"], "127.0.0.1:8888:8888")
            else:
                self.assertNotIn("PublishPort", container)
                self.assertIn("/var/lib/postgresql/data", container["Volume"])


if __name__ == "__main__":
    unittest.main()
