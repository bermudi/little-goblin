"""Offline provider-module checks: synthetic values only; no network."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import unittest.mock as mock

import providers
from providers import (
    Provider,
    catalog_url_for,
    example_for,
    fetch_model_catalog,
    filter_catalog,
    providers_for,
    read_goblin_providers,
    resolve_auth_key,
)


class ProviderTableTest(unittest.TestCase):
    def test_role_compatibility(self) -> None:
        llm = tuple(p.name for p in providers_for("llm"))
        emb = tuple(p.name for p in providers_for("emb"))
        self.assertEqual(llm, ("zai", "openai", "openrouter"))
        self.assertEqual(set(emb), {"openrouter", "openai"})  # zai does no embeddings
        with self.assertRaises(ValueError):
            providers_for("nope")

    def test_fixed_endpoints_and_catalogs(self) -> None:
        self.assertEqual(catalog_url_for("zai", "llm", None),
                         "https://api.z.ai/api/paas/v4/models")
        self.assertEqual(catalog_url_for("zai", "emb", None), None)
        self.assertEqual(catalog_url_for("openrouter", "emb", None),
                         "https://openrouter.ai/api/v1/embeddings/models")
        self.assertIsNone(catalog_url_for("openai", "llm", None))  # needs base
        self.assertEqual(catalog_url_for("openai", "llm", "https://x/v1"),
                         "https://x/v1/models")

    def test_openai_embedding_catalog_filtered(self) -> None:
        models = ["gpt-5.3", "text-embedding-3-small", "text-embedding-3-large"]
        self.assertEqual(filter_catalog("openai", "emb", models),
                         ["text-embedding-3-small", "text-embedding-3-large"])
        self.assertEqual(filter_catalog("openai", "llm", models), models)
        self.assertEqual(filter_catalog("openrouter", "emb", models), models)

    def test_examples(self) -> None:
        self.assertEqual(example_for("zai", "llm"), "glm-5.3-flash")
        self.assertEqual(example_for("openrouter", "emb"), "voyageai/voyage-4-lite")
        self.assertEqual(example_for("openai", "emb"), "any embedding model")


class ReadGoblinProvidersTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.repo = Path(self.tmp.name) / "repo"

    def test_parses_json5_via_bun(self) -> None:
        config = self.home / "goblin.json5"
        config.write_text(
            "// goblin\n{\n  providers: { zai: { baseUrl: 'x' }, "
            "openrouter: { auth: 'or-key' } },\n  model: 'zai/m',\n}\n")
        proc = subprocess.CompletedProcess(
            [], 0, json.dumps({"providers": {
                "zai": {"baseUrl": "x"}, "openrouter": {"auth": "or-key"}}}), "")
        with mock.patch("providers.subprocess.run", return_value=proc):
            registry, problem = read_goblin_providers(self.home, self.repo)
        self.assertIsNone(problem)
        # auth name defaults to the provider name when unspecified
        self.assertEqual(registry, {"zai": "zai", "openrouter": "or-key"})

    def test_strict_json_fallback(self) -> None:
        config = self.home / "goblin.json5"
        config.write_text(json.dumps({"providers": {"zai": {"auth": "z"}}}))
        failed = subprocess.CompletedProcess([], 1, "", "bun: not found")
        with mock.patch("providers.subprocess.run", return_value=failed):
            registry, problem = read_goblin_providers(self.home, self.repo)
        self.assertIsNone(problem)
        self.assertEqual(registry, {"zai": "z"})

    def test_unparseable_reports_problem(self) -> None:
        (self.home / "goblin.json5").write_text("{ not json5 or json ((( ")
        failed = subprocess.CompletedProcess([], 1, "", "bun: not found")
        with mock.patch("providers.subprocess.run", return_value=failed):
            registry, problem = read_goblin_providers(self.home, self.repo)
        self.assertEqual(registry, {})
        self.assertIsNotNone(problem)

    def test_missing_config_is_not_a_problem(self) -> None:
        registry, problem = read_goblin_providers(self.home, self.repo)
        self.assertEqual(registry, {})
        self.assertIsNone(problem)  # fresh operator path, no noise


class ResolveAuthKeyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.store = self.home / "auth.jsonl"
        self.store.write_text(
            json.dumps({"name": "zai", "value": "synthetic-literal"}) + "\n"
            + json.dumps({"name": "or", "value": "!echo synthetic-from-cmd"}) + "\n"
            + json.dumps({"name": "bad", "value": "!false"}) + "\n")

    def test_literal_value(self) -> None:
        self.assertEqual(resolve_auth_key(self.home, "zai"), "synthetic-literal")

    def test_command_record_resolved_in_process(self) -> None:
        self.assertEqual(resolve_auth_key(self.home, "or"), "synthetic-from-cmd")

    def test_failing_command_raises_without_value(self) -> None:
        with self.assertRaises(ValueError) as raised:
            resolve_auth_key(self.home, "bad")
        self.assertNotIn("synthetic", str(raised.exception))

    def test_missing_name_raises(self) -> None:
        with self.assertRaises(ValueError):
            resolve_auth_key(self.home, "nope")

    def test_missing_store_raises(self) -> None:
        with self.assertRaises(ValueError):
            resolve_auth_key(Path("/nonexistent"), "zai")


class FetchCatalogTest(unittest.TestCase):
    def fake_urlopen(self, payload: bytes) -> mock.MagicMock:
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(payload)
        response.__exit__.return_value = False
        return response

    def test_parses_openai_style_catalog(self) -> None:
        from urllib import request as urlrequest
        payload = b'{"data": [{"id": "b"}, {"id": "a"}, {"not": "id"}]}'
        with mock.patch.object(urlrequest, "urlopen",
                               return_value=self.fake_urlopen(payload)):
            catalog, reason = fetch_model_catalog("https://example.invalid/models", "k")
        self.assertEqual(reason, "ok")
        self.assertEqual(catalog, ["a", "b"])

    def test_http_error_names_the_status(self) -> None:
        from urllib import error as urlerror
        from urllib import request as urlrequest
        with mock.patch.object(urlrequest, "urlopen",
                               side_effect=urlerror.HTTPError(
                                   "url", 401, "Unauthorized", None, None)):  # type: ignore[arg-type]
            catalog, reason = fetch_model_catalog("https://example.invalid/models", "k")
        self.assertIsNone(catalog)
        self.assertIn("401", reason)

    def test_unreachable_returns_reason(self) -> None:
        from urllib import error as urlerror
        from urllib import request as urlrequest
        with mock.patch.object(urlrequest, "urlopen",
                               side_effect=urlerror.URLError("nope")):
            catalog, reason = fetch_model_catalog("https://example.invalid/models", None)
        self.assertIsNone(catalog)
        self.assertIn("unreachable", reason)


if __name__ == "__main__":
    unittest.main()
