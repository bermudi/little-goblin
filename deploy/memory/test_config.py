"""Offline checks: synthetic values only; no containers or provider requests."""
import configparser
from pathlib import Path
import unittest

from start import FIXED, validate

ROOT = Path(__file__).parent


class MemoryAssetsTest(unittest.TestCase):
    def test_hindsight_upgrade_pin_matches_installer(self) -> None:
        from install import API_IMAGE
        text = (ROOT / "goblin-memory-api.container").read_text()
        self.assertIn(f"Image={API_IMAGE}\n", text)
        self.assertIn(":1.0.0-slim@sha256:", API_IMAGE)

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
            "HINDSIGHT_API_DATABASE_URL":
                "postgresql://hindsight@127.0.0.1:5432/hindsight",
            "HINDSIGHT_API_LLM_API_KEY": "synthetic",
            "HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY": "synthetic",
        })

    def test_explicit_model_free_selection(self) -> None:
        validate(self.env)

    def test_embedding_prefixes_allowed_verbatim(self) -> None:
        # Asymmetric embedders (e.g. embeddinggemma) take a task prefix;
        # it is passed through untouched, whitespace included.
        validate(dict(self.env, **{
            "HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX": "task: search result | query: ",
            "HINDSIGHT_API_EMBEDDINGS_PASSAGE_PREFIX": "title: none | text: ",
        }))

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
            # The pod's database is loopback-only and passwordless —
            # credentials in the URL and any other host are refused.
            ("HINDSIGHT_API_DATABASE_URL",
             "postgresql://hindsight:synthetic@127.0.0.1:5432/hindsight"),
            ("HINDSIGHT_API_DATABASE_URL", "postgresql://hindsight@db:5432/hindsight"),
            ("HINDSIGHT_API_DATABASE_URL",
             "postgresql://hindsight:synthetic@public:5432/hindsight"),
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
        # The pod owns the network namespace and the only published port;
        # both containers join it — no inter-container link, no DB port.
        pod = configparser.ConfigParser(interpolation=None, strict=False)
        pod.read(ROOT / "goblin-memory.pod")
        self.assertEqual(pod["Pod"]["Network"], "goblin-memory.network")
        self.assertEqual(pod["Pod"]["PublishPort"], "127.0.0.1:8888:8888")
        for role in ["api", "db"]:
            # strict=False: quadlet legitimately repeats directives (Volume=
            # per mount, Secret= per credential), which strict configparser
            # rejects as duplicates.
            unit = configparser.ConfigParser(interpolation=None, strict=False)
            unit.read(ROOT / f"goblin-memory-{role}.container")
            container = unit["Container"]
            self.assertRegex(container["Image"], r"@sha256:[a-f0-9]{64}$")
            self.assertEqual(container["Pod"], "goblin-memory.pod")
            self.assertNotIn("Network", container,
                             "the pod owns the network namespace")
            self.assertNotIn("PublishPort", container)
            self.assertEqual(container["Notify"], "healthy")
            self.assertEqual(container["LogDriver"], "journald")
            self.assertEqual(unit["Service"]["Restart"], "on-failure")
            if role == "api":
                # The probe is a mounted script with no shell metacharacters
                # — a `python -c` one-liner dies in podman 5.4's CMD-SHELL
                # re-quoting.
                self.assertEqual(
                    container["HealthCmd"],
                    "/app/api/.venv/bin/python /opt/goblin-memory-healthcheck.py")
                api_text = (ROOT / "goblin-memory-api.container").read_text()
                self.assertIn(
                    "%h/.config/goblin-memory/healthcheck.py"
                    ":/opt/goblin-memory-healthcheck.py:ro,Z", api_text)
                # Credentials arrive as mounted podman secrets — the shipped
                # file carries the marker region; the installer fills it.
                self.assertIn("# goblin:secrets-begin", api_text)
                self.assertIn("# goblin:secrets-end", api_text)
                self.assertNotIn("HINDSIGHT_API_LLM_API_KEY=", api_text,
                                 "no literal credential in the Quadlet")
                # Boot-enabled like goblin itself — the confirmed first start
                # belongs to the installer, not to every reboot. The db rides
                # along via Requires/After; only the API unit needs the hook.
                self.assertEqual(unit["Install"]["WantedBy"], "default.target")
            else:
                self.assertIn("/var/lib/postgresql/data", container["Volume"])
                # Passwordless by construction: loopback trust inside the
                # pod, and Postgres must never leave the pod's loopback.
                self.assertIn("POSTGRES_HOST_AUTH_METHOD=trust",
                              container["Environment"])
                self.assertIn("listen_addresses=127.0.0.1",
                              container["Exec"])
                self.assertNotIn("POSTGRES_PASSWORD", container["Environment"])
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
