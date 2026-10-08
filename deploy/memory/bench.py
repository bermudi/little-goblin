"""Benchmark the memory stack's two latency/quality surfaces without mutating it.

Two subcommands, both read-only against the live service:

  llm     — the retain (fact extraction) LLM leg. Renders the EXACT prompts and
            response schema the bank would send (via prompts/preview), then
            replays them against the configured LLM provider under a matrix of
            the sampling knobs hindsight exposes (temperature, reasoning
            effort, output language). No service restarts, no env edits: the
            output-language pin is simulated by performing upstream's own
            transformation on the rendered blocks (drop the preserve-source-
            language block, append the OUTPUT_LANGUAGE directive).

  recall  — the recall leg. Races embedding models on latency, and scores
            retrieval quality (hit@k / MRR) of a candidate model against the
            deployed one over the live bank and a gold-query fixture.

Spending: `llm` calls the paid extraction LLM and `recall` the embedding
provider. Both print a plan with an upfront cost estimate and require --yes.
API keys are read from hindsight.env into process memory only and never
printed, logged, or written to outputs.

Run: uv run deploy/memory/bench.py <llm|recall> [flags]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

FIXTURES = Path(__file__).parent / "bench_fixtures"
DEFAULT_API = "http://127.0.0.1:8888"
# Upstream's exact directive text (hindsight_api/engine/prompt_utils.py,
# output_language_directive) — replicated verbatim so the simulated pin is
# byte-faithful to what HINDSIGHT_API_LLM_OUTPUT_LANGUAGE would send.
OUTPUT_LANGUAGE_DIRECTIVE = (
	"\n\nIMPORTANT: Respond exclusively in {language}. "
	"Translate any source content into {language}. "
	"All output text — including fact text, observations, entity names, "
	"and the final response — must be in {language}."
)


def fail(message: str) -> None:
	print(f"bench: {message}", file=sys.stderr)
	sys.exit(1)


# ---------------------------------------------------------------------------
# hindsight.env — structure in, secrets stay in memory
# ---------------------------------------------------------------------------

def load_env(path: Path) -> dict[str, str]:
	env: dict[str, str] = {}
	for line in path.read_text().splitlines():
		line = line.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		key, _, value = line.partition("=")
		env[key.strip()] = value.strip().strip('"').strip("'")
	return env


# ---------------------------------------------------------------------------
# HTTP (stdlib, small)
# ---------------------------------------------------------------------------

def post_json(url: str, payload: dict | None = None, headers: dict[str, str] | None = None, timeout: float = 120.0):
	data = json.dumps(payload).encode() if payload is not None else None
	req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
	req.add_header("content-type", "application/json")
	for key, value in (headers or {}).items():
		req.add_header(key, value)
	with urllib.request.urlopen(req, timeout=timeout) as response:
		return json.loads(response.read().decode())


# ---------------------------------------------------------------------------
# Prompt surgery (pure — unit-tested)
# ---------------------------------------------------------------------------

@dataclass
class RenderedPrompts:
	system: str
	user: str
	response_schema: dict


def render_retain_prompts(api: str, bank: str) -> RenderedPrompts:
	body = post_json(f"{api}/v1/default/banks/{bank}/prompts/preview", {"operation": "retain"})
	messages = body["messages"]
	system = "".join(b["text"] for b in messages[0]["blocks"])
	user = "".join(b["text"] for b in messages[1]["blocks"])
	return RenderedPrompts(system=system, user=user, response_schema=body["response_schema"])


def strip_language_rule(system: str) -> str:
	"""Remove the preserve-source-language section (the pin's first half)."""
	start = system.find("LANGUAGE: MANDATORY")
	if start == -1:
		return system
	end = system.find("Do NOT output in a different language under any circumstance.", start)
	if end == -1:
		return system
	return (system[:start] + system[end + len("Do NOT output in a different language under any circumstance."):]).lstrip()


def apply_output_language(system: str, language: str) -> str:
	return strip_language_rule(system) + OUTPUT_LANGUAGE_DIRECTIVE.format(language=language)


_CONTENT_TAIL = re.compile(r"Content:\s*\n.*\Z", re.DOTALL)


# ---------------------------------------------------------------------------
# Grading: curated expectations + LLM judge, cross-checked by script.
# Script detection is exact for cross-script drift (Cyrillic cannot hide in
# Latin text) and is used ONLY as an agreement check on the judge — never as
# the grader. The judge is the configured LLM under a strict schema.
# ---------------------------------------------------------------------------

JUDGE_SYSTEM = (
	"You are a strict grader for a fact-extraction benchmark. You will receive "
	"a JSON extraction output and a list of gold assertions. Respond with JSON: "
	"{\"language\": <ISO 639-1 code of the DOMINANT language of the fact texts — "
	"judge the fact text values, not keys, entity names, or quoted foreign terms>, "
	"\"confidence\": <0.0-1.0>, \"coverage\": [<boolean per gold assertion: true only "
	"if some extracted fact conveys that assertion>]}. Be strict: a near-miss is "
	"false coverage."
)


def script_of(text: str) -> str | None:
	"""Exact script classification; None when Latin (uninformative for grading)."""
	if re.search(r"[\u0400-\u04FF]", text):
		return "cyrillic"
	if re.search(r"[\u4E00-\u9FFF\u3040-\u30FF]", text):
		return "cjk"
	return None


def parse_judge_response(text: str) -> dict:
	parsed = json.loads(text)
	language = str(parsed["language"]).lower().strip()[:2]
	confidence = float(parsed.get("confidence", 0.0))
	coverage = [bool(c) for c in parsed.get("coverage", [])]
	return {"language": language, "confidence": confidence, "coverage": coverage}


def expected_language(cell: Cell, doc: dict) -> str:
	"""Curated expectation: the pin forces English; baseline preserves source."""
	if cell.output_language is not None:
		return cell.output_language[:2].lower()
	return str(doc["expect_language_baseline"]).lower()


def lang_verdict(judge: dict | None, expected: str, output_text: str) -> dict:
	"""Combine judge + script cross-check into the graded language verdict."""
	if judge is None:
		return {"lang": None, "ok": None, "note": "ungraded"}
	script = script_of(output_text)
	conflict = (script == "cyrillic" and judge["language"] not in {"ru", "uk", "bg", "be", "sr", "mk"}) or \
		(script == "cjk" and judge["language"] not in {"zh", "ja"})
	ok = judge["language"] == expected and not conflict
	note = "ok" if ok else (f"judge={judge['language']} expected={expected}" if not conflict else f"script-conflict judge={judge['language']}")
	return {"lang": judge["language"], "ok": ok, "note": note}


def substitute_document(user: str, document: str, context: str) -> str:
	"""Replace the preview's fixed placeholder document with bench content."""
	user = _CONTENT_TAIL.sub(f"Content:\n{document}", user)
	user = re.sub(r"Context: .*", f"Context: {context}", user, count=1)
	return user


def judge_call(base_url: str, api_key: str, model: str, extraction_text: str, gold_assertions: list[str]) -> dict | None:
	"""Grade one extraction output. Returns None on any failure — the record is
	counted as ungraded, never as passed."""
	schema = {
		"type": "object",
		"properties": {
			"language": {"type": "string"},
			"confidence": {"type": "number"},
			"coverage": {"type": "array", "items": {"type": "boolean"}, "minItems": len(gold_assertions), "maxItems": len(gold_assertions)},
		},
		"required": ["language", "confidence", "coverage"],
	}
	payload = {
		"model": model,
		"messages": [
			{"role": "system", "content": JUDGE_SYSTEM},
			{"role": "user", "content": json.dumps({"output": extraction_text[:20000], "gold_assertions": gold_assertions})},
		],
		"response_format": {"type": "json_schema", "json_schema": {"name": "grade", "schema": schema, "strict": False}},
	}
	try:
		body = post_json(f"{base_url.rstrip('/')}/chat/completions", payload, headers={"authorization": f"Bearer {api_key}"})
		text = (body.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
		text = re.sub(r"^```(json)?\s*|\s*```$", "", text.strip())
		return parse_judge_response(text)
	except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
		print(f"  !! judge call failed ({type(error).__name__}: {str(error)[:120]}) — marking ungraded", file=sys.stderr)
		return None


# ---------------------------------------------------------------------------
# LLM leg
# ---------------------------------------------------------------------------

@dataclass
class Cell:
	name: str
	temperature: float
	reasoning_effort: str | None
	output_language: str | None

	def describe(self) -> str:
		return (
			f"{self.name}: temp={self.temperature} effort={self.reasoning_effort or 'unset'} "
			f"lang={self.output_language or 'source-preserve'}"
		)


DEFAULT_CELLS = [
	Cell("baseline", 0.1, None, None),  # today's effective config
	Cell("langpin", 0.1, None, "English"),
	Cell("langpin+effort-low", 0.1, "low", "English"),
	Cell("langpin+temp0", 0.0, None, "English"),
]
FULL_CELLS = DEFAULT_CELLS + [
	Cell("temp0", 0.0, None, None),
	Cell("langpin+effort-low+temp0", 0.0, "low", "English"),
]


def call_llm(base_url: str, api_key: str, model: str, prompts: RenderedPrompts,
             cell: Cell, extra_body: dict | None = None) -> dict:
	system = prompts.system if cell.output_language is None else apply_output_language(prompts.system, cell.output_language)
	payload: dict = {
		"model": model,
		"messages": [
			{"role": "system", "content": system},
			{"role": "user", "content": prompts.user},
		],
		"temperature": cell.temperature,
	}
	if cell.reasoning_effort:
		payload["reasoning_effort"] = cell.reasoning_effort
	if extra_body:
		payload.update(extra_body)
	modes = [
		{"type": "json_schema", "json_schema": {"name": "facts", "schema": prompts.response_schema, "strict": False}},
		{"type": "json_object"},
	]
	last_error = ""
	for mode in modes + [None]:
		if mode is not None:
			payload["response_format"] = mode
		else:
			payload.pop("response_format", None)
		try:
			start = time.perf_counter()
			body = post_json(
				f"{base_url.rstrip('/')}/chat/completions", payload,
				headers={"authorization": f"Bearer {api_key}"},
			)
			wall_ms = (time.perf_counter() - start) * 1000
			return {"wall_ms": wall_ms, "mode": mode["type"] if mode else "none", "body": body}
		except urllib.error.HTTPError as error:
			last_error = f"HTTP {error.code}: {error.read().decode()[:200]}"
	fail(f"LLM call failed in all response_format modes — {last_error}")
	raise AssertionError("unreachable")


def extract_usage(body: dict) -> tuple[int, int]:
	usage = body.get("usage") or {}
	return int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)


def count_facts(text: str) -> tuple[bool, int]:
	try:
		parsed = json.loads(text)
	except (json.JSONDecodeError, TypeError):
		return False, 0
	if isinstance(parsed, list):
		return True, len(parsed)
	if isinstance(parsed, dict):
		for value in parsed.values():
			if isinstance(value, list):
				return True, len(value)
		return True, 1
	return True, 1


def cmd_llm(args: argparse.Namespace) -> None:
	env = load_env(Path(args.env))
	api_key = env.get("HINDSIGHT_API_LLM_API_KEY")
	model = env.get("HINDSIGHT_API_LLM_MODEL")
	base_url = env.get("HINDSIGHT_API_LLM_BASE_URL", "https://openrouter.ai/api/v1")
	if not api_key or not model:
		fail("HINDSIGHT_API_LLM_API_KEY / HINDSIGHT_API_LLM_MODEL missing from hindsight.env")

	prompts_base = render_retain_prompts(args.api, args.bank)
	docs = json.loads((FIXTURES / "docs.json").read_text())
	cells = FULL_CELLS if args.full else DEFAULT_CELLS

	calls = len(cells) * len(docs) * args.reps
	print(f"plan: {len(cells)} cells x {len(docs)} docs x {args.reps} reps = {calls} LLM calls + {calls} judge calls")
	print(f"model: {model} @ {base_url} (judge: same model, structured grade)")
	for cell in cells:
		print(f"  - {cell.describe()}")
	print(f"prompt size: system={len(prompts_base.system)} chars, schema={len(json.dumps(prompts_base.response_schema))} chars")
	print("cost: unknown until first call; running total printed per call")
	if not args.yes:
		print("\n--yes not given: no calls made. Re-run with --yes to spend.")
		return

	results_path = Path(args.out) if args.out else None
	records: list[dict] = []
	total_tokens = 0
	for rep in range(args.reps):
		for doc_name, doc in docs.items():
			for cell in cells:
				prompts = RenderedPrompts(
					system=prompts_base.system,
					user=substitute_document(prompts_base.user, doc["text"], doc.get("context", "")),
					response_schema=prompts_base.response_schema,
				)
				out = call_llm(base_url, api_key, model, prompts, cell)
				text = (out["body"].get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
				prompt_tokens, completion_tokens = extract_usage(out["body"])
				total_tokens += prompt_tokens + completion_tokens
				ok, facts = count_facts(text)
				judge = None if args.no_judge else judge_call(base_url, api_key, model, text, doc["gold_assertions"])
				verdict = lang_verdict(judge, expected_language(cell, doc), text)
				if judge is not None and len(judge["coverage"]) == len(doc["gold_assertions"]):
					coverage_frac = sum(judge["coverage"]) / len(doc["gold_assertions"])
				else:
					coverage_frac = None
				record = {
					"cell": cell.name, "doc": doc_name, "rep": rep,
					"wall_ms": round(out["wall_ms"]), "mode": out["mode"],
					"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
					"parse_ok": ok, "facts": facts,
					"expected_language": expected_language(cell, doc),
					"judge_language": verdict["lang"], "lang_ok": verdict["ok"], "lang_note": verdict["note"],
					"judge_confidence": judge["confidence"] if judge else None,
					"coverage_frac": coverage_frac,
					"output": text[:4000],
				}
				records.append(record)
				cov = f"{coverage_frac:.0%}" if coverage_frac is not None else "n/a"
				print(
					f"  [{rep + 1}/{args.reps}] {cell.name:<24} {doc_name}: "
					f"{record['wall_ms']}ms {prompt_tokens}/{completion_tokens} tok "
					f"facts={facts} parse={'ok' if ok else 'FAIL'} lang={verdict['note']} cov={cov}"
				)

	print(f"\ntotal tokens: {total_tokens}")
	summarize(records)
	if results_path:
		results_path.write_text("\n".join(json.dumps(r) for r in records))
		print(f"raw records: {results_path}")


def summarize(records: list[dict]) -> None:
	print("\ncell                          n   wall p50   wall max  tok avg  parse  lang ok      cov avg")
	for name in dict.fromkeys(r["cell"] for r in records):
		rows = [r for r in records if r["cell"] == name]
		walls = sorted(r["wall_ms"] for r in rows)
		tok = statistics.mean(r["prompt_tokens"] + r["completion_tokens"] for r in rows)
		parse_rate = sum(1 for r in rows if r["parse_ok"]) / len(rows)
		graded = [r for r in rows if r["lang_ok"] is not None]
		lang_ok = sum(1 for r in graded if r["lang_ok"]) / len(graded) if graded else None
		covs = [r["coverage_frac"] for r in rows if r["coverage_frac"] is not None]
		cov_avg = statistics.mean(covs) if covs else None
		p50 = walls[len(walls) // 2]
		lang_cell = f"{lang_ok:.0%} ({len(graded)}/{len(rows)})" if lang_ok is not None else f"ungraded"
		cov_cell = f"{cov_avg:.0%} ({len(covs)}/{len(rows)})" if cov_avg is not None else "n/a"
		print(
			f"{name:<28} {len(rows):<3} {p50:<10} {walls[-1]:<9} {tok:<8.0f} {parse_rate:<6.1f} {lang_cell:<12} {cov_cell}"
		)


# ---------------------------------------------------------------------------
# Recall leg
# ---------------------------------------------------------------------------

def embeddings_via(url: str, auth: str, model: str, inputs: list[str], headers: dict[str, str] | None = None) -> list[list[float]]:
	body = post_json(url, {"model": model, "input": inputs}, headers={**(headers or {}), "authorization": f"Bearer {auth}"})
	ordered = sorted(body["data"], key=lambda d: d.get("index", 0))
	return [item["embedding"] for item in ordered]


def cosine_top_k(query: list[float], corpus: list[list[float]], k: int) -> list[int]:
	def norm(v: list[float]) -> list[float]:
		length = sum(x * x for x in v) ** 0.5 or 1.0
		return [x / length for x in v]
	qn = norm(query)
	scored = sorted(
		range(len(corpus)),
		key=lambda i: -sum(a * b for a, b in zip(qn, norm(corpus[i]))),
	)
	return scored[:k]


def cmd_recall(args: argparse.Namespace) -> None:
	env = load_env(Path(args.env))
	api_key = env.get("HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY")
	if not api_key:
		fail("HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY missing from hindsight.env")

	# --- latency race ---
	filler = (
		"hey, quick one — did we ever sort out the deploy for the memory stack? "
		"i recall we talked about swapping the embedding model and reindexing the bank. "
	)
	def sized(n: int) -> str:
		s = ""
		while len(s) < n:
			s += filler
		return s[:n]
	targets = [
		("deployed@openrouter", "https://openrouter.ai/api/v1/embeddings", api_key,
		 env.get("HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL", "voyageai/voyage-4-lite")),
		("candidate@ollama", "http://127.0.0.1:11434/v1/embeddings", "ollama", "embeddinggemma"),
	]
	print(f"latency race: {args.embed_reps} reps x sizes {args.sizes}, interleaved")
	if not args.yes:
		print("--yes not given: no calls made.")
		return
	for size in args.sizes:
		for name, url, auth, model in targets:
			walls: list[float] = []
			for _ in range(args.embed_reps):
				start = time.perf_counter()
				embeddings_via(url, auth, model, [sized(size)])
				walls.append((time.perf_counter() - start) * 1000)
			walls.sort()
			print(f"  {name:<24} size={size:<5} p50={walls[len(walls) // 2]:.0f}ms max={walls[-1]:.0f}ms")

	# --- quality A/B ---
	bank_facts = post_json(f"{args.api}/v1/default/banks/{args.bank}/memories/list?limit=200&offset=0", None)
	fact_items = [f for f in bank_facts["items"] if f.get("text")]
	queries = json.loads((FIXTURES / "gold_queries.json").read_text())
	print(f"\nquality A/B: {len(queries)} gold queries x {len(fact_items)} facts (corpus embedded with both models)")
	corpus_texts = [f["text"] for f in fact_items]
	scores: dict[str, dict[str, float]] = {}
	embeddings: dict[str, tuple[list[list[float]], list[list[float]]]] = {}
	for name, url, auth, model in targets:
		corpus = embeddings_via(url, auth, model, corpus_texts)
		queries_emb = embeddings_via(url, auth, model, [q["q"] for q in queries])
		embeddings[name] = (corpus, queries_emb)
		hit1 = hit5 = 0.0
		mrr = 0.0
		for qi, q in enumerate(queries):
			gold = {g[:8] for g in q["gold"]}
			ranking = [fact_items[i]["id"][:8] for i in cosine_top_k(queries_emb[qi], corpus, 10)]
			rank = next((i + 1 for i, fid in enumerate(ranking) if fid in gold), None)
			if rank == 1:
				hit1 += 1
			if rank is not None and rank <= 5:
				hit5 += 1
			if rank is not None:
				mrr += 1 / rank
		n = len(queries)
		scores[name] = {"hit@1": hit1 / n, "hit@5": hit5 / n, "MRR": mrr / n}
		print(f"  {name:<24} hit@1={hit1 / n:.2f} hit@5={hit5 / n:.2f} MRR={mrr / n:.3f}")

	deployed_name, candidate_name = targets[0][0], targets[1][0]
	overlap_sum = 0.0
	for qi in range(len(queries)):
		a = set(cosine_top_k(embeddings[deployed_name][1][qi], embeddings[deployed_name][0], 10))
		b = cosine_top_k(embeddings[candidate_name][1][qi], embeddings[candidate_name][0], 10)
		overlap_sum += len([i for i in b if i in a]) / 10
	print(f"  mean top-10 overlap: {overlap_sum / len(queries):.2f}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	sub = parser.add_subparsers(dest="command", required=True)

	llm = sub.add_parser("llm", help="retain LLM leg: replay real prompts under a knob matrix")
	llm.add_argument("--api", default=DEFAULT_API)
	llm.add_argument("--bank", default="goblin")
	llm.add_argument("--env", default=str(Path.home() / ".config/goblin-memory/hindsight.env"))
	llm.add_argument("--reps", type=int, default=5)
	llm.add_argument("--full", action="store_true", help="add the remaining cross-product cells")
	llm.add_argument("--yes", action="store_true", help="actually spend (paid LLM calls, incl. judge)")
	llm.add_argument("--no-judge", action="store_true", help="skip LLM grading (latency/tokens only)")
	llm.add_argument("--out", default=None, help="JSONL path for raw records")
	llm.set_defaults(func=cmd_llm)

	recall = sub.add_parser("recall", help="embedding latency race + retrieval quality A/B")
	recall.add_argument("--api", default=DEFAULT_API)
	recall.add_argument("--bank", default="goblin")
	recall.add_argument("--env", default=str(Path.home() / ".config/goblin-memory/hindsight.env"))
	recall.add_argument("--sizes", type=int, nargs="+", default=[150, 600, 2000])
	recall.add_argument("--embed-reps", type=int, default=8)
	recall.add_argument("--yes", action="store_true", help="actually spend (embedding calls)")
	recall.set_defaults(func=cmd_recall)

	args = parser.parse_args()
	args.func(args)


if __name__ == "__main__":
	main()
