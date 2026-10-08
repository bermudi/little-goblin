"""Unit tests for bench.py's pure helpers (prompt surgery, parsing, language)."""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("bench", Path(__file__).parent / "bench.py")
bench = importlib.util.module_from_spec(_spec)
sys.modules["bench"] = bench
_spec.loader.exec_module(bench)

SYSTEM = (
	"Extract SIGNIFICANT facts.\n\n"
	"LANGUAGE: MANDATORY — Detect the language of the input text and produce ALL output "
	"in that EXACT same language. You are STRICTLY FORBIDDEN from translating or switching "
	"to any other language. Every single word of your output must be in the same language "
	"as the input. Do NOT output in a different language under any circumstance.\n\n"
	"SELECTIVITY — only long-term-worthy facts."
)
USER = (
	"Extract facts from the following chunk.\n\nChunk: 1/1\nEvent Date: Thursday\n"
	"Context: +context supplied with the document;\n\nContent:\n⟦the text being retained⟧"
)


class PromptSurgery(unittest.TestCase):
	def test_strip_language_rule_removes_rule_and_keeps_rest(self) -> None:
		stripped = bench.strip_language_rule(SYSTEM)
		self.assertNotIn("LANGUAGE: MANDATORY", stripped)
		self.assertIn("Extract SIGNIFICANT facts", stripped)
		self.assertIn("SELECTIVITY", stripped)

	def test_apply_output_language_appends_directive(self) -> None:
		pinned = bench.apply_output_language(SYSTEM, "English")
		self.assertNotIn("LANGUAGE: MANDATORY", pinned)
		self.assertIn("IMPORTANT: Respond exclusively in English.", pinned)
		self.assertTrue(pinned.rstrip().endswith("must be in English."))

	def test_strip_is_noop_without_rule(self) -> None:
		clean = "Just a prompt without any rule."
		self.assertEqual(bench.strip_language_rule(clean), clean)

	def test_substitute_document_replaces_placeholder_and_context(self) -> None:
		doc = "Operator: hello\nGoblin: hi there"
		out = bench.substitute_document(USER, doc, "Telegram exchange.")
		self.assertIn(f"Content:\n{doc}", out)
		self.assertNotIn("the text being retained", out)
		self.assertIn("Context: Telegram exchange.", out)
		self.assertIn("Chunk: 1/1", out)  # header survives intact


class OutputParsing(unittest.TestCase):
	def test_count_facts_list(self) -> None:
		ok, n = bench.count_facts(json.dumps([{"id": 1}, {"id": 2}]))
		self.assertTrue(ok)
		self.assertEqual(n, 2)

	def test_count_facts_dict_with_list_value(self) -> None:
		ok, n = bench.count_facts(json.dumps({"facts": [1, 2, 3], "other": "x"}))
		self.assertTrue(ok)
		self.assertEqual(n, 3)

	def test_count_facts_invalid_json(self) -> None:
		ok, n = bench.count_facts("not json at all {")
		self.assertFalse(ok)
		self.assertEqual(n, 0)


class LanguageDetection(unittest.TestCase):
	def test_cyrillic(self) -> None:
		self.assertEqual(bench.detect_language("Пользователю не нравится"), "ru")

	def test_spanish_markers(self) -> None:
		self.assertEqual(bench.detect_language("¿Cuándo vence la declaración?"), "es?")

	def test_english_default(self) -> None:
		self.assertEqual(bench.detect_language("The deploy finished on time"), "en?")


class Cells(unittest.TestCase):
	def test_default_cells_cover_the_decisions(self) -> None:
		names = [c.name for c in bench.DEFAULT_CELLS]
		self.assertEqual(names[0], "baseline")
		self.assertIn("langpin", names)
		self.assertIn("langpin+effort-low", names)
		self.assertIn("langpin+temp0", names)
		for cell in bench.DEFAULT_CELLS:
			if cell is not bench.DEFAULT_CELLS[0]:
				self.assertEqual(cell.output_language, "English")


class Fixtures(unittest.TestCase):
	def test_gold_queries_shape(self) -> None:
		queries = json.loads((bench.FIXTURES / "gold_queries.json").read_text())
		self.assertGreaterEqual(len(queries), 20)
		for q in queries:
			self.assertIn("q", q)
			self.assertIsInstance(q["gold"], list)
			self.assertTrue(q["gold"])

	def test_docs_shape(self) -> None:
		docs = json.loads((bench.FIXTURES / "docs.json").read_text())
		self.assertIn("en", docs)
		self.assertIn("es", docs)
		for doc in docs.values():
			self.assertTrue(doc["text"].strip())
			self.assertIn("context", doc)


if __name__ == "__main__":
	unittest.main()
