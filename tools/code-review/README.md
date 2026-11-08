# goblin-code-review

On-demand, local code review for **pinned Goblin changes**. It reviews a
committed change between two Git refs, proposes candidate defects with a
discovery model, then tries to disprove every candidate with an
**independent challenge model**. The output is an evidence-backed report
(`report.json` + `report.md` + `manifest.json`) — never an approval.
Complete means the declared review work finished, not that all bugs were
found. A partial review with zero findings is **not** a clean result.

Design and rationale: [`design/code-review.md`](../../design/code-review.md).

## Status

Implemented end-to-end and covered by an offline test suite (stub smolagents
`Model`s; no inference calls, no network). Live provider inference has **not**
been exercised by this repository — run it yourself with your own keys.

## Requirements

- Python ≥ 3.10, Node ≥ 18 (for the TypeScript semantic worker), Git ≥ 2.30
- For semantic analysis: an endpoint-local TypeScript install. Use
  `--install-deps` to `npm ci`/`npm install` (install scripts disabled)
  inside the throwaway snapshot trees, with the endpoint's own lockfile.
  Without it, the review still runs but every semantic step is recorded as
  an explicit coverage gap (`UNRESOLVED`) — never as an empty result.
  Set `CODE_REVIEW_TYPESCRIPT=/path/to/typescript` (a package dir or its
  parent containing `node_modules`) to point the worker at an explicit
  install; endpoint-local `node_modules` is still tried first.
- smolagents 1.26.0, pydantic v2, PyYAML.

TypeScript 7.0.2 has **no** `tsc --lsp --stdio`; semantic resolution uses the
compiler's unstable async API (`typescript/unstable/async`) through
`worker/semantic_worker.mjs` — a minimal stdio JSON-RPC client, not smolagents.

## Install

```bash
cd tools/code-review
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

`.[dev]` is the offline test suite only — it does not install any
provider SDK. For live runs, also install the extra(s) matching your
providers: `.[litellm]`, `.[openai]`, `.[inference]`, or `.[all]`
(smolagents pinned to 1.26.0). The `litellm` extra additionally pins
`mcp`, which litellm imports eagerly whenever function tools are passed —
without it every discovery/challenge call fails at `model.generate`.

## Run

```bash
goblin-code-review review \
  --repo /path/to/repo \
  --base origin/main --head feature/my-change \
  --mode direct \                 # or fork-point (reviews merge-base..head)
  --discovery-provider litellm --discovery-model anthropic/claude-sonnet-4-5 \
  --challenge-provider openai   --challenge-model gpt-4o \
  --install-deps \
  --output /tmp/goblin-review
```

Model identities are explicit endpoint specs (`provider`, `model-id`,
`api-base`, `api-key-env`). There is **no implicit provider fallback**; if
the named model is unavailable the review fails or degrades to partial,
visibly. Discovery and challenge must be **distinct identities** — naming
the same model twice is refused before any inference call.

API keys come from environment variables; only the *name* of the variable
is recorded in artifacts, never the value. Defaults: `litellm`→`LLM_API_KEY`,
`openai`→`OPENAI_API_KEY`, `azure`→`AZURE_OPENAI_API_KEY`,
`inference`→`HF_TOKEN`; `bedrock` uses the standard boto3 credential chain.
Override with `--discovery-api-key-env` / `--challenge-api-key-env`.

Exit codes: `0` complete · `3` partial (findings possible, coverage incomplete) · `2` failed.

## What the harness guarantees

- **Host, not model, holds authority**: ref resolution, snapshot capture,
  exclusion, blob reads, budgets, deduplication, and artifact writing.
  Tools read only Git objects / pinned Base copies — never the working tree,
  never `DESIGN.md` from head-side, never the network.
- **Trust boundary**: repository text (code, comments, docs, commit
  messages) is evidence, not instruction. Head-side policy files are
  changes under review, never configuration.
- **Two distinct model identities**, and the challenge pass gets no
  discovery session memory — it argues from the snapshots alone.
- **Evidence before claims**: every finding cites `endpoint:path:lines`
  bound to a recorded blob ID; the host validates those locations against
  the captured trees.
- **Incomplete ≠ clean**: omitted context, unresolved relations, unsupported
  files, budget exhaustion, and unresolved challenge outcomes are all
  recorded in `coverage`, and any of them forces `status=partial`.
- **Prompt injection cannot widen anything**: the boundary is the host's
  tool confinement, not the prompt.

## Layout

```
src/code_review/
  contracts.py   pydantic v2 boundary models (request, units, results)
  gitio.py       scrubbed git plumbing (rev-parse, diff-tree, cat-file, archive)
  capture.py     ref resolution, dirty check, exclusion, snapshot materialization
  excludes.py    tracked-but-excluded paths (vendored trees, env files, ...)
  indexer.py     tsconfig sniffing, changed-symbol mapping, import edges, match_symbols
  semantic.py    Node worker client (open/index/references/calls)
  worker/semantic_worker.mjs  the tsgo-async TS bridge
  flows.yaml     declared-flow registry (routing hints, not policy)
  flows.py       registry load/validate/match
  policy.py      pinned Base policy loader + TRUST_BOUNDARY text
  tools.py       the four read-only review tools (confinement, budgets, provenance)
  units.py       hunk→symbol→review-unit builder (context with hard byte budget)
  agents.py      smolagents Model factory + typed final-answer gate
  pipeline.py    capture→policy→index→units→discover→challenge→report
  report.py      report.json / report.md / manifest.json (tmp+os.replace)
  cli.py         goblin-code-review
tests/           pytest suite (offline; stub Model drives the agents)
```

## Test

```bash
.venv/bin/python -m pytest -q
```

The suite is offline: a deterministic stub subclass of
`smolagents.models.Model` drives discovery/challenge through the real
smolagents loop, including tool calls and final-answer schema checks. The
TypeScript semantic path additionally requires an endpoint-local TS
install; it was verified against TypeScript 7.0.2 (`typescript/unstable/async`).

## Known limitations (v1)

- Model output is only as trustworthy as its schema check; a model that
  returns schema-valid but wrong JSON is indistinguishable from one that is
  right. Findings are *candidates with evidence*, not verdicts.
- The unstable TypeScript API provides no call hierarchy; call edges come
  from callee-identifier resolution and are marked `compiler-resolved` only
  for singleton declarations, `candidate` otherwise.
- Dependency installs use the endpoint's lockfile when present, else
  `npm install`; both with `--ignore-scripts`.
- One artifact directory per run; no resume/cache in v1.
- Live provider evaluation (held-out defect/fix pairs) is out of scope for
  this repository and must be run by an operator with their own keys.
