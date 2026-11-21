# Delegation — goblin design

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
> the probe-proven config mechanisms (Devin's: operator config plus
> Goblin's hooks, below). Core state stays at
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

`src/hc.ts` owns the pinned core's wire contract. The private core
survives Goblin restarts; machine targets remain out. Delivery is proven
only when the hook reports `working`. Health and try cleanup must not
call `server status`, which may start a core. Polling avoids reconnect
and missed-event handling. The live contract check is below.

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
- **Staffing defaults are config, not notes.** The operator configures
  roles and harnesses; Goblin never guesses a model. The block remains
  boot-frozen.
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
  modes. Devin's folder-trust prompt draws before any hook (#743), so
  launch appends the cwd's realpath to devin's own store,
  `$XDG_DATA_HOME/devin/cli/trusted_workspaces.json` (`trusted_paths`;
  default `~/.local/share`), unless an entry already covers it — only
  that folder's trust, nothing else of the operator's. Devin's "No"
  records nothing, so there is no refusal to preserve. Not
  `--respect-workspace-trust false`: it skips the check silently and
  leaves no record the operator can see or revoke. Hooks are durably
  copied to the stable Goblin home. Claude gets generated `--settings`;
  Pi gets a per-run extension; OpenCode gets the hooks directory as a
  TUI plugin and `--standalone`; Devin gets a per-run `--config` built
  as the next ruling says.
- **Devin runs with the operator's config plus Goblin's hooks
  (operator, 2026-11-20, #810).** Devin's `--config` replaces its user
  config, so the per-run file under `$GOBLIN_HOME/state/hc-hooks/`
  starts as a copy of `$XDG_CONFIG_HOME/devin/config.json` (absolute
  values only, as devin resolves it) or `~/.config/devin/config.json`,
  parsed as JSONC like devin does. Missing file: start from
  `{version: 1}`. Any other read, parse or shape error fails the launch
  with the path; it never drops the operator's settings silently. Goblin
  then appends one `report.sh` entry to each of the six events, after
  the operator's own entries and never in their place: `SessionStart` →
  idle, `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → working, `Stop`
  → idle, `PermissionRequest` → `blocked permission`. An event that
  already runs Goblin's exact command gets no second entry. Before
  this, only `SessionStart` was registered: the operator's model,
  permissions and shell were lost, and Goblin's own hooks never reported
  `working`. Delivery still passed, because herdr-core's built-in devin
  detector reports `working`/`done` itself (`status.app = "devin"`;
  Goblin's OSC reports carry no `app`): live on devin 3000.14,
  2026-11-20. Goblin's hooks no longer depend on that detector. The copy can hold the
  operator's settings, so it is written 0600.
  `src/hc-devin.live.test.ts` (`GOBLIN_DEVIN_LIVE=1`) pins it on the
  installed devin after devin or hc upgrades; red means the contract
  moved. It drives `makeHcDelegation` end to end. Its safety rules:
  HOME, `XDG_*`, `GOBLIN_HOME` and the cwd are throwaway, and the hc
  session derives from the throwaway `GOBLIN_HOME`. The operator's
  devin credentials and config are copied into the temp HOME, never
  read into output: value checks are booleans, so a failure prints no
  setting. In the copy, probe hooks replace the operator's hooks, so
  none of theirs runs; the probes prove an operator entry still fires.
  Goblin's OSC reports carry no `app`, while herdr-core's detector
  stamps `app=devin`, so only `app`-less statuses count as Goblin's.
  One trivial prompt costs one model turn on the operator's own model.
  CI skips it. `makeHarnessInvocation` reads `HOME` per call: Bun
  caches `homedir()` at startup, so a test could not move it and read
  the operator's real devin config (2026-11-20).
- **The seeded trust keys are pinned against the installed harnesses,
  not just fakes (2026-10-11).** Drift is silent: a renamed key still
  seeds, and the launch shows the consent dialog anyway.
  `src/harness-trust.live.test.ts` (`GOBLIN_HARNESS_TRUST_LIVE=1`) seeds
  a temp HOME through the real entry and greps the installed
  codex/claude/devin binaries for the pinned literals — nothing real touched
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
  it waits for goblin to read and relay. `delegate send` to a linked
  delegation passes the same check as every send to a linked worker:
  the responsibility is `active`, the send comes from its project, and
  the sending turn predates no correction (design/agents.md → Linked
  workers). `delegate` stays separate from
  `subagent`: their controls differ, and a merged tool would hide the
  choice inside one schema instead of removing it.
- **`delegate` is operator-named only (design/agents.md, 2026-11-16;
  restated 2026-11-18).** "`delegate` stays just for this … only for
  use when the user asks for a `codex` run, or a `opencode` run" — or a
  standing instruction the operator set. Issue builds are not one: they
  run as the inner loop (below). Goblin never picks `delegate` on its own judgment; work it
  decides to hand off goes to `agent`. `/stop` fences goblin's turn,
  not delegations: they aren't turns. `delegate stop` ends one.

- **An issue build is one inner loop on T3 Code (operator, 2026-11-20;
  #745; replaces the 2026-11-09 lead-delegation ruling).** Goblin
  coordinates across issues; inside one issue the [inner
  loop](../GLOSSARY.md) does the work: one T3 Code thread, led by Claude
  on Opus 5.5 (T3 provider `claudeAgent`, model `claude-opus-5-5`), in a
  new git worktree from the repo's default branch
  (`t3 thread start --worktree origin/<default> --branch issue/<N>`).
  When the operator hands over an issue, goblin starts it at once,
  without asking first: `responsibility accept` with `issue` and
  `start:{brief, branch?}` resolves `origin/HEAD`, fetches it, starts
  the thread and binds it as the responsibility's attachment in the same
  call. A retried accept with the same handover key finds the existing
  responsibility and starts nothing. The thread's own agents are its
  acts, not goblin's; goblin's view of them is the thread and its PR.
  Rework and the post-green-light merge go to the same thread
  (`responsibility send`), so one worker stays accountable per issue.
  The 2026-11-09 limits carry over: at most two issue builds at once
  (the procedure's limit, not a tool refusal), and handover is explicit
  — goblin does not pick issues up on its own. `innerLoop:
  {provider, model, options?}` in config overrides the default model.
  `delegate` no longer has a `lead` role: it runs only harnesses the
  operator names, with `delegation.defaults.default` (pi on prod) as
  the default. Accepted risk: a crash between the thread start and the
  accept commit leaves an unbound thread in T3 Code.

- **PR readiness is observed on the responsibility, not inferred
  (operator, 2026-11-12, #406; moved off the lead 2026-11-20, #745).**
  The check lives on the responsibility, so it works for any worker. A
  responsibility accepted with `issue:{repository:"owner/repo",number:N}`
  links that issue once (`responsibility_issues`); nothing reconstructs
  it from a report, task, cwd or thread title. The inner loop's start
  message carries the verifier comment contract:

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

  `src/responsibility-readiness.ts` observes each active responsibility
  with a linked issue at most once a minute, on the responsibility
  observer's ticker — no model and no second scheduler. After the GitHub
  read it re-checks the responsibility in the same transaction as every
  write: a pause, cancel or close during the read wins. The first
  observation of an open issue with no PR yet is a silent baseline.
  Unchanged facts update the timestamp and wake nothing. A change
  (including changed notes, errors, head or CI) files one `worker`
  report and one `pr-readiness` wake in one transaction: the report's
  evidence names the closing PR, head, verdict/SHA and CI/SHA; pending CI
  reports `waiting`, other missing or negative evidence `blocked`,
  passing facts `ready`. None closes the responsibility. A version
  counter makes a regression a new report even if the same facts
  occurred earlier. An `unavailable` read records nothing and retries on
  the next tick. Watching stops when the issue closes with no PR or the
  responsibility leaves `active`; an operator correction keeps the link.
  No model polls GitHub while CI runs. The one-shot read-only probe is
  `bun --no-env-file scripts/pr-readiness.ts owner/repo N`. Delegation
  rows keep their old `issue_json`/`readiness_*` columns unread; dropping
  them would drop data.

Still out: subagent fleets inside goblin (a delegation is one external
agent per task, not an orchestrator), goblin-managed nesting (an inner loop's own
agents are the inner loop's), fan-out tooling, ACP, the AI SDK harness wrappers.
