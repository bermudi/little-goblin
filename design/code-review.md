# Code review harness — proposed

Logic handoff requested by the operator on 2026-11-07; revised 2026-11-08
to specify Hugging Face's `smolagents` as the agent framework, per
operator instruction. Not implemented, not an accepted runtime ruling,
and not permission to select inference, run paid reviews, change
production, or merge code.

Source inspected: repository `6efff1f752aa8ec9429b373c2551dcf4242cbe99`;
smolagents source inspected at tag `v1.26.0` (cloned 2026-11-08).
Tracking issue: #189 (enhancement, P2, area:tools).
Project terms are defined in [`GLOSSARY.md`](../GLOSSARY.md).

## Purpose and boundary

Find actionable defects introduced by a change, including defects in
unchanged callers and consumers. Supply enough evidence to act without
trusting the reviewer's confidence.

Proposed first form: an on-demand, local Python developer CLI built on
the pinned `smolagents` library (`smolagents==1.26.0`, Apache-2.0,
Python ≥3.10). `smolagents` is Python-only, so adopting it moves the
harness out of the Bun/TypeScript toolchain; `goblin.service`, the app,
and all product code stay Bun + strict TypeScript (AGENTS.md). The
harness is a separate developer package (proposed: `tools/code-review/`),
not part of `goblin.service`, the app, or `src/reviewer.ts` (which
proposes skills). It does not fix code, run tests, create issues, push,
deploy, approve, or merge. Test execution and live verification remain
separate work under the existing process.

Borrow Greptile's mechanism: query relationships around a change instead
of reviewing isolated diff hunks. Do not adopt its claim of complete
understanding as a guarantee. The graph supplies leads, not proof.
No graph server, embeddings, generated architecture wiki, or agent fleet
is needed for the first version. Likewise borrow smolagents' mechanism —
agents whose only side effects are explicit tools — and no guarantee of
completeness, which smolagents does not make.

## Runtime and framework

`smolagents` supplies what the design needs and nothing else: a ReAct
agent loop, a tool boundary with argument-shape validation, model
adapters, and step-level accounting. Everything with authority stays in
the host.

- One Python ≥3.10 package, proposed at `tools/code-review/`, with its
  own `pyproject.toml` and hash-locked requirements (binary wheels only;
  install scripts never run). It is excluded from the app build, from
  `bun run typecheck`, and from `bun test`; its tests run under pytest.
- Runtime dependency: `smolagents==1.26.0` plus only the inference extra
  the operator selects — `smolagents[litellm]` (`LiteLLMModel`, 100+
  providers), `smolagents[openai]` (`OpenAIModel`, OpenAI-compatible
  servers), or neither if the operator configures `InferenceClientModel`
  (HF Inference Providers), `AmazonBedrockModel`, `AzureOpenAIModel`, or
  a local `TransformersModel`/`VLLMModel`/`MLXModel`. No `toolkit` extra,
  no default tools. `pydantic` v2 validates contracts.
- TypeScript semantic resolution is not smolagents' job and nothing from
  its dependency tree is used for it: the host drives the materialized
  endpoint's own installed compiler through its unstable async API
  (`typescript/unstable/async`, the tsgo toolchain) via a minimal in-repo
  Node worker over stdio JSON-RPC — there is no `tsc --lsp --stdio` in
  TypeScript 7.x. See section 3.
- Git access is the host's, via plumbing subprocesses (`rev-parse`,
  `diff-tree`, `cat-file --batch`, `archive`) with a scrubbed
  environment. smolagents has no Git knowledge.

The host keeps authority over everything stateful: ref resolution,
snapshot capture, exclusions, the graph, hunk-to-symbol mapping,
review-unit construction, budgets, artifact writing, report generation,
and both model identities. Agents are invoked for exactly two inference
stages — candidate discovery per review unit, and the per-candidate
challenge pass — the same two stages the pipeline always had, expressed
as smolagents sessions.

## Data contracts

Name these shapes before implementing the pipeline. Validate configuration,
model output, tool arguments, and persisted artifacts with pydantic v2.
Note the division of labor: smolagents checks tool-call arguments against
each tool's declared `inputs` schema (`validate_tool_arguments`), which is
type-shape checking only, and treats a `Tool`'s `output_schema` as
informational — it validates nothing. Real confinement, byte/line caps,
and every output check live in the host: inside each tool's `forward()`,
in a `final_answer_checks` callable, and again at the report boundary.

| Shape | Required facts and invariants |
| --- | --- |
| Review request | Repository, explicit comparison mode, base/head refs, scope, operator-selected discovery and challenge runner/model (two distinct identities, given as smolagents model specs), and resource limits. No provider/model fallback. |
| Snapshot | Resolved base/head commit IDs and tree IDs, scope/config hash, analyzer version (host, smolagents, pydantic, semantic worker), Python version, compiler version, and dependency lock hash for each endpoint. No moving refs after capture. |
| Location | Endpoint, repository-relative path, blob ID, and line range. A location always names bytes from one snapshot, never the current checkout by accident. |
| Relationship | Source/target identities, relation kind, evidence location, and basis: compiler-resolved, explicitly declared, or candidate. Resolution describes a static relation, not proof of runtime execution. |
| Review unit | Changed symbols/hunks, relevant relationships, applicable design clauses, required context, requested/read sources, and unresolved or omitted context. Every in-scope hunk has a unit. |
| Candidate | Changed cause, triggering input/order, affected execution path, violated contract, observable consequence, and supporting locations. An untested claim stays untested. |
| Finding | A supported candidate, severity with rationale, exact change attribution, evidence, and the result of the attempt to disprove it. |
| Review result | Discriminated union: complete, partial with explicit gaps, or failed with the failed stage/cause. Findings can accompany a partial result. Applicability to a later checkout is separate from completion. |

Symbol identities are snapshot-scoped. Match base/head declarations by
rename mapping, exported name, enclosing declaration, and structural
evidence; ambiguous matches remain ambiguous. Do not identify symbols by
their name or line number alone.

## Pipeline

```text
explicit Git comparison
    → capture immutable endpoints
    → load trusted rules and declared flows
    → index both endpoints
    → map hunks to symbols and contracts
    → build bounded review units
    → discover candidate defects
    → try to disprove each candidate in a fresh session
    → validate evidence, deduplicate, and report coverage
```

### 1. Capture exactly what is being reviewed

- The host, never an agent, performs capture. Resolve refs once. Support
  direct endpoint comparison and an explicit fork-point comparison;
  record the actual merge base when used. Refuse an ambiguous fork
  point instead of choosing silently.
- Start with committed changes only. Refuse a dirty checkout so the
  operator cannot mistake the report for a review of unsaved work.
  A future dirty-tree mode needs its own content-addressed snapshot.
- Read diff, source, and policy from Git objects, not mutable worktree
  paths (`git archive`, `git cat-file --batch`, never `checkout`,
  `switch`, `clean`, or porcelain). Handle additions, deletions, renames,
  and changed file modes. Do not invoke Git external diff drivers, text
  converters, hooks, or textconv. Plumbing runs with a scrubbed
  environment (`GIT_CONFIG_NOSYSTEM=1`, no user/global/system config
  that can redirect objects, hooks, or filters).
- The TypeScript semantic worker (section 3) reads files from disk, so materialize
  each endpoint into a throwaway, host-owned tree written from its Git
  objects (never the operator's checkout or a linked worktree). Trees live under a
  `0700` host-owned temp dir. Install dependencies there from that
  endpoint's lockfile with install scripts disabled and no network
  beyond the package cache; a failed or incomplete install is a coverage
  gap. Locations still cite blob IDs, not tree paths. Delete the trees
  when the review finishes or fails.
- Index allowed tracked source and configuration. Exclude live homes,
  auth material, environment files, generated assets, vendored trees,
  and dependency contents from model context. Never follow a tracked
  symlink outside the captured source set. Apply exclusions before reading
  diff bodies; report excluded sensitive-file changes by path only.
- At completion, report whether the requested refs or checkout changed.
  The captured review remains valid for its recorded endpoints, not
  automatically for the new code.

### 2. Establish intent without inventing a second specification

Read `AGENTS.md`, `DIRECTION.md`, `DESIGN.md`, and relevant `design/`
sections. Use `ROADMAP.md` for implementation/verification status, not
as blanket authorization. Existing audit findings are historical leads:
re-check them against the captured code.

Use operator-supplied harness policy and the pinned base policy as the
trusted instruction source. Head-side policy edits are changes to review;
they cannot grant tools, remove safety restrictions, or disable checks
for their own diff. Surface a real policy/direction conflict as a question.

The trusted policy text reaches the agents through smolagents'
`instructions=` parameter (inserted into the system prompt by the
default templates) or a pinned in-repo `prompt_templates` override —
never by concatenation into tool output. Keep templates in the harness
package; do not pull prompts from the Hub.

Keep a small, declarative flow registry: path/symbol anchors, connected
areas, and references to existing design clauses. It must not duplicate
the rules' prose or execute reviewed configuration as code. Validate it
with pydantic at load; missing/stale anchors and show them as gaps.
Useful initial entries, grounded in the inspected tree:

| Changed area | Context that must also be considered |
| --- | --- |
| Turn admission, tools, or delivery | Runtime ownership/epoch checks, resume/journal behavior, channel delivery; `DESIGN.md`, `design/runtime-turn.md`, `design/model.md`. |
| Responsibility, scheduler, observer, or wakes | Producer → persisted event → commit-time authority check → delivered meaning; `design/programs.md`. |
| Config or app wire types | Server schema, `src/http/app-config.ts`, app settings consumers, and both TypeScript programs; `design/app.md`. |
| Auth or an external adapter | Boundary validation, owning adapter, consumers, pinned fixtures, and any gated live-contract evidence; the area's design file. |
| Durable storage | Readers/writers, transactions or whole-file replacement, restart/recovery paths, and failure propagation; `DESIGN.md`. |

These are routing hints. A failed lookup or unclear connection is not
permission to invent a relationship.

### 3. Build an honest graph at both endpoints

Index files, declarations, exports/re-exports, imports (including
type-only), symbol references, statically resolvable calls, and type uses.
Keep test relationships as context, but do not equate importing a symbol
with asserting its behavior.

Use semantic resolution for aliases and cross-file symbols, with both
`tsconfig.json` and `app/tsconfig.json`. Preserve project identity where
one file appears in both programs. Resolve dependency types locally;
do not send dependency trees to the model. A missing or incompatible
dependency environment is a coverage gap, not a silent substitution.

**Implementation prerequisite:** this checkout pins TypeScript `7.0.2`.
Its root export is not the old compiler API; its installed package exposes
`typescript/unstable/sync`, `typescript/unstable/async`, and AST subpaths.
Get semantic relations from the installed compiler's unstable async API
(what operators may informally call `tsgo --api`), not from a language
server: TypeScript 7.0.2 has no `tsc --lsp --stdio`. The API does not
guarantee stability across compiler upgrades, so the client is a minimal
in-repo Node worker (`tools/code-review/worker/semantic_worker.mjs`)
driven over stdio with length-prefixed JSON messages, one worker per
endpoint and TypeScript program — not a general-purpose LSP/framework
dependency, and not smolagents. Prove open/index/references through that
worker before building on it; an unanswerable request — unknown method,
error response, timeout — is a coverage gap. The unstable API provides
program-wide references (`getReferencedSymbolsForNode`) and symbol
lookup (`getSymbolAtPosition`) but no call hierarchy: call edges come
from resolving callee identifiers at call sites (compiler-resolved when
the callee has a singleton declaration, candidate otherwise), and import
aliases resolve through `getAliasedSymbol` to the real declaration. The
existing Babel parser in `scripts/function-size-audit.ts` supplies syntax,
not semantic call resolution. Keep compiler-specific knowledge in one
adapter (the worker + `code_review.semantic`/`code_review.indexer`).

Callbacks, interface dispatch, dynamic imports, event names, SQL names,
and persisted records can hide connections. Preserve unresolved sites.
Literal searches and the flow registry can add candidate/declared links,
but neither becomes a compiler-resolved call edge. Non-TypeScript changes
get explicit text/config review; do not claim a semantic graph for them.

Start with in-memory graphs rebuilt for the requested endpoints
(adjacency maps of dataclasses; no persistence, no external services).
Add persistent caching only if measurements justify it. If added, syntax
can cache by blob/parser version; semantic edges must also include project,
resolution config, dependencies, and analyzer versions. Editing a callee
or export can invalidate edges in unchanged callers.

### 4. Select context by risk, not just distance

Review units are built by the host; agents never choose or expand their
own scope. For each changed symbol or top-level statement:

1. Include its before/after code, not just the edited lines.
2. Follow immediate callers/references, callees, and type/schema users
   in both endpoint graphs. A removed caller exists only in the base.
3. Follow the declared flow through the relevant boundary, state owner,
   or side effect. A persisted event can matter more than a nearby import.
4. Include applicable design clauses, existing tests, and a small number
   of sibling implementations when they clarify a real contract.
5. Group overlapping context into review units; split oversized units
   without losing hunk ownership or cross-unit connections.

Do not expand every central utility to the whole repository. Rank paths
that cross changed contracts, external boundaries, authority checks,
durable state, async ownership, or public app/server schemas.

Required context that exceeds the budget makes the unit partial.
Never silently clip it and call the review complete. Record unselected
branches too; bounded impact search is not exhaustive impact analysis.

### 5. Discover defects with bounded, read-only tools

One discovery session per unit, as a fresh `ToolCallingAgent`, sequential
by default. Supply the request, trusted rules, unit context, and explicit
gaps. All reads return revision/path/line provenance; the host records
what was actually read.

Give the reviewer exactly four read-only tools, implemented by the host
as `smolagents.Tool` subclasses. `forward()` enforces the confinement and
the budget; the model sees only schema-derived descriptions:

| Tool | Backing store | Returns |
| --- | --- | --- |
| `read_snapshot_range` | `git cat-file` on the recorded blob ID | Line range + provenance |
| `search_snapshot` | Host scan over the allowed source set (literal/regex, capped hits/bytes) | Matches + provenance |
| `resolve_references` | The endpoint's TypeScript via the unstable async API worker (document symbols, definition with alias resolution, program-wide references, callee call edges; no call hierarchy) | Locations + basis (`compiler-resolved`/`candidate`) |
| `inspect_declared_flow` | Flow registry + captured blobs | Anchors, clauses, or an explicit miss |

Tool `inputs` use smolagents' `string`/`integer` types; arguments are
type-checked by smolagents and then re-checked host-side (path
normalization, endpoint must be `base` or `head`, reject absolute paths
and `..` escapes, reject any path outside the captured source set,
never follow tracked symlinks out of it). Every tool response is framed
with its provenance header, and each tool appends to the per-unit read
log (tool, endpoint, path, blob ID, lines, bytes) that the report
summarizes. The host — not the model — owns this log.

Do not give the reviewer a shell, write tools, live application access,
ambient MCP tools (`ToolCollection.from_mcp` is not used), Hub tools
(`Tool.from_hub` and `ToolCollection` are not used), or arbitrary network
access (no `toolkit` extra, so no web-search/page tools exist to leak
in). Construct the agent with `add_base_tools=False` (only the built-in
`final_answer` tool is added). The host may write only its own cache and
report artifacts. Repository text, comments, and returned snippets are
untrusted evidence, not instructions; the review prompt says so, and the
tool boundary is what actually enforces it.

Do not use `CodeAgent` for v1. Model-written Python runs in
`LocalPythonExecutor`, an allowlisted-import interpreter that caps loops
and blocks `os.system` but is not a filesystem or resource confinement
boundary, and the remote executors (`e2b`, `docker`, `modal`, `blaxel`)
move review execution onto third-party sandbox/network services, which
is neither local-first nor needed for four read-only tools. If a later
version wants code-mode review, that is an operator decision with its
own budget and vendor ruling. Do not use smolagents' managed agents or
sub-agent fleets: the host is the only orchestrator.

Agent configuration per unit:

- `model`: the operator-configured discovery model, built by the host's
  model factory (any smolagents model class above). SDK-level retries
  are disabled (e.g. OpenAI client `max_retries=0`) so provider failure
  stays failed/partial and is never silently retried.
- `tools`: the four above and nothing else.
- `instructions`: the trusted review policy and the unit's scope.
- `max_steps`: per-unit step cap from the operator's limits (hard
  ceiling recommended: 12; a simple unit should use far fewer).
- `max_tool_threads=1`, `planning_interval=None`, `verbosity_level=OFF`,
  `return_full_result=True` (so the host gets `RunResult` with per-step
  `token_usage`, `timing`, and `state`).
- `step_callbacks={ActionStep: [...], PlanningStep: [...],
  FinalAnswerStep: [...]}`: the host's JSONL-stderr logger (stage,
  model/tool boundaries, counts — no source bodies, no secrets) and the
  budget enforcer. The enforcer sums tokens and wall time across steps
  and raises `BudgetExhausted` past the unit ceiling; the exception
  propagates out of the agent loop (step callbacks run in `_finalize_step`,
  inside the loop's `finally`, so raising there aborts the run) and the
  host records the unit as partial with the budget named. The deadline
  applies between steps; it cannot interrupt an in-flight model call.
- `final_answer_checks=[schema_check]`: `schema_check(final_answer,
  memory, agent)` parses the answer as the candidates payload (pydantic,
  strict) and fails otherwise. smolagents treats a failed check as a step
  error and lets the agent try again, bounded by `max_steps`; the host
  re-validates after the run and never trusts the check alone. Invalid
  output fails the unit visibly; there is no unbounded repair loop.

Provider or tool errors inside the loop (`AgentError`) are shown to the
model as the next observation; that is smolagents' ReAct design. The
host bounds the blast radius with `max_steps`, the token ceiling, and the
read log — it does not parse the model's reasoning for safety.

An agent that exhausts `max_steps` yields `RunResult.state ==
"max_steps_error"`; the unit is partial, never complete on unverified
output. Token usage is summed from per-step `token_usage`; if the
provider reports none, usage is recorded as unknown, not zero, and the
wall-time and step caps are the only enforced ceilings. smolagents
enforces no wall-clock, byte, or cost limit by itself — those live in
the host.

Review questions specific to Goblin:

- Can stale ownership survive an `await` and still cause a side effect?
- Can a crash, retry, or uncertain send duplicate or lose an effect?
- Can an error become success, missing state, or a silent fallback?
- Can external input bypass its owning adapter or validation?
- Can prompt assembly rewrite a prefix outside a sanctioned boundary?
- Can server/config changes break the other client entry or misstate
  worker claims, checked evidence, or completion?

Emit structured candidates only. No style, speculative scale advice,
or feature requests. Pattern inconsistency is a search lead; report it
only when it causes a concrete defect or breaches an explicit contract.
A deliberate, still-applicable design tradeoff is not a defect. A change
that invalidates its assumptions can be.

### 6. Try to disprove before publishing

Use a fresh session with candidates and source access, without the
author's conversation or the discovery session's persuasive reasoning.
It uses a different, explicitly configured runner/model from discovery,
so the two passes do not share one model's blind spots. A request that
names the same identity for both passes is refused before inference
(same model class + `model_id` + endpoint base). A different model
family is preferred over a sibling of the discovery model; the operator
chooses. This is a challenge pass, not a majority vote.

Per candidate, the host constructs a fresh `ToolCallingAgent` — same
four read-only tools, no discovery prompt, no discovery memory — with a
fixed in-repo challenge prompt carrying only the candidate and these
questions:

1. Is the cited code present at the stated endpoint and location?
2. Does the proposed input/order reach this path through real callers?
3. Is validation, fencing, transactionality, or recovery already provided
   elsewhere?
4. Is the defect introduced or made reachable by this change? What
   differs at the base?
5. Does the claimed consequence follow? Is the alleged contract current?

Return supported, disproved, or unresolved, with evidence. The host checks
locations against blobs and validates output shape; valid citations alone
do not establish a bug. Unresolved paths remain visible gaps, not findings.
If there are no candidates, skip this inference step — construct
no agents at all. Configure the challenge agent exactly like a discovery
agent (low `max_steps`, `max_tool_threads=1`, `return_full_result=True`,
JSONL callbacks, budget enforcer); its token/wall-time spend is recorded
against the same limits.

Deduplicate supported candidates by changed cause and violated contract,
not by similar wording. Different consequences can share one finding.
Keep rejected-candidate reasons in local artifacts for inspection.

### 7. Report findings and limits separately

Produce machine-readable JSON and Markdown from the same validated result:

- Exact endpoints, mode, scope, analyzer/config identity, and applicability.
- Ranked findings: changed cause, trigger, execution path, consequence,
  violated contract, base/head evidence, and disproof-pass result.
- Severity based on material consequence and a realistic trigger,
  separate from strength of evidence. Do not substitute a confidence
  score for the failure path.
- Evidence level: code-traced versus externally reproduced. Include test
  or CI results only if actually supplied and bound to the exact commit;
  an existing test file or a model claim is not a passing check.
- Coverage: hunks/units assessed, sources read, unresolved relations,
  omitted context, unsupported files, budget exhaustion, and failures.
- Known pre-existing defects, if noticed, separated from change findings.
  No automatic issue creation or learning permanent rules from dismissal.
- Actual model/runner, calls, tokens, latency, and cost when known. Per
  unit, record the `RunResult` facts (model class and ID, step count,
  input/output tokens or unknown, timing, `state`). Unavailable billing
  data is unknown, not zero.

Use “no supported findings in the assessed scope,” never “safe to merge.”
Complete means the declared review work finished; it is not a proof that
all bugs were found. A partial result with no findings must stay partial.
Operator merge authority is unchanged.

Write artifacts outside tracked source, with an explicit output path.
Use durable whole-file writes and a final manifest to identify a finished
report. Log stage transitions, model/tool boundaries, truncations, and
failures as JSONL on stderr, without source bodies or secrets; API keys
come from the environment only — never from argv, never into logs. Do not
initialize Goblin's real home or runtime logger to run a developer review.
smolagents' own console logger (`AgentLogger`, rich-based) is replaced
by the JSONL callbacks above (`verbosity_level=OFF`), and its Hub
serialization helpers (`serialization.py`, `push_to_hub`) are never used:
no agent, tool, or report leaves the machine.

## Limits and failure behavior

Require explicit discovery and challenge runner/model configuration
before inference. Bound unit count, source/context bytes, input/output
tokens, tool calls, total calls, and wall time. Money limits can apply
only where usage/pricing supports them. Reaching a limit produces
partial coverage. Provider failure stays failed/partial; no silent model
substitution or open-ended retry.

| Limit | Enforcement |
| --- | --- |
| Unit count, total calls | Host |
| Steps per unit / per candidate | Agent `max_steps` |
| Per-unit wall time | Step callback deadline (between steps) |
| Input/output tokens | Step callback accounting; unknown-usage models fall back to step/byte caps, recorded as unknown |
| Tool calls per unit | Tool-side counter |
| Bytes returned to the model | Tool-side byte counter; host-side context builder for the unit itself |
| Provider retries | Disabled at the SDK (e.g. `max_retries=0`); failures surface as failed/partial |

Cache/resume identity includes snapshots, rules, analyzer (host,
smolagents, pydantic, semantic worker, Python version), prompt templates,
both runner/models, and limits. Changed identity starts new work. Retain
completed unit results where safe, but never automatically repeat an
uncertain inference request as if it were known not to have happened.
Unit results cache on disk by that identity; smolagents' own
serialization machinery is not part of the cache.

## Acceptance evidence for the implementation

Use small public fixtures and frozen real Git ranges, not production state:

- Re-export/alias changes find affected unchanged callers; deleted symbols
  and removed callers remain discoverable from the base.
- Callback/durable-event relations are labeled declared/candidate;
  unresolved targets cannot become an empty, supposedly complete graph.
- A config/schema change reaches both server and app consumers.
- A seeded stale-authority defect reaches its producer, stored event, and
  dispatch check. An existing downstream guard defeats a false candidate.
- Renames and ref movement retain correct evidence locations; cache
  invalidation cannot reuse stale caller edges.
- Invalid model output, path traversal, external symlinks, prompt injection,
  missing dependencies, and budget exhaustion fail visibly and never
  mutate source or reach live state. Prompt injection is tested with
  repository text that orders the agent to grant itself tools or read
  outside the source set — it must have no effect, because the boundary
  is the host, not the prompt.
- A deliberately partial zero-finding review cannot produce a clean result.
- Naming the discovery model for both passes is refused before any
  inference call; a frozen-response run records two distinct model
  identities in the report.
- The challenge pass receives the candidates and snapshot access but not
  the discovery session's memory or reasoning.
- An agent reaching `max_steps` reports `max_steps_error` and the unit is
  partial; token usage is present or explicitly unknown, never assumed.
- TypeScript semantic worker: aliases/re-exports/references/callee call
  edges resolve through the endpoint's own compiler for both programs;
  an unanswerable request is a coverage gap, not an empty result.
- Frozen model responses test orchestration only: a deterministic stub
  subclass of `smolagents.models.Model` returning canned `ChatMessage`s
  drives the agents offline. Separately run an operator-authorized live
  evaluation on held-out historical defect/fix pairs and clean changes,
  with fix commits, later tests, issue explanations, and old audit
  answers hidden from review context. Score supported bug recall, false
  findings, coverage, tokens, and latency against a diff-only review
  using the same model and limits. Do not claim improvement until
  that comparison has evidence.

## Decisions for the operator, not the implementer

Recommended starting branches of the decision tree, not settled choices:

1. **Entry: local on-demand CLI.** If automatic later, choose the
   event and inference allowance first; do not install hooks now.
2. **Inference: two explicit runner/models, one per pass.** Discovery
   and challenge use different models, each in fresh sessions. The
   operator supplies both identities, the provider classes (LiteLLM,
   OpenAI-compatible, Bedrock/Azure, or local), and limits. More fan-out
   later needs measured benefit first.
3. **Output: local JSON + Markdown.** If GitHub or Goblin UI delivery
   later, agree publication/privacy rules and reuse existing owners.
4. **Judgment: advisory findings only.** Any future blocking policy
   needs acceptance criteria; a model verdict never grants merge authority.
5. **Runtime consequence of smolagents, recorded not reopened:** the
   harness is Python beside the Bun product. It needs a carve-out the
   repo does not have yet (`tools/code-review/`, pytest in its own
   package, excluded from typecheck/test/app build). Adopting smolagents
   necessarily accepts that; if the Python boundary ever becomes the
   measured bottleneck, that reopens the framework decision, not just an
   optimization ticket.

Implementation belongs to its own issue and branch. This handoff creates
neither a runtime feature nor an obligation to build every later option.

## Mechanism sources

Greptile docs fetched on 2026-11-07, index first:

- Index: `https://www.greptile.com/docs/llms.txt`.
- Graph-based Codebase Context:
  `https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context.md`.
  Borrowed: relationship-based context and impact lookup.
- Knowledge Base:
  `https://www.greptile.com/docs/how-greptile-works/knowledge-bases.md`.
  Borrowed: area/flow context alongside source. Goblin's existing design
  documents remain the specification; no generated competing wiki.

smolagents source inspected at tag `v1.26.0` (2026-05-29, Apache-2.0,
Python ≥3.10), local clone made 2026-11-08:

- Repository: `https://github.com/huggingface/smolagents`
  (`src/smolagents/{agents,tools,models,memory,monitoring,local_python_executor,remote_executors}.py`).
  huggingface.co docs were not reachable from the authoring sandbox; the
  pinned source tree is the reference for this proposal. Implementers
  should also read the published docs at `https://huggingface.co/docs/smolagents`.
- Borrowed: `ToolCallingAgent` (structured tool calls in a ReAct loop)
  for both passes; host-implemented `Tool` subclasses as the only tool
  boundary; `final_answer_checks` for a bounded final-answer gate;
  `step_callbacks` + `RunResult`/`Monitor` for JSONL logging and token
  accounting; `Model` subclasses (`LiteLLMModel`, `OpenAIModel`,
  `InferenceClientModel`, `AmazonBedrockModel`, `AzureOpenAIModel`,
  `TransformersModel`/`VLLMModel`/`MLXModel`) for the two explicit
  runner/model identities; in-repo `prompt_templates`/`instructions` for
  the trusted policy.
- Not adopted: `CodeAgent` and `LocalPythonExecutor` (allowlisted-import
  interpreter, not a confinement boundary); remote executors (`e2b`,
  `docker`, `modal`, `blaxel` — third-party sandbox/network); default
  tools and the `toolkit` extra (web search/webpage); Hub tools and
  collections (`Tool.from_hub`, `ToolCollection.from_hub`); MCP
  (`ToolCollection.from_mcp`) — Goblin's product uses `mcporter`, the
  harness must not inherit it; managed agents and sub-agent fleets;
  `add_base_tools`; `serialization.py`/`push_to_hub` (no Hub publication
  of agents or reports); `gradio_ui`; streaming/`generate_stream`
  (offline CLI, unneeded).
- Not provided by smolagents, and therefore built by the host: Git
  capture, exclusions, both endpoint graphs, hunk→symbol mapping, review
  units, path confinement, byte/line budgets, wall-clock limits, cost
  accounting, JSONL-on-stderr logging, artifact writing, the report, and
  the cache/resume identity. smolagents is the agent loop and the tool
  protocol — nothing else about this design comes from it.

Local reference inspected: `~/build/pi-mono/packages/coding-agent/`
`src/core/tools/index.ts` (`createReadOnlyTools`) and
`examples/sdk/05-tools.ts`. Borrowed: explicit read/search-only tool
selection and fresh session context. Do not infer filesystem confinement
from that tool list. pi is not a runtime dependency of this proposal;
smolagents is, per the 2026-11-08 revision.
