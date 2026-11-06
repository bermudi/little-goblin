# Comparative mechanics review — prompt

Paste into a fresh session opened at the goblin repo root. Read-and-report
only. Report lands in `audit/reference-review-2026-10-31.md`.

---

You are reviewing goblin v2, this repo: a one-operator personal AI agent.
Bun + strict TypeScript, one process, two channels — Telegram (grammy
long-polling, topics, mini apps) and a React app speaking the Vercel AI SDK
UIMessage protocol over the process's own HTTP surface. SQLite (WAL) machine
state. Prod runs from immutable releases on the operator's homelab.
Read-and-report only: you find weaknesses and name better designs; you
change nothing.

This is not a bug hunt and not a spec-compliance pass — both are done
(Prior work below). Your job is comparative. goblin's founding rule is to
borrow *mechanisms, never scope* from three mature local agents, and all
three trees are on this machine. Read them; do not rely on memory of them.

Reference maps — orient in each before judging goblin:

- `~/build/testing/openclaw/` — TypeScript, a multi-channel personal agent
  run at real scale. Core in `src/`: `channels/`, `context-engine/`,
  `cron/`, `daemon/`, `agents/`. `apps/` is mobile clients and `crates/`
  is the Rust node host — skip both unless directly relevant.
- `~/build/testing/hermes-agent/` — Python (Nous). Core in `agent/` (flat
  modules; note the auxiliary-model fallback family), `cron/`,
  `acp_adapter/`.
- `~/build/pi-mono/` — the pi coding agent monorepo: `packages/agent`, `ai`,
  `chord`, `codemode`, `coding-agent`, `durable`, `mcp`, `orchestrator`.
  Also goblin's vendor: the `@earendil-works/pi-*` dependencies in
  `package.json` come from here, so pi-mono doubles as the
  intended-usage reference for those packages.

If your sandbox cannot read outside this repo, say so in the report header
and fall back to training-data knowledge of these projects — but label every
such reference "from memory, unverified." Findings grounded in on-disk
reference code always outrank memory.

Walk goblin's spine — the flows every harness must solve — and for each,
compare implementations on both sides:

A. Turn spine: intake (`src/tg/inbox.ts`, `src/tg/turn-input.ts`,
   `src/http/app-channel.ts`) → admission (`src/turn/admission.ts`) →
   prompt assembly (`src/agent/prompt.ts`, `compaction.ts`,
   `skill-inject.ts`) → model stream (`src/agent/step.ts`,
   `filter-stream.ts`, `thinking.ts`, `providers.ts`) → tool loop
   (`src/agent/turn-tools.ts`, `src/agent/tools/`) → delivery
   (`src/turn/finish.ts`, `src/tg/delivery.ts`, `src/http/app-sse.ts`) →
   crash recovery (`src/turn-journal.ts`, `src/turn-resume.ts`) → loop
   hygiene (`src/loop-detect.ts`, `src/loop-watchdog.ts`).
B. State & conversation store: `src/sqlite.ts`, `src/durable.ts`,
   `src/conversation*.ts`, `src/rolling.ts`, `src/cache-observation.ts`,
   `src/cache-pruning.ts`, `src/pruning-marker.ts`.
C. Proactivity & scheduled work: `src/programs.ts`, `src/scheduler.ts`,
   `src/wake*.ts`, `src/system1.ts`, `src/responsibility-*.ts`.
D. Delegation & sandbox: `src/subagents/`, `src/herdr.ts`,
   `src/delegations*.ts`, `src/spinoff.ts`, `src/podman.ts`,
   `src/sandboxes.ts`.
E. Memory: `src/memory/`, `deploy/memory/`.
F. The second door: `app/src/` + `src/http/` — one client, two doors; the
   channels are disjoint by design.

What counts as a finding — the bar:

1. goblin solves a problem in a way that is locally clever but globally
   fragile, and a reference system carries a proven simpler mechanism for
   the same job.
2. An invariant held by convention — a comment, a test, a discipline —
   where the references hold it by structure: types, ownership, lifecycle,
   a serialization boundary.
3. Complexity compensating for a seam. v1 of this product died of a
   "~10x stabilization apparatus" grown to compensate for seams its
   platform forced on it (DESIGN.md → Why). If goblin's tests are propping
   up a seam the same way, that is a finding — the test-to-product ratio
   is checkable, and so is the shape of what the tests work around.
4. A mechanism all three references treat as load-bearing that goblin
   lacks — with a concrete reason it will hurt *this* single-operator
   deployment, not at hypothetical scale.
5. Misuse of an `@earendil-works` package where pi-mono demonstrates the
   intended pattern.

What does NOT count:

- Style, naming, formatting, dependency suggestions.
- Feature scope imported from the references. Mechanisms only. The
  non-goals are law (DESIGN.md → Product boundary): no third channel, no
  plugin SDK, no k8s, nothing multi-tenant. "openclaw has X, add X" is out
  of bounds unless X is a mechanism that repairs a real weakness.
- Performance or scale concerns that cannot matter for one operator on a
  homelab.
- Generic best-practice advice with no named reference implementation
  behind it.
- Restatements of Prior work. Verify those still hold if you touch the
  same code; do not re-report them.

Prior work — read the summaries first and build past them, not over them:

- `arch-audit.md` — three architectural findings (tool-replay identity
  conflation; resumed-turn causal anchor; standing authority enforced by
  model instruction) plus five follow-ups.
- `audit/optimization.md` — runtime + maintainability review, 2026-10-22.
- `audit/reports/SUMMARY.md` — results of the 21-area bug hunts.

Method:

- Record HEAD first: `git rev-parse HEAD`. The working tree may be dirty;
  review the tree as it stands.
- Read AGENTS.md (guardrails: fail loud, durable writes, one adapter per
  external contract) and DESIGN.md before code. A design ruling is
  deliberate: if a "finding" is a documented tradeoff in DESIGN.md or
  `design/<area>.md`, it is not a finding.
- Verify both sides of every claim: quote goblin's code (file:line) and
  the reference code (repo + path). If you cannot point at reference code
  on disk, the reference is memory-based — label it.
- Tests are evidence of intent and cheap to run from the repo root:
  `bun test <path>`. Do not run `*.live.test.ts`, do not restart or touch
  any service, do not run `scripts/release.ts`, and never read auth
  material or secrets — if a flow leads there, describe the structure and
  stop.
- Write the report to `audit/reference-review-2026-10-31.md`, terse, in
  the house format of the existing reports in `audit/`. Ranked findings,
  each: title · flow · what goblin does today (file:line) · the reference
  mechanism (repo/path, how it works, why it is better) · why it matters
  for this deployment · shape of the better design (direction, not diffs)
  · cost/risk to adopt · confidence (read-verified / memory-based /
  inferred).
- End with a clean-bill section: flows where goblin is ahead of or equal
  to all three references, naming the mechanism worth keeping. That
  section is half the value of the report — it tells the operator what
  not to touch.
- Cap: the 6–12 findings that would actually change code. Depth beats
  breadth; three findings that change code beat thirty that don't. If the
  operator wouldn't act on it, cut it.
