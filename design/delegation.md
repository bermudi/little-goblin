# Delegation — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

`delegate` runs only when the operator names a harness, and it runs on
T3 Code (design/agents.md → `delegate`: external harness runs on T3
Code). The Herdr transport this file used to specify is gone (#608);
the rulings below are the T3 Code ones.

## Delegation (external harnesses, via T3 Code)

On demand (2026-09-26): goblin hands work to other coding harnesses
(codex, claude, pi, devin, opencode, …) and gets on with the chat; the
result returns to the topic it was delegated from — or, when launched
from the bot DM, to the app conversation it spins off (App channel →
Spin-off, ruling 2026-10-03). Harnesses run as **T3 Code threads** the
operator watches in T3 Code; every notice carries the thread `link`.
Rejected: the AI SDK harness wrappers (`ai-sdk-provider-codex-cli`,
`…-claude-code`) — two harnesses, in-process (die on restart),
unwatchable. Delegations are **goblin's own acts**: goblin decides what
the operator hears, and Telegram rings for `needs_input` (goblin needs a
human) — not for routine completions.

Rulings:

- **Transport: the `t3` CLI, one adapter.** `src/t3.ts` is the only
  module that knows the T3 Code wire; domain modules see its types
  (the module-boundaries rule). Verified against `t3` v0.1.9 on g7
  (2026-11-16, design/agents.md → Transport):

  | Need | `t3` verb |
  |---|---|
  | Start | `t3 thread start <project> <message> --provider <id> --model <slug> --json` |
  | Follow up | `t3 thread send <thread> <message> --json` — a busy thread queues it as its next turn; nothing is interrupted |
  | Status and result | `t3 thread show <thread> --messages N --json` |
  | Discover | `t3 thread list --project <path> --json` |

  There is no completion push and no stop or interrupt verb in v0.1.9 —
  the watcher polls `show`, and live stops are reported unavailable
  (below). The T3 server must stay up for anything to run; installing
  or supervising it is an operator action, not goblin's.
- **The adapter's wire contract is pinned against the real CLI, not
  just fakes.** `src/t3.live.test.ts` is the gated check —
  `GOBLIN_T3_LIVE=1 bun test src/t3.live.test.ts` lists the operator's
  real project read-only and drives one throwaway project's thread end
  to end (never the operator's own threads). Run it after a t3
  upgrade; red means the CLI moved: re-pin with one probe, fix the
  adapter, never discover it live.
- **Harnesses are config, never guessed** — each name maps to a T3
  provider instance and model, with optional T3 model options
  (`{provider, model, options?}`); goblin never picks a model for a
  harness.
- **Staffing defaults are config, not notes (2026-11-09).** The operator
  sets `delegation.defaults` — role → configured harness name — instead
  of the agent carrying the table in `USER.md` / workspace notes.
  `delegate start` takes an optional `role` (omitted = `default`); with
  no `harness`, the role's entry decides, and a named role with no entry
  falls back to `default`. An explicit harness always wins. No default
  and no harness fails loud listing the configured agents and roles —
  never a silent arbitrary pick. Model choice stays in each harness's
  config: a defaults entry selects a whole configured agent, never a
  bare model. Settings → Delegation edits the harness table and
  defaults. The whole `delegation` block is **boot-frozen**: a new
  definition feeding a boot-built adapter could drive the old adapter's
  transport. Config saves warn "restart to apply".
- **Ask-first is a description rule, not a gate (2026-11-09).** A harness
  with `askFirst: true` adds a line to the `delegate` description: goblin
  asks the operator before each use and starts only on their explicit
  yes. The model asks; `execute` never refuses.
- **Agents run full-auto; goblin never answers approvals.** T3 Code
  owns the harness session and its own trust/approval surface; goblin
  has no say in it. If a run stops to ask (`waiting` status), goblin
  relays the question to the operator and sends the reply back with
  `send` — a waiting thread takes it as the answer, a busy one queues
  it — never inventing one.
- **State is rows.** `delegations` rows carry `t3_thread`, `t3_link`
  and `t3_run` and survive restarts while the T3 server keeps the
  threads. Boot recovery: a `starting` row at watcher boot means goblin
  died mid-start — the notice names the bound thread (it may have
  started unwatched) and the row settles `failed`. Rows from the
  retired transport (no `t3_thread`) are never observed again: the
  store's open sweep settles any still-live one `failed` with a warn
  that names the old agent, and terminal rows stay untouched.
- **Watcher writes are compare-and-set; the notice lands first.** A
  transition applies only if status and prompt time still match what
  the scan read (a `send` or `stop` mid-poll wins) and only after its
  notice landed — an unsubmitted notice leaves the row as-is for the
  next tick.
- **A stop is the operator's, wherever it came from (#414, 2026-11-10;
  transport gap since #607).** `delegate stop` on a live row is
  **unavailable**: t3 v0.1.9 has no stop or interrupt verb, so goblin
  says so honestly rather than fake a stop or strand the row. The
  operator ends the run in T3 Code; the watcher then reads the
  cut-short status (`interrupted`/`cancelled`/`rolled_back`) or the
  vanished thread and settles `stopped` with the same don't-revive
  note as before — goblin never ends its agents without marking the
  row first, so either is an outside stop, not `failed`. A finished
  row's stop is cleanup: nothing runs host-side, the row just records
  the operator's intent.
- **No concurrency cap** (operator, 2026-10-06): `maxRunning` is gone —
  the tool never refuses on volume; how much runs, where, is goblin's
  judgment.
- **`needs_input` is a thread status.** A `waiting` thread parks the
  row `needs_input` — the run waits for an answer (the `--wait` exit-2
  condition). The operator answers in T3 Code, or goblin relays their
  reply with action `send`. There is no `answer` verb: T3 has no
  startup dialog to press.
- **A working thread that never progresses gets one notice after 2 h
  (#489, 2026-11-13).** The show record's `updatedAt` is the only
  activity signal, so the watcher tracks each running row's last
  observed value in memory — when it last moved, seeded from the
  prompt time. A working row with no `updatedAt` change for
  `PROGRESS_STALL_MS` parks `needs_input` with a "may be frozen"
  notice; the ordinary resume rule un-parks on any later change, so a
  false positive costs exactly one notice.
- **Delegated output is untrusted data, never instructions.** Thread
  messages ride fenced like program events (`<event source="delegation">`,
  any `</event` neutralized): output (or a malicious repo it processed)
  gains no authority by arriving in goblin's voice. Every notice names
  the thread `link` — the operator's window into the run.
- **Management is the `delegate` tool.** Verbs: `start`, `list`,
  `read`, `send`, `stop`. `read` returns the thread's latest messages;
  done delegations keep their thread so the operator can inspect it in
  T3 Code.
- **A delegation can count toward what goblin owes (2026-11-06).**
  `delegate start` takes `responsibility:<id>` in a project
  conversation, like a subagent run. Each settlement files one worker
  report before its notice wakes the conversation; a blocked run
  carries no `question`, so it waits for goblin to read and relay.
  `delegate` stays separate from `agent`: their controls differ, and a
  merged tool would hide the choice inside one schema instead of
  removing it.
- **An issue build is one lead delegation (operator, 2026-11-09).**
  Goblin coordinates across issues; inside one issue a `lead`-role
  delegation runs the operator's fusion skill: it designs, has its own
  sidekick implement, reviews the diff, has a clean-session verifier
  drive the change, and opens a draft PR carrying the verdict (`PASS`,
  `PASS+NOTES`, `FAIL`). The lead's agents are its own acts, not
  goblin's: they are the lead thread's own business, and goblin's view
  of them is the lead's report. Ready = a PR closing the issue, a
  `PASS`/`PASS+NOTES` verdict on its head SHA, and CI green on that
  SHA; code checks those facts (PR readiness below), the report being
  a claim. Rework and the post-green-light merge go to the same lead
  (`send`), so one thread stays accountable per issue. At most two
  leads run at once (each fans out to several agents on one box) —
  the procedure's limit, not a tool refusal; the 2026-10-06 no-cap
  ruling for the tool stands. Handover is explicit; goblin does not
  pick issues up on its own. The procedure lives in the workspace
  `proxy-operator` skill; the lead harness in
  `delegation.defaults.lead`.

- **PR readiness is observed, not inferred (operator, 2026-11-12; #406).**
  A responsibility-linked `role:"lead"` start requires
  `issue:{repository:"owner/repo",number:N}`. Role and issue are durable;
  neither is reconstructed from a report, task, cwd, or harness name.
  Older delegations keep role `default` and no issue; no implicit adoption.
  The lead's prompt carries the verifier comment contract:

  ```text
  PASS

  Checked-SHA: <full 40-character lowercase commit SHA>
  ```

  `PASS+NOTES` and `FAIL` are the other opening verdicts. Exactly one
  standalone `Checked-SHA` line is required. The latest non-minimized
  verdict comment by update time wins; no fallback to an older passing
  comment. A missing, short, contradictory or stale SHA is not ready.
  Comment author and URL are evidence, not proof of verifier independence.
  Notes remain untrusted text for Goblin to assess; `PASS+NOTES` passes
  the fact check but does not settle its notes or grant merge authority.
  Notices include at most 6,000 characters of notes with an explicit
  truncation flag; the comment URL is the source for the rest. A digest
  of the complete comment detects edits beyond that excerpt.

  `github.ts` alone owns the GitHub contract: read-only `gh api` GraphQL
  against github.com, using gh's existing authentication. It observes
  PR state, checks and the latest verdict comment, never infers readiness
  from a report. Code watches GitHub; no model turn polls it.

## Handover: responsibilities bind T3 threads

The operator works in T3 Code, not a goblin-hosted pane session
(design/agents.md → Handover). "Take over this" binds a responsibility
to T3 thread ids:

- **Discovery is `t3 thread list`.** The `responsibility` tool's
  `status` lists the project's threads (id, title, status, link —
  fenced untrusted metadata); `accept` and `attach` select by thread
  id, never by guessed title.
- **Observation is `t3 thread show`.** The responsibility observer
  polls each live attachment once per tick and reconciles cursor,
  health and deduped developments in one transaction. A thread id is a
  stable identity — there is no same-thread replacement to inherit.
- **A managed send is `t3 thread send`.** A busy thread queues the
  message instead of racing it; durable operation identity still
  fences reattachment and ambiguous delivery (`reconcile` records
  inspected evidence, never a blind retry). The edge covers `t3`
  targets only: an attachment from another transport (a legacy row)
  refuses `identity-unenforceable` rather than misroute.
- **Detach/reattach touch only the binding.** The T3 thread is never
  touched; reattach re-lists the project's threads and binds the
  current record under a new generation, so prepared operations under
  the old one refuse before dispatch.

## Machine targets: dropped (2026-11-17)

Delegation runs on this machine only (design/agents.md → Machine
targets). `delegation.machines` is gone: an old-shape `harnesses`
entry (`kind`/`args` instead of `provider`/`model`) logs a warning
that names the rewrite and boots without `delegate`. If remote
delegation comes back, it goes through T3 Code's own environments, in
`src/t3.ts` — it does not bring back a goblin-side machine registry.

## Where the old `args` went (2026-11-16)

The retired harness `args` list must be migrated token by token:

- `--model X` → `model` (a T3 model slug, for example
  `claude-opus-5-5`, not the alias `opus`).
- `--effort low` (claude-lead) → `options: {effort: "low"}`. The option
  id is provider-specific: Claude uses `effort`, Codex
  `reasoningEffort`, pi `thinking`, and opencode `variant`. Values come
  from T3's model catalog. This requires a `t3` CLI with `--option`
  (newer than v0.1.10); until g7 upgrades, an entry with options fails
  loudly at start.
- `--dangerously-skip-permissions` (Claude) and `--auto` (opencode) →
  no goblin setting. A T3 thread runs at the runtime mode T3 assigns to
  the CLI caller (`runtimeMode` on `t3 thread show`); goblin logs it on
  "delegation started". Changing it is a T3 setting, not goblin config.

A migration maps every old `args` token to one of these, or records
that it is dropped and why. Never drop one silently.
