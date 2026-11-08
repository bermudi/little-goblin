# Code review harness — proposed

Logic handoff requested by the operator on 2026-11-07. Not implemented,
not an accepted runtime ruling, and not permission to select inference,
run paid reviews, change production, or merge code.

Source inspected: `6efff1f752aa8ec9429b373c2551dcf4242cbe99`.
Tracking issue: #189 (enhancement, P2, area:tools).
Project terms are defined in [`GLOSSARY.md`](../GLOSSARY.md).

## Purpose and boundary

Find actionable defects introduced by a change, including defects in
unchanged callers and consumers. Supply enough evidence to act without
trusting the reviewer's confidence.

Proposed first form: an on-demand, local Bun/TypeScript developer CLI.
It is not part of `goblin.service`, the app, or `src/reviewer.ts` (which
proposes skills). It does not fix code, run tests, create issues, push,
deploy, approve, or merge. Test execution and live verification remain
separate work under the existing process.

Borrow Greptile's mechanism: query relationships around a change instead
of reviewing isolated diff hunks. Do not adopt its claim of complete
understanding as a guarantee. The graph supplies leads, not proof.
No graph server, embeddings, generated architecture wiki, or agent fleet
is needed for the first version.

## Data contracts

Name these shapes before implementing the pipeline. Validate configuration,
model output, tool arguments, and persisted artifacts with zod.

| Shape | Required facts and invariants |
| --- | --- |
| Review request | Repository, explicit comparison mode, base/head refs, scope, operator-selected discovery and challenge runner/model (two distinct identities), and resource limits. No provider/model fallback. |
| Snapshot | Resolved base/head commit IDs and tree IDs, scope/config hash, analyzer version, compiler version, and dependency lock hash for each endpoint. No moving refs after capture. |
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

- Resolve refs once. Support direct endpoint comparison and an explicit
  fork-point comparison; record the actual merge base when used. Refuse
  an ambiguous fork point instead of choosing silently.
- Start with committed changes only. Refuse a dirty checkout so the
  operator cannot mistake the report for a review of unsaved work.
  A future dirty-tree mode needs its own content-addressed snapshot.
- Read diff, source, and policy from Git objects, not mutable worktree
  paths. Handle additions, deletions, renames, and changed file modes.
  Do not invoke Git external diff drivers, text converters, or hooks.
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

Keep a small, declarative flow registry: path/symbol anchors, connected
areas, and references to existing design clauses. It must not duplicate
the rules' prose or execute reviewed configuration as code. Validate
missing/stale anchors and show them as gaps.
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
Prove imports, aliases/re-exports, references, and TSX resolution with that
installed interface before choosing the extractor. The existing Babel
parser in `scripts/function-size-audit.ts` supplies syntax, not semantic
call resolution. Keep compiler-specific knowledge in one adapter.

Callbacks, interface dispatch, dynamic imports, event names, SQL names,
and persisted records can hide connections. Preserve unresolved sites.
Literal searches and the flow registry can add candidate/declared links,
but neither becomes a compiler-resolved call edge. Non-TypeScript changes
get explicit text/config review; do not claim a semantic graph for them.

Start with in-memory graphs rebuilt for the requested endpoints. Add
persistent caching only if measurements justify it. If added, syntax
can cache by blob/parser version; semantic edges must also include project,
resolution config, dependencies, and analyzer versions. Editing a callee
or export can invalidate edges in unchanged callers.

### 4. Select context by risk, not just distance

For each changed symbol or top-level statement:

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

One discovery session per unit, sequential by default. Supply the request,
trusted rules, unit context, and explicit gaps. Provide tools to read
snapshot ranges, search allowed snapshot text, resolve references, and
inspect declared flows. All reads return revision/path/line provenance;
the host records what was actually read.

Do not give the reviewer a shell, write tools, live application access,
ambient MCP tools, or arbitrary network access. The host may write only
its own cache and report artifacts. Enforce path and tool restrictions
outside the model. Repository text, comments, and returned snippets are
untrusted evidence, not instructions.

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
names the same identity for both passes is refused before inference.
A different model family is preferred over a sibling of the discovery
model; the operator chooses. This is a challenge pass, not a majority vote.

For each candidate, ask:

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
If there are no candidates, skip this inference step.

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
- Actual model/runner, calls, tokens, latency, and cost when known.
  Unavailable billing data is unknown, not zero.

Use “no supported findings in the assessed scope,” never “safe to merge.”
Complete means the declared review work finished; it is not a proof that
all bugs were found. A partial result with no findings must stay partial.
Operator merge authority is unchanged.

Write artifacts outside tracked source, with an explicit output path.
Use durable whole-file writes and a final manifest to identify a finished
report. Log stage transitions, model/tool boundaries, truncations, and
failures as JSONL on stderr, without source bodies or secrets. Do not
initialize Goblin's real home or runtime logger to run a developer review.

## Limits and failure behavior

Require explicit discovery and challenge runner/model configuration
before inference. Bound unit
count, source/context bytes, input/output tokens, tool calls, total calls,
and wall time. Money limits can apply only where usage/pricing supports
them. Reaching a limit produces partial coverage. Provider failure stays
failed/partial; no silent model substitution or open-ended retry.

Cache/resume identity includes snapshots, rules, analyzer, prompt,
both runner/models, and limits. Changed identity starts new work. Retain
completed unit results where safe, but never automatically repeat an
uncertain inference request as if it were known not to have happened.

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
  mutate source or reach live state.
- A deliberately partial zero-finding review cannot produce a clean result.

Frozen model responses test orchestration only. Separately run an
operator-authorized live evaluation on held-out historical defect/fix
pairs and clean changes, with fix commits, later tests, issue explanations,
and old audit answers hidden from review context. Score supported bug
recall, false findings, coverage, tokens, and latency against a diff-only
review using the same model and limits. Do not claim improvement until
that comparison has evidence.

## Decisions for the operator, not the implementer

Recommended starting branches of the decision tree, not settled choices:

1. **Entry: local on-demand CLI.** If automatic later, choose the
   event and inference allowance first; do not install hooks now.
2. **Inference: two explicit runner/models, one per pass.** Discovery
   and challenge use different models, each in fresh sessions. The
   operator supplies both identities and limits. More fan-out later
   needs measured benefit first.
3. **Output: local JSON + Markdown.** If GitHub or Goblin UI delivery
   later, agree publication/privacy rules and reuse existing owners.
4. **Judgment: advisory findings only.** Any future blocking policy
   needs acceptance criteria; a model verdict never grants merge authority.

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

Local reference inspected: `~/build/pi-mono/packages/coding-agent/`
`src/core/tools/index.ts` (`createReadOnlyTools`) and
`examples/sdk/05-tools.ts`. Borrowed: explicit read/search-only tool
selection and fresh session context. Do not infer filesystem confinement
from that tool list or add pi as a runtime dependency for this proposal.
