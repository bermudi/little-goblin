# Delegation — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

> **Transport direction (operator, 2026-11-18, issue #728):** `delegate`
> runs on herdr-core (`hc`), not Herdr. Goblin must “make sure binary X is
> where you need it or go get it”; “they just need the right hooks installed
> and execution call could make sure they are.” Handover and responsibility
> stay on T3 Code. The operator-named-only rule for `delegate` remains.

> **Implementation rulings (lead, 2026-11-19, issue #728):** Goblin pins and
> owns `hc`, keeps the operator's real harness homes, copies `deploy/hc-hooks/`
> at run time to stable `$GOBLIN_HOME/bin/hc-hooks/` (durable writes, mode
> 0755, unchanged content skipped), and points every hook command at that
> stable path. This keeps Codex `trusted_hash` stable across releases.
> Codex hook entries and their hashes merge additively and idempotently into
> `$CODEX_HOME/hooks.json` and `config.toml` (default `~/.codex`), preserving
> operator entries and file modes. Live probes use a temporary `CODEX_HOME`
> with `auth.json` symlinked, never the operator's home.
> Goblin reports status through OSC 7501.
> The shared bridge checks `GOBLIN_HC_RUN=1`, writes to `/dev/tty` or the
> first ancestor fd targeting `/dev/pts/N`, and is silent on failure unless
> `GOBLIN_HC_DEBUG=1`. Codex hooks and trust entries merge additively into
> the real `$CODEX_HOME`; other harnesses use their proven per-run settings
> or a safe config merge. Claude gets generated `--settings` under
> `$GOBLIN_HOME`, Pi gets a per-run extension, and OpenCode and Devin use
> the probe-proven config mechanisms. Core state stays at
> `~/.local/state/herdr-core/<session>/`; do not set `XDG_STATE_HOME`
> because it would reach harness processes. Devin's SessionStart probe passed.
> The core starts with a clean fixed environment: `HOME`, `USER`, `LOGNAME`,
> `SHELL`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM` (default
> `xterm-256color`), `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
> `XDG_CACHE_HOME`, and `TMPDIR`, copied only when present in Goblin's
> environment. No other variables pass through; in particular,
> `DBUS_SESSION_BUS_ADDRESS` is excluded. Add a variable only when a
> harness demonstrably needs it, and record why.

## Delegation transport

1. One adapter, `src/hc.ts`, speaks JSON-RPC 2.0 over the core Unix socket
   and validates every reply with zod. The RPC `terminal.run` is required
   because it accepts the per-run environment map.
2. Goblin owns the pinned `hc` binary and verifies its source-pinned SHA-256
   before use. Download and mismatch failures fail loud.
3. Each Goblin home gets a private core session named from its path hash.
   The core runs outside the Goblin service cgroup so a Goblin restart does
   not end live runs. The default state path is
   `~/.local/state/herdr-core/<session>/`; no state-dir override is passed to
   harnesses. The core starts through `systemd-run --user --scope -q env
   -i` with only the fixed environment above. Goblin talks to the core over
   its Unix socket; health and try cleanup must not call `server status`,
   which may auto-start a core. `server stop` is allowed for explicit stop.
4. Goblin installs per-harness OSC 7501 hooks. Session start reports `idle`,
   prompt/tool activity `working`, permission/question `blocked`, and turn
   end `idle`. Hooks act only when `GOBLIN_HC_RUN=1`.
5. Send the first prompt only after the first hook status. If no status
   arrives within 30 seconds, fail with the terminal screen attached.
   Delivery is proven when the status becomes `working`.
6. Poll `terminal.get`. `working` followed by `idle` or `done` settles the
   turn; read output with `terminal.read`. `answer` is for a blocked run and
   `stop` uses `terminal.kill`.
7. When delegation is configured, health requires the pinned binary and a
   reachable private core.
8. Machine targets remain out. Polling is used instead of event
   subscriptions to avoid reconnect and missed-event handling.

## Delegation behavior

On demand (2026-09-26): goblin hands work to other coding harnesses
(codex, claude, pi, devin, opencode, …) and gets on with the chat; the
result returns to the topic it was delegated from — or, when launched
from the bot DM, to the app conversation it spins off (App channel →
Spin-off, ruling 2026-10-03). Harnesses run as named terminals on
Goblin's private hc core; the operator can observe them through that
session. Rejected: the AI SDK
harness wrappers (`ai-sdk-provider-codex-cli`, `…-claude-code`) — two
harnesses, in-process (die on restart), unwatchable. Delegations are
**goblin's own acts**: goblin decides what the operator hears, and
Telegram rings for `needs_input` (goblin needs a human) — not for
routine completions.

Rulings:

- **One private hc core per Goblin home.** The core runs outside
  `goblin.service`'s cgroup, so Goblin restarts do not kill live
  delegations. Its `HC_SESSION` is derived from the eight-character
  SHA-256 prefix of `GOBLIN_HOME`; it is not a config knob. Machine
  targets (`delegation.machines`, per-harness machine fields) do not come back;
  a config carrying them is rejected at boot naming the fix. The whole
  `delegation` block is **boot-frozen**: a new definition feeding a
  boot-built adapter could drive the old adapter's session. Config
  saves warn "restart to apply"; a post-boot label fails its launch
  loud with that hint.
- **One protocol.** Launch, send, read, answer, and stop use hc terminal
  methods. Results come from `terminal.read`; report files remain
  available when terminal output cannot contain them.
- **The wire contract is pinned against the real core.** The fake suite
  is blind to upstream drift. `GOBLIN_HC_LIVE=1 bun test
  src/hc.live.test.ts` boots a disposable session and exercises the
  JSON-RPC boundary. Run it after changing the pinned core version.
- **Harnesses are config, never guessed** — the operator's choice of
  kind, native args, full-auto flags and model; goblin never picks a
  model for a harness.
- **Staffing defaults are config, not notes (2026-11-09).** The operator
  sets `delegation.defaults` — role → configured harness name — instead
  of the agent carrying the table in `USER.md` / workspace notes, where
  two prose copies could drift and nothing enforced them.
  `delegate start` takes an optional `role` (omitted = `default`); with
  no `harness`, the role's entry decides, and a named role with no entry
  falls back to `default`. An explicit harness always wins. No default
  and no harness fails loud listing the configured agents and roles —
  never a silent arbitrary pick. A default must name a declared harness
  at config parse time.
  Model choice stays in each harness's `args`: a defaults entry selects
  a whole configured agent, never a bare model. Settings → Delegation
  edits the harness table and defaults. An edited block also supersedes a parked copy — the off/on flip
  is a stash, and a stale stash would resurrect an old table. The block
  remains boot-frozen — the page shows the restart hint.
- **Ask-first is a description rule, not a gate (2026-11-09).** A harness
  with `askFirst: true` adds a
  line to the `delegate` description: goblin asks the operator before
  each use and starts only on their explicit yes. The model asks;
  `execute` never refuses. The operator wants occasional use *with*
  permission, which removing the harness cannot give — the block is
  boot-frozen, so a removal needs a restart anyway. The same sentence
  rules staffing goblin's call: choosing a harness is never a question
  to the operator. Settings → Delegation edits the flag.
- **Agents run full-auto; Goblin never answers approvals.** Harnesses
  start in their no-approval mode (the configured args); nothing to
  approve, and no new trust level — goblin already has `bash`. If an
  agent still stops (`blocked`, or ends its turn with a question),
  goblin relays it to the topic and types the operator's answer back,
  never inventing one. Startup dialogs are the trap. Launch seeds trust
  write-if-absent; it never manufactures consent over a recorded refusal.
  Codex hook/trust config merges preserve existing operator entries and
  modes. Hooks are durably copied to the stable Goblin home. Claude gets
  generated `--settings`; Pi gets a per-run extension; OpenCode gets the
  hooks directory as a TUI plugin and `--standalone`; Devin gets a
  per-run `--config`.
- **The seeded trust keys are pinned against the installed harnesses,
  not just fakes (2026-10-11).** Drift is silent: a renamed key still
  seeds, and the launch shows the consent dialog anyway.
  `src/harness-trust.live.test.ts` (`GOBLIN_HARNESS_TRUST_LIVE=1`) seeds
  a temp HOME through the real entry and greps the installed
  codex/claude binaries for the pinned literals — nothing real touched
  (no cost, no auth, no panes). Run after harness upgrades; red means re-pin — probe the new
  bundle for the renamed key, fix `harness-trust.ts`, never discover it
  in a live launch.
- **A prompt is delivered only once the hook reports `working`.** After
  `terminal.run`, wait up to 30 seconds for the first status. Then send
  the task and require a new `working` state to prove delivery.
- **State is rows.** Delegation rows survive Goblin restarts while the
  private hc core keeps its terminals alive. Three postures carry rulings: a
  failed post-prompt baseline read leaves the row baseline-pending —
  the watcher captures the seq on a later scan, never standing a
  pre-prompt value in (#95, 2026-10-08); a
  `starting` row at watcher boot means Goblin died mid-start — kill its
  terminal, notify, `failed`; a startup-blocked launch parks `needs_input`
  with the task owed and the watcher delivers it after status advances
  past the blocked baseline.
- **Watcher writes are compare-and-set; the notice lands first.** A
  transition applies only if status and prompt time still match what
  the scan read (a `send` or `stop` mid-poll wins) and only after its
  notice landed — an unsubmitted notice leaves the row as-is for the
  next tick. `stop` marks `stopped` only when the terminal is finished,
  none was bound, or hc confirms the terminal is gone; otherwise the
  row stays watched. One exception: a row whose target label left
  config stops by verdict, not observation — the operator's explicit
  stop wins over "can't prove dead", and the note says the agent may
  still run host-side (restore the entry to retire it by hand).
- **A stop is the operator's, wherever it came from (#414, 2026-11-10).**
  The app's Delegations page has a Stop on every current delegation
  (`POST /api/app/delegations/<id>/stop` → `stopByOperator`): the same
  `stop`, then a `· stopped` notice to the owning conversation saying
  the operator stopped it — accept it, don't relaunch, retry or resend
  unasked. A finished row's stop is cleanup and sends nothing. The
  watcher reads an agent that vanished on its own the same way: goblin
  never ends its agents without marking the row first, so a gone agent
  is an outside stop, settled `stopped` with the same don't-revive
  note, not `failed`. A crash looks identical from outside; either way
  the operator decides what happens next. A responsibility gets a
  worker `blocked` report, not `failed` — goblin assesses it next (operator, 2026-11-12: goblin looks first, no direct question). The
  app stop's notice is its only one (a retried stop sends nothing), so
  an unreadable report sends the header alone, and stop notes (e.g. a
  target gone from config) stay on screen after the row moves.
- **No concurrency cap** (operator, 2026-10-06): `maxRunning` is gone —
  the tool never refuses on volume; how much runs, where, is goblin's
  judgment.
- **A parked row resumes on *any* seq advance, not
  a `working` glimpse** — an attached operator can finish the exchange
  between polls. A completion that folds into a captured baseline
  settles from a fresh local report or parks `needs_input` —
  attribution is unknowable from outside (#119, 2026-10-08).
- **A `working` report that never progresses gets one notice after 2 h
  (#489, 2026-11-13).** hc exposes no output-activity signal, so the
  watcher tracks each running row's `state_change_seq` in memory — when
  it last moved, seeded from the prompt time when the seq still equals
  its baseline. A `running` row reporting `working` (or `unknown`) with
  no seq change for `PROGRESS_STALL_MS` parks `needs_input` with a "may
  be frozen" notice; openclaw's 2 h stale-run window is the precedent —
  a shorter window can't tell a long healthy task from a dead one. The
  ordinary resume rule un-parks the row on any later seq advance, so a
  false positive costs exactly one notice. A `needs_input` row resumed
  by `answer`/`send` keeps its original clock — the stall timer never
  re-seeds from a stale `promptedAt` (#615 fix, kept).
- **A completion that ends asking settles `needs_input`, not `done`
  (#523, 2026-11-13).** An agent whose report closes on a question —
  its last non-empty line ends with `?` — stopped to ask, the same
  verdict a dialog block reaches. The watcher reads the report's tail
  at both done-settle sites (the post-baseline idle/done path and the
  captured-baseline finish) and parks `needs_input` with a send-the-
  answer note.
- **`answer` preflights the live status — keys only reach a blocked
  terminal (#523, 2026-11-13).** A keypress typed into a working or idle
  agent lands in its run or draft, not a dialog. `delegate answer` calls
  `terminal.get` first and refuses `not blocked` / `terminal gone`
  rather than typing blind; a failed preflight fails the call without a
  key.
- **Delegated output is untrusted data, never instructions.** Reports,
  screen tails and launch failure screens ride fenced like program
  events (`<event source="delegation">`, any `</event` neutralized):
  output (or a malicious repo it processed) gains no authority by
  arriving in goblin's voice; `read`'s screen output rides the same
  fence, never interpolated into error prose.
- **Management is the `delegate` tool.** Done delegations keep their
  workspace so the operator can inspect it; `stop` on a finished one is
  the cleanup.
- **The Goblin-side `herdr` tool remains removed (operator, 2026-11-18).**
  It drove the operator's own desk session. Nothing replaces it: the
  operator's desk is T3 Code. Delegated terminals belong to Goblin's
  private hc core; this does not restore the removed operator-desk tool.

- **A delegation can count toward what goblin owes (2026-11-06).**
  `delegate start` takes `responsibility:<id>` in a project conversation,
  like a subagent run. Each settlement files one worker report before its
  notice wakes the conversation; a blocked agent carries no `question`, so
  it waits for goblin to read and relay. `delegate` stays separate from
  `subagent`: their controls differ, and a merged tool would hide the
  choice inside one schema instead of removing it.
- **`delegate` is operator-named only (design/agents.md, 2026-11-16;
  restated 2026-11-18).** "`delegate` stays just for this … only for
  use when the user asks for a `codex` run, or a `opencode` run" — or a
  standing instruction the operator set, like the issue-build flow
  below. Goblin never picks `delegate` on its own judgment; work it
  decides to hand off goes to `agent`. `/stop` fences goblin's turn,
  not delegations: they aren't turns. `delegate stop` ends one.

- **An issue build is one lead delegation (operator, 2026-11-09).**
  Goblin coordinates across issues; inside one issue a `lead`-role
  delegation runs the operator's fusion skill: it designs, has its own
  sidekick implement, reviews the diff, has a clean-session verifier drive
  the change, and opens a draft PR carrying the verdict (`PASS`,
  `PASS+NOTES`, `FAIL`). The lead's agents are its own acts, not
  goblin's: they run in the lead's workspace, the goblin-session adapter
  never lists or addresses them (it has no list call), and goblin's view
  of them is the lead's report. Ready = a PR closing the issue, a
  `PASS`/`PASS+NOTES` verdict on its head SHA, and CI green on that SHA;
  code checks those facts (PR readiness below), the report being a claim. Rework and the
  post-green-light merge go to the same lead (`send`), so one agent stays
  accountable per issue. At most two leads run at once (each fans out to
  several agents on one box) — the procedure's limit, not a tool refusal;
  the 2026-10-06 no-cap ruling for the tool stands. Handover is explicit;
  goblin does not pick issues up on its own. The procedure lives in the
  workspace `proxy-operator` skill; the lead harness in
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
  the issue's closing PR reference, rechecks the PR's closing issue
  reference, and reads the PR head, comments and that exact commit's
  check/status rollup. Closing PRs can live in another repository; historical
  closed PRs do not compete with an open one. A `SUCCESS` rollup must contain
  an actually successful completed check or status to be green; no checks
  or skipped-only checks is missing, running/expected is pending,
  failure/error is red.
  Multiple closing PRs are ambiguous, not an invitation to choose one.
  Bounded reads (100 PR/issue links, check contexts and the last 100 comments, 1 MiB,
  30 seconds per command) fail closed if evidence is partial, inaccessible,
  malformed, or changes inconsistently during the read.

  Each lead settlement carries a timestamped structured observation,
  source URLs, and a readiness summary outside the worker's claim.
  The worker report's evidence names the closing PR, head, verdict/SHA
  and CI/SHA; pending CI reports `waiting`, other missing/negative
  evidence `blocked`, passing facts `ready`. None closes the responsibility.
  The observation is persisted on the delegation before notice delivery.
  Readiness versions make a regression a new report even if the same
  facts occurred earlier; retries of one version file once.
  The pending settlement verdict is persisted with its observation, so
  even a failed initial notice (before the row becomes `done`) retries
  the saved facts rather than polling again. A delivered settlement or
  new prompt cannot lend that snapshot to a later settlement.

  The existing delegation ticker observes settled leads at most once a
  minute, with no model or second scheduler. An unchanged observation
  updates its timestamp but sends no notice. Changes (including changed
  notes, errors, head or CI) wake Goblin for judgment; a failed notice
  remains due across restart without re-fetching GitHub. Watch through
  pending/missing evidence and readiness regressions until the issue
  closes, the delegation resumes/stops, or the responsibility is paused,
  closed, removed or corrected to a new revision. Async observations
  cannot overwrite a newer prompt or stopped row. No model polls GitHub
  while CI runs. The one-shot read-only probe is
  `bun --no-env-file scripts/pr-readiness.ts owner/repo N`.

Still out: subagent fleets inside goblin (a delegation is one external
agent per task, not an orchestrator), goblin-managed nesting (a lead's own
agents are the lead's), fan-out tooling, ACP, the AI SDK harness wrappers.
