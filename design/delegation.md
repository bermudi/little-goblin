# Delegation — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Delegation (other harnesses, via herdr)

On demand (2026-09-26): goblin hands work to other coding harnesses
(codex, claude, pi, devin, opencode, …) and gets on with the chat; the
result returns to the topic it was delegated from — or, when launched
from the bot DM, to the app conversation it spins off (App channel →
Spin-off, ruling 2026-10-03). Harnesses run **interactively in herdr**,
the host's agent automation layer: it recognizes pane agents, owns their
lifecycle (`idle|working|blocked|done|unknown`), gates startup readiness,
submits prompts, relays UI keys, waits on states, and collects
transcripts on demand; the operator can `herdr session attach
goblin` at any time to watch or take over. Rejected: the AI SDK harness
wrappers (`ai-sdk-provider-codex-cli`, `…-claude-code`) — two harnesses,
in-process (die on restart), unwatchable. Delegations are **goblin's own
acts**: goblin decides what the operator hears, and Telegram rings for
`needs_input` (goblin needs a human) — not for routine completions.

Rulings:

- **The herdr session is its own systemd user unit**
  (`deploy/goblin-herdr.service`: `herdr --session goblin server`), which
  `goblin.service` `Wants=`/`After=`. Not a child of goblin: systemd
  stops a unit's whole cgroup, so a spawned session would kill every
  running delegation on a goblin restart. Verified 2026-09-26: a named
  headless session starts and drives agents under the service's stripped
  env (no `HERDR_ENV`, service PATH); `install.sh` installs both. One
  session, named by the unit — `goblin` exists only in its `--session`,
  and `delegation` has no session knob (dropped 2026-09-26: an override
  could target a session the unit does not host).
- **Targets (2026-10-06): the own **local** session plus configured
  machines.** Goblin's own local session — the host goblin runs on, never
  a config knob (2026-09-26 stands) — is the default target for internal
  work. `delegation.machines` maps a label to `{ machine?: "<herdr
  machine label>", session?: "<name>", root?: "~/…", harnesses?: {…} }`:
  `machine` names a saved-machine profile (ssh target + pinned remote
  session in herdr's registry, operator-added with `machine add <host>
  --remote-session <name>` — goblin never duplicates ssh config);
  `session` alone is another local session; `root` resolves the target's
  relative cwds (absolute or `~/` for remote — server-expanded: herdr
  validates at workspace create, fail-loud through the adapter).
  `--machine` and `--session` are mutually exclusive, so the adapter
  builds one prefix per target. Harnesses are per-target:
  `machines.<label>.harnesses` (global map shape) declares what runs
  there; absent = the global map applies. Rows carry their target; ids
  and agent names are scoped per server and never mix.

  The whole `delegation` block is **boot-frozen**: the lifecycle's
  adapters and the tool's target/harness definitions are one snapshot (a
  new definition feeding a boot-built adapter could drive the old
  adapter's session). Config saves warn "restart to apply"; a post-boot
  label fails its launch loud with that hint. NULL target is the own
  local session — local launches write it, so no boot check may mislabel
  live local rows as pre-machines relics.
- **One protocol, target-agnostic (operator, 2026-10-06: "unify").**
  Launch, send, read, answer, stop behave identically local and
  forwarded. Results come from `agent read` (deep pages alternate-screen
  transcript history for full-screen agents), the report file demotes to
  herdr's documented fallback (output a transcript cannot hold) —
  instructed as ever, attached when readable here, path named when not.
  Done = herdr `idle|done` **and** `completion_seq` past the recorded
  baseline when the server reports it, else the seq-advance rule.
- **Only `src/herdr.ts` knows herdr** — a thin adapter over the CLI
  (`herdr --session <name> …` / `herdr --machine <label> …`, JSON out,
  zod-parsed; CLI errors are JSON on stderr with exit 1 and propagate
  with context). Every call logs (verb, target, outcome, ms).
- **The adapter's wire contract is pinned against the real CLI, not
  just fakes (2026-10-11).** `herdr.test.ts` fakes the runner — blind to
  upstream drift: an envelope or success-contract change breaks in
  production, not the suite (`pane run` succeeds with empty stdout while
  the adapter demanded JSON). `src/herdr.live.test.ts` is the gated
  check — `GOBLIN_HERDR_LIVE=1 bun test src/herdr.live.test.ts` boots a
  disposable `goblin-drift` session (never `default` or `goblin`), drives
  every verb end to end, tears it down. Run it after any herdr upgrade;
  red means the CLI moved: re-pin with one throwaway-session probe, fix
  the adapter, never discover it live.
- **One lifecycle owner.** `src/delegation-lifecycle.ts` owns the
  protocol end to end — launch, send, stop, read, the watcher's verdicts,
  boot recovery — including every workspace close owed by a row that
  stopped or failed while someone else held it. The tool validates model
  input and renders outcomes; the store (`delegations.ts`) stays pure
  rows; the ticker is a thin timer over the owner's scan. The protocol
  (stop-vs-launch races, cleanup on stop/failed/recovery) has one home,
  not two.
- **Harnesses are config, never guessed.** `delegation.harnesses` maps a
  name to a herdr agent `kind` plus native args — the operator's choice
  of full-auto flags and model lives there. Goblin never picks a model
  for a harness; absent args mean the harness's own defaults. Absent
  `delegation` block = tool absent.
- **Agents run full-auto; goblin never answers approvals.** Harnesses
  start in their no-approval mode (the configured args); nothing to
  approve, and no new trust level — goblin already has `bash`. If an
  agent still stops (`blocked`, or ends its turn with a question), goblin
  relays it to the topic and types the operator's answer back, never
  inventing one. Startup dialogs are the trap: a codex trust-directory
  prompt reported as `idle` (2026-09-26 probe) and
  `--dangerously-bypass-approvals-and-sandbox` does not skip it (codex
  0.155.1); directory trust is harness config (codex:
  `[projects."<dir>"] trust_level` in `~/.codex/config.toml`; claude:
  `bypassPermissionsModeAccepted` + `projects["<cwd>"]` trust flags in
  `~/.claude.json`). Launch pre-seeds those stores per kind
  (`harness-trust.ts`, added 2026-10-03, hardened 2026-10-04 —
  **write-if-absent only**: an explicit `false`/`"untrusted"` the
  operator recorded stands; seeding never manufactures a "yes" from a
  remembered "no"). Files are edited, never reformatted — TOML gets a
  parse-first check plus one surgical line (into the existing section,
  after its last dotted key, or as an appended table), and a file we
  can't extend safely fails the launch instead of corrupting; symlinked
  settings write through to the managed target, never replace the link.
  Remote targets get the same markers through the delegation's root pane
  (`pane run` of a write-if-absent shell snippet before `agent start` — a
  fresh host has no harness state, so the absent-path write is the whole
  job, and the pane is a shell goblin just created, owing no new
  transport). Panes run the operator's interactive shell, so aliases apply: args
  duplicating an alias's flags make the harness refuse to start. Start
  relies on herdr's ready gate plus the watcher's stall rule, not
  screen-scraping.
- **The seeded trust keys are pinned against the installed harnesses,
  not just fakes (2026-10-11).** Drift is silent: a renamed key still
  seeds, and the launch shows the consent dialog anyway.
  `src/harness-trust.live.test.ts` (`GOBLIN_HARNESS_TRUST_LIVE=1`) seeds
  a temp HOME through the real entry, asserts the pinned key names still
  get written, then greps the installed codex/claude binaries for those
  exact literals — property/string literals in both bundles, so a rename
  is visible without launching anything (nothing real is touched: no
  cost, no auth, no panes). Run after harness upgrades; red means re-pin
  — probe the new bundle for the renamed key, fix `harness-trust.ts`,
  never discover it in a live launch.
- **State is rows.** `delegations` table in `goblin.sqlite`
  (`src/delegations.ts`): name, harness, cwd, task, pinned address, herdr
  agent name + pane/workspace ids, status
  (`starting|running|needs_input|done|failed|stopped`), the herdr
  `state_change_seq` observed after prompting (**null while
  baseline-pending** — a failed post-prompt read never stands a
  pre-prompt value in; the next scan captures, 2026-10-08, #95), the
  prompt time (captured *before* the prompt is sent), created/finished
  timestamps. Survives restarts; the herdr unit keeps the panes alive
  meanwhile. `starting` is invisible to the watcher and flips to
  `running` in one write once the prompt landed; a `starting` row at
  watcher boot
  means goblin died mid-start → close its workspace, notify, `failed`.
  `prompt_pending` marks a row whose task never reached the agent: a
  startup-blocked launch parks `needs_input` with the task owed rather
  than dying — herdr rejects `agent start` on a blocked agent
  (`agent_not_ready`) and `agent prompt` on one too (`agent_blocked`) —
  so the watcher delivers it on the first seq advance past the park,
  whether the dialog was answered through `delegate answer` or the
  operator's own attach.
- **Watcher writes are compare-and-set; the notice lands first.** Every
  transition applies only if status and prompt time still match what it
  read (a `send` or `stop` mid-poll wins) and only after its notice
  landed — an unsubmitted notice leaves the row as-is for the next tick.
  `stop` marks `stopped` only when the workspace closed, none was bound,
  or herdr confirms the agent is gone; otherwise the row stays watched
  and the tool reports it. One exception: a row whose target label left
  config stops by verdict, not observation — the operator's explicit
  stop wins over "can't prove dead", and the note says the agent may
  still run host-side (restore the entry to retire it by hand). An
  unreachable target stays cannot-observe.
- **Start**: one herdr workspace per delegation (cwd = the task's
  directory, label = name), `agent start <name> --kind <kind> --pane
  <root> -- <args>`, then `agent prompt` with the task plus one appended
  instruction: write the final report to
  `$GOBLIN_HOME/state/delegations/<id>/report.md`; on a machine target
  the same shape under the target's `root` (the fallback file — see One
  protocol). **No concurrency cap** (operator, 2026-10-06): `maxRunning`
  is gone — the tool never refuses on volume; how much runs, where, is
  goblin's judgment.
- **Watcher ownership and shutdown.** One lifecycle ticker may own a
  delegations store object at a time; duplicate starts throw. `stopTicker`
  fences new scans and joins existing work — the in-flight scan plus every
  in-flight launch/send/answer/stop/read — before releasing ownership.
  Later ticks on the old handle only join that work or do nothing; a new
  owner may start after the stop promise settles. Shutdown closes the store
  right after `stopTicker` settles; an op running past that close would
  throw and strand its row's transition (a live agent's row would stay
  `starting`, and boot recovery would kill the workspace as an interrupted
  launch).
- **The watcher is an in-process ticker** (15 s), the scheduler's twin:
  per `running`/`needs_input` row, `agent get`, serialized per target
  (forwarded calls are ssh round trips — 45 s local, 90 s forwarded
  budget). Scans share one in-flight promise through a `.finally`
  wrapper, never the work promise itself — a scan completing without a
  single `await` (an empty store at boot) otherwise cleans up before the
  assignment lands and wedges the ticker forever (found 2026-10-04). Done
  = status `idle|done` **and** either `state_change_seq` advanced past the
  recorded one (a fresh prompt is idle before it's working) or a report
  file newer than the last prompt (catches a finish before the baseline
  read; freshness keeps an old report from closing a follow-up). A
  baseline-pending row (null — the post-prompt `get` failed) gets **no
  verdict**: the scan captures the seq under the same CAS every watcher
  write uses; the next scan judges against it — except a parked row
  whose agent is unblocked, whose owed prompt is delivered in that
  capture scan (its advance already happened while the baseline was
  missing; judging against just-captured "now" would never fire). An
  agent already finished at capture settles there too (#119, 2026-10-08):
  the completion cannot advance the captured seq, so a report newer than
  the prompt attributes it to this run and reads done; without one the
  row parks at `needs_input` (attribution unknowable from outside; the
  screen tail shows the truth, the row stays follow-up-able, and a failed
  notice leaves the pending posture for the next scan). Blocked →
  `needs_input`, notify once. Idle with no seq advance 90 s after
  prompting → `needs_input` ("likely stuck on a
  startup dialog"). Parking re-baselines the seq; a parked row resumes
  on *any* seq advance, not a `working` glimpse — an operator attached
  through `herdr session attach` can finish the exchange between polls.
  Agent gone (pane closed, process exited) → `failed`. A machine target
  that cannot be reached (ssh, auth, ACL — the launch proves the link
  with one forwarded `agent get` for a nonexistent name:
  `agent_not_found` means the link answered, else the launch fails with
  herdr's own error; forwarding never falls back or retries) is
  **cannot observe**, not agent gone: rows stay watched, the error logs,
  the agent runs host-side. Every transition submits one message into
  the pinned conversation, as program fires do: `[delegation: #<id>
  <name> · <done|needs input|failed>]` + the `agent read` transcript
  (deep), or the report file when readable here (capped at 16 KiB;
  beyond that, its path), or its path when another host. The turn tells
  the operator what happened in goblin's voice.
  Reports and screen tails ride fenced like program events (`<event
  source="delegation">`, any `</event` neutralized) — untrusted data,
  never instructions: delegated output (or a malicious repo it
  processed) gains no authority by arriving in goblin's voice; `read`'s
  screen output rides the same fence.
- **Management is the `delegate` tool**
  (start/list/read/send/answer/stop), bound per-turn to the running
  conversation like `program`. `read` peeks the screen tail; `send`
  prompts the agent (an answer, or a follow-up to a finished
  delegation — any status but `stopped`; it re-appends the report-file
  instruction on every prompt, resets the seq baseline (pending posture
  on a failed post-prompt read, #95), and flips the row back to
  `running`); `answer` presses one whitelisted key on a *blocked* agent's
  dialog via `send-keys` — the only input a blocked agent accepts —
  strictly relaying the operator's stated choice; `stop` interrupts and
  closes the workspace. Notices and `list` carry the stable `#id` and the
  report-file path. A launch's failure screen travels fenced like a
  `read` result, never interpolated into error prose. Done delegations
  keep their workspace so the operator can inspect it; `stop` on a
  finished one is the cleanup.
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
  panes aren't delegations (no ids, no async results); it runs the
  2026-10-13 procedure's checks in code. Session is hard-coded `default`
  (not a knob; 2026-09-26 stands for `delegate`), reaching the one
  session goblin doesn't host. It never creates, closes, moves, renames,
  or sends raw keys/text, and is not in `script`'s callable set —
  prompting his panes is deliberate per-call work, not scriptable
  fan-out. Backend: `OperatorHerdr`, a separate adapter in `src/herdr.ts`
  sharing the delegation adapter's call/logging path. Verbs:
  - `list {}` — every agent in `default`, named or not: `pane_id`,
    workspace id+label, tab id+label, kind, `cwd`, `terminal_title`,
    status, `name` when set. `agent list` joined with `workspace list`
    plus per-workspace `tab list --workspace <id>` (the scoped form
    can't regress); an empty set returns `[]` without those round-trips,
    and vanished topology rows get null labels, never invented. The list
    rides the untrusted fence: labels, titles and cwds are
    remote-controlled metadata.
  - `read {pane, lines?}` — `agent read --source recent-unwrapped`
    (default 200 lines, max 1000), fenced like a delegation `read`; his
    context, quoted only as far as asked.
  - `prompt {pane, expect, text}` — `expect` is the kind the model
    believes is there. The adapter reads topology labels, then `agent get
    <pane>` as the LAST read before sending, and refuses
    (`HerdrRefusal`: missing/non-agent, pane id resolved elsewhere, kind
    mismatch) before any bytes reach the pane; then one `agent prompt
    --wait --until working --until blocked --timeout 120000 -- <pane>
    <text>` (the `--` keeps leading-dash text literal). The wait sees
    working or blocked, not completion or a new turn — an already-working
    agent may still be on its previous turn. Process budget 125 s sits
    above the CLI's 120 s so `timeout`, `agent_prompt_stalled`, and
    `agent_blocked` arrive as herdr's codes, not our kill. A timeout is
    not non-delivery: no retry, in code or by the model, and no post-send
    reads that could turn delivery into an error. Abort signals gate
    every CLI boundary (each call, and the get→send seam). The result
    echoes the identity actually hit (pane, kind, matched status, cwd,
    workspace/tab label). The kind check applies at get time: it cannot
    catch a same-kind replacement or an occupant change in the
    get-to-send gap. A `/stop` during the send can only kill the wait,
    not unsend the prompt.

  Targets are pane IDs: two pi agents in one cwd share kind, cwd, tab,
  and title, so the pane ID is the only handle on unnamed agents (probed
  2026-10-14, throwaway session). Closed pane IDs are never reused, so a
  stale ID either fails or lands on that pane's current occupant; the
  kind check catches a different-kind occupant (the w8B:p8-vs-p1
  misfire was pi-vs-devin), not a same-kind replacement — accepted. herdr
  agent names were rejected as the target: operator-launched agents are
  unnamed. Wire facts: an unnamed record omits `name` — the delegation
  `agentSchema`'s required `name` must not be reused here — and carries
  `tab_id`, `terminal_title`, `agent_session`. Every call logs verb,
  pane, expected/resolved kind/cwd/status, and outcome; this module never
  logs the prompt text (the per-turn `tool call` line records bounded
  tool input like every tool — conversation history, not extra
  exposure). The herdr skill's operator section points at the tool. The
  seeded skill (v2.2) syncs to the live workspace only with the approved
  backend deploy — not ahead of it.
- **Goblin may delegate on its own judgment** within a turn — long or
  coding-heavy work belongs in a harness, not in a lane-blocking `bash`
  call — and says that it did. Which harness (2026-10-11): work on the
  operator's projects goes to his agents through herdr; standalone
  code-heavy work goes to goblin's own worker subagent, and screen work
  to a computer subagent — never herdr (design/subagents.md → Routing).
  That judgment includes the target: work tied to another host's repos
  runs there, and the machine list rides the tool's description. `/stop`
  fences goblin's turn, not delegations: they aren't turns. `delegate
  stop` ends one.

Still out: subagent fleets inside goblin (a delegation is one external
agent per task, not an orchestrator), nesting, fan-out tooling, ACP, the
AI SDK harness wrappers.
