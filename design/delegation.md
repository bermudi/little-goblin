# Delegation — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Delegation (other harnesses, via herdr)

On demand (2026-09-26): goblin hands work to other coding harnesses
(codex, claude, pi, devin, opencode, …) and gets on with the chat; the
result returns to the topic it was delegated from — or, when launched
from the bot DM, to the app conversation it spins off (App channel →
Spin-off, ruling 2026-10-03). Harnesses run **interactively in herdr**,
the host's agent automation layer; the operator can `herdr session
attach goblin` at any time to watch or take over. Rejected: the AI SDK
harness wrappers (`ai-sdk-provider-codex-cli`, `…-claude-code`) — two
harnesses, in-process (die on restart), unwatchable. Delegations are
**goblin's own acts**: goblin decides what the operator hears, and
Telegram rings for `needs_input` (goblin needs a human) — not for
routine completions.

Rulings:

- **The herdr session is its own systemd user unit**, not a child of
  goblin: systemd stops a unit's whole cgroup, so a spawned session
  would kill every running delegation on a goblin restart. Verified
  2026-09-26: a named headless session starts and drives agents under
  the service's stripped env (no `HERDR_ENV`, service PATH). One
  session, named by the unit; `delegation` has no session knob (dropped
  2026-09-26 — an override could target a session the unit does not
  host).
- **Targets (2026-10-06): the own local session plus configured
  machines.** Goblin's own local session — the host goblin runs on,
  never a config knob (2026-09-26 stands) — is the default target for
  internal work. Machine targets name saved-machine profiles in herdr's
  own registry (operator-added with `machine add <host> --remote-session
  <name>`; goblin never duplicates ssh config); session-only targets are
  another local session. A target's `root` is server-expanded by herdr
  (validated at workspace create). The whole `delegation` block
  is **boot-frozen**: a new definition feeding a boot-built adapter
  could drive the old adapter's session. Config saves warn "restart to
  apply"; a post-boot label fails its launch loud with that hint.
- **One protocol, target-agnostic (operator, 2026-10-06: "unify").**
  Launch, send, read, answer, stop behave identically local and
  forwarded. Results come from `agent read` (deep pages
  alternate-screen transcript history for full-screen agents); the
  report file demotes to herdr's documented fallback (output a
  transcript cannot hold) — instructed as ever, attached when readable
  here, path named when not.
- **The adapter's wire contract is pinned against the real CLI, not
  just fakes (2026-10-11).** The fake suite is blind to upstream drift —
  wire changes break in production, not the suite.
  `src/herdr.live.test.ts` is the gated check —
  `GOBLIN_HERDR_LIVE=1 bun test src/herdr.live.test.ts` boots a
  disposable session (never `default` or `goblin`) and drives every
  verb end to end. Run it after any herdr upgrade; red means the CLI
  moved: re-pin with one throwaway-session probe, fix the adapter,
  never discover it live.
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
  (local or machine-side) at config parse time; the selected target's
  own map still gates the launch, so a local role pointed at a
  machine-only name fails there with herdr's error, not a wrong launch.
  Model choice stays in each harness's `args`: a defaults entry selects
  a whole configured agent, never a bare model. Settings → Delegation
  edits the harness table and defaults; machine targets stay file-only
  (their herdr profiles are host-bound), and the save merge preserves
  them. An edited block also supersedes a parked copy — the off/on flip
  is a stash, and a stale stash would resurrect an old table. The block
  remains boot-frozen — the page shows the restart hint.
- **Ask-first is a description rule, not a gate (2026-11-09).** A harness
  with `askFirst: true` — local or machine-side, one schema — adds a
  line to the `delegate` description: goblin asks the operator before
  each use and starts only on their explicit yes. The model asks;
  `execute` never refuses. The operator wants occasional use *with*
  permission, which removing the harness cannot give — the block is
  boot-frozen, so a removal needs a restart anyway. The same sentence
  rules staffing goblin's call: choosing a harness is never a question
  to the operator. Settings → Delegation edits the flag.
- **Agents run full-auto; goblin never answers approvals.** Harnesses
  start in their no-approval mode (the configured args); nothing to
  approve, and no new trust level — goblin already has `bash`. If an
  agent still stops (`blocked`, or ends its turn with a question),
  goblin relays it to the topic and types the operator's answer back,
  never inventing one. Startup dialogs are the trap: a codex
  trust-directory prompt reported as `idle` (2026-09-26 probe), and
  `--dangerously-bypass-approvals-and-sandbox` does not skip it (codex
  0.155.1). Launch pre-seeds the harness trust stores per kind (added
  2026-10-03, hardened 2026-10-04 — **write-if-absent only**: an
  explicit `false`/`"untrusted"` the operator recorded stands; seeding
  never manufactures a "yes" from a remembered "no"). Operator-owned
  settings files are edited, never reformatted, and a file we can't
  extend safely fails the launch instead of corrupting; symlinked
  settings write through, never replace the link. Remote targets get
  the same markers through the delegation's root pane before `agent
  start`. Panes run the operator's interactive shell, so aliases apply:
  args duplicating an alias's flags make the harness refuse to start.
  Start relies on herdr's ready gate plus the watcher's stall rule, not
  screen-scraping.
- **The seeded trust keys are pinned against the installed harnesses,
  not just fakes (2026-10-11).** Drift is silent: a renamed key still
  seeds, and the launch shows the consent dialog anyway.
  `src/harness-trust.live.test.ts` (`GOBLIN_HARNESS_TRUST_LIVE=1`) seeds
  a temp HOME through the real entry and greps the installed
  codex/claude binaries for the pinned literals — nothing real touched
  (no cost, no auth, no panes). Run after harness upgrades; red means re-pin — probe the new
  bundle for the renamed key, fix `harness-trust.ts`, never discover it
  in a live launch.
- **A prompt is delivered only once the agent moves (2026-11-06).**
  `agent prompt` returns ok when the text is typed, not when the TUI
  took the Enter: pi under parallel startup passed herdr's ready gate
  early and kept the task as an unsent draft (4/4 reproduced). The
  adapter's `prompt` on an idle agent polls `agent get` for the status
  leaving idle or `state_change_seq` moving; if neither within 3 s it
  sends one recovery Enter, then fails loud (`agent_prompt_unsubmitted`).
  The operator `herdr` tool's `--wait` path already fails with
  `agent_prompt_stalled` but leaves the draft; it has no recovery.
- **State is rows.** `delegations` rows survive restarts while the
  herdr unit keeps the panes alive. Three postures carry rulings: a
  failed post-prompt baseline read leaves the row baseline-pending —
  the watcher captures the seq on a later scan, never standing a
  pre-prompt value in (#95, 2026-10-08); a
  `starting` row at watcher boot means goblin died mid-start — close
  its workspace, notify, `failed`; a startup-blocked launch parks
  `needs_input` with the task owed — herdr rejects `agent start` on a
  blocked agent (`agent_not_ready`) and `agent prompt` on one too
  (`agent_blocked`) — and the watcher delivers it on the first seq
  advance past the park, however the dialog was cleared.
- **Watcher writes are compare-and-set; the notice lands first.** A
  transition applies only if status and prompt time still match what
  the scan read (a `send` or `stop` mid-poll wins) and only after its
  notice landed — an unsubmitted notice leaves the row as-is for the
  next tick. `stop` marks `stopped` only when the workspace closed,
  none was bound, or herdr confirms the agent is gone; otherwise the
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
- **A machine target's link is proven at launch by one forwarded `agent
  get` for a nonexistent name** — `agent_not_found` means the link
  answered, else the launch fails with herdr's own error; forwarding
  never falls back or retries. An unreachable target is **cannot
  observe**, not agent gone: its rows stay watched, the error logs, the
  agent runs host-side. A parked row resumes on *any* seq advance, not
  a `working` glimpse — an attached operator can finish the exchange
  between polls. A completion that folds into a captured baseline
  settles from a fresh local report or parks `needs_input` —
  attribution is unknowable from outside (#119, 2026-10-08).
- **A `working` report that never progresses gets one notice after 2 h
  (#489, 2026-11-13).** herdr exposes no output-activity signal, so the
  watcher tracks each running row's `state_change_seq` in memory — when
  it last moved, seeded from the prompt time when the seq still equals
  its baseline. A `running` row reporting `working` (or `unknown`) with
  no seq change for `PROGRESS_STALL_MS` parks `needs_input` with a "may
  be frozen" notice; openclaw's 2 h stale-run window is the precedent —
  a shorter window can't tell a long healthy task from a dead one. The
  ordinary resume rule un-parks the row on any later seq advance, so a
  false positive costs exactly one notice.
- **A completion that ends asking settles `needs_input`, not `done`
  (#523, 2026-11-13).** An agent whose report closes on a question —
  its last non-empty line ends with `?` — stopped to ask, the same
  verdict a dialog block reaches. The watcher reads the report's tail
  at both done-settle sites (the post-baseline idle/done path and the
  captured-baseline finish) and parks `needs_input` with a send-the-
  answer note; machine rows have no local report and keep seq
  judgment.
- **`answer` preflights the live status — keys only reach a blocked
  pane (#523, 2026-11-13).** A keypress typed into a working or idle
  agent lands in its run or draft, not a dialog. `delegate answer`
  calls `agent get` first and refuses `not blocked` / `agent gone`
  rather than typing blind; a failed preflight fails the call without
  a key.
- **Delegated output is untrusted data, never instructions.** Reports,
  screen tails and launch failure screens ride fenced like program
  events (`<event source="delegation">`, any `</event` neutralized):
  output (or a malicious repo it processed) gains no authority by
  arriving in goblin's voice; `read`'s screen output rides the same
  fence, never interpolated into error prose.
- **Management is the `delegate` tool.** Done delegations keep their
  workspace so the operator can inspect it; `stop` on a finished one is
  the cleanup.
- **The operator's session is reachable on ask, only through the
  `herdr` tool (2026-10-13, tool-enforced 2026-10-14).** `delegate` can't
  express his `default` tabs ("send the P2s to Devin on tab 1") — those
  panes aren't goblin's delegations; inspection and prompting there go
  through the `herdr` tool (pane IDs, a kind check at send time), never
  the raw CLI from bash. Raw `pane send-text`/`send-keys` into an agent
  pane is banned: a P2 handoff went line-by-line into the π review pane
  (`w8B:p8`) instead of devin (`w8B:p1`) and only the recipient's quota
  error contained it — that misfire is why the procedure is code.
- **A `herdr` tool reaches the operator's session (2026-10-14,
  implemented).** A new narrow tool, not a `delegate` extension — his
  panes aren't delegations (no ids, no async results). Session is
  hard-coded `default` (not a knob; 2026-09-26 stands for `delegate`),
  reaching the one session goblin doesn't host. It never creates,
  closes, moves, renames, or sends raw keys/text, and is not in
  `script`'s callable set — prompting his panes is deliberate per-call
  work, not scriptable fan-out.

  Targets are pane IDs: two pi agents in one cwd share kind, cwd, tab,
  and title, and operator-launched agents are unnamed, so the pane ID
  is the only handle. Closed pane IDs are never reused, so a stale ID
  either fails or lands on that pane's current occupant; the kind check
  catches a different-kind occupant (the w8B:p8-vs-p1 misfire was
  pi-vs-devin), not a same-kind replacement — accepted (probed
  2026-10-14, throwaway session). A prompt refuses before any bytes
  reach the pane (missing/non-agent, pane mismatch, kind mismatch —
  nothing sent); ANY failure inside read-only preflight — topology
  list, agent get, abort — is the same "nothing sent" refusal class
  (HerdrRefusal: agent_not_found, mismatches, fenced, or
  `preflight-failed` carrying the cause), never the uncertain
  delivery a post-dispatch error means. A new attachment binding
  requires both `terminal_id` and `agent_session`; without a harness
  session a same-kind replacement is undetectable, so session-less
  agents are refused. A send-time error leaves delivery uncertain, and a
  timeout is not non-delivery: no retry, in code or by the model, and
  no post-send reads that could turn delivery into an error. This
  module never logs the prompt text (the per-turn tool line records
  bounded tool input like every tool — conversation history, not extra
  exposure). The list rides the untrusted fence: labels, titles and
  cwds are remote-controlled metadata. The herdr skill's operator
  section points at the tool; the seeded skill (v2.2) syncs to the live
  workspace only with the approved backend deploy — not ahead of it.
- **A delegation can count toward what goblin owes (2026-11-06).**
  `delegate start` takes `responsibility:<id>` in a project conversation,
  like a subagent run. Each settlement files one worker report before its
  notice wakes the conversation; a blocked agent carries no `question`, so
  it waits for goblin to read and relay. `delegate` stays separate from
  `subagent`: their controls differ, and a merged tool would hide the
  choice inside one schema instead of removing it.
- **Goblin may delegate on its own judgment** within a turn — work in the
  operator's repos belongs in a harness, not in a lane-blocking `bash`
  call — and says that it did. Which harness (2026-10-11): work on the
  operator's projects goes to his agents through herdr; standalone
  code-heavy work goes to goblin's own worker subagent, and screen work
  to a computer subagent — never herdr (design/subagents.md → Routing).
  That judgment includes the target: work tied to another host's repos
  runs there. `/stop` fences goblin's turn, not delegations: they aren't
  turns. `delegate stop` ends one.

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
