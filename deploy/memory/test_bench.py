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


class ScriptAndJudge(unittest.TestCase):
	def test_script_of_cyrillic_and_latin(self) -> None:
		self.assertEqual(bench.script_of("Пользователю не нравится"), "cyrillic")
		self.assertEqual(bench.script_of("plain english text"), None)

	def test_parse_judge_response(self) -> None:
		grade = bench.parse_judge_response('{"language": "EN", "confidence": 0.9, "coverage": [true, false]}')
		self.assertEqual(grade["language"], "en")
		self.assertEqual(grade["coverage"], [True, False])

	def test_lang_verdict_ok_and_mismatch_and_conflict(self) -> None:
		ok = bench.lang_verdict({"language": "en", "confidence": 1.0}, "en", "some latin text")
		self.assertTrue(ok["ok"])
		mismatch = bench.lang_verdict({"language": "ru", "confidence": 1.0}, "en", "some latin text")
		self.assertFalse(mismatch["ok"])
		conflict = bench.lang_verdict({"language": "en", "confidence": 1.0}, "en", "Пользователю не нравится")
		self.assertFalse(conflict["ok"])
		self.assertIn("script-conflict", conflict["note"])
		ungraded = bench.lang_verdict(None, "en", "whatever")
		self.assertIsNone(ungraded["ok"])

	def test_expected_language_pin_overrides_baseline(self) -> None:
		doc = {"expect_language_baseline": "es"}
		pinned = bench.Cell("langpin", 0.1, None, "English")
		baseline = bench.Cell("baseline", 0.1, None, None)
		self.assertEqual(bench.expected_language(pinned, doc), "en")
		self.assertEqual(bench.expected_language(baseline, doc), "es")


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

	def test_docs_curated_for_grading(self) -> None:
		docs = json.loads((bench.FIXTURES / "docs.json").read_text())
		self.assertIn("en", docs)
		self.assertIn("es", docs)
		for doc in docs.values():
			self.assertTrue(doc["text"].strip())
			self.assertIn("context", doc)
			expected = doc["expect_language_baseline"]
			self.assertIn(expected, {"en", "es"})
			assertions = doc["gold_assertions"]
			self.assertGreaterEqual(len(assertions), 3)
		for assertion in assertions:
			self.assertGreater(len(assertion), 20)


if __name__ == "__main__":
	unittest.main()
