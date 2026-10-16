# Delegation — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Delegation (other harnesses, via herdr)

On demand (2026-09-26): goblin hands work to other coding harnesses
(codex, claude, pi, devin, opencode, …) and gets on with the chat;
the result comes back to the topic it was delegated from — or, when
launched from the bot DM, to the app conversation it spins off (App
channel → Spin-off, ruling 2026-10-03). The AI SDK
wrappers for harnesses (`ai-sdk-provider-codex-cli`,
`…-claude-code`) were considered and rejected: they cover two
harnesses, run in-process (die on restart), and nobody can watch
them. Instead harnesses run **interactively in herdr** — herdr is
the agent automation layer already on the host: it recognizes
agents in panes, owns their lifecycle
(`idle|working|blocked|done|unknown`), gates startup readiness,
submits prompts, relays UI keys, waits on lifecycle states, and
collects transcript history on demand. The operator can `herdr
session attach goblin` at any time to watch or take over.
Delegations are **goblin's own acts**: a result returns to the
conversation that spawned it, goblin decides what the operator
hears, and Telegram rings for `needs_input` (goblin needs a human) —
not for routine completions.

Rulings:

- **The herdr session is its own systemd user unit**
  (`deploy/goblin-herdr.service`: `herdr --session goblin server`),
  which `goblin.service` `Wants=`/`After=`. Not a child of goblin:
  systemd stops a unit's whole cgroup, so a spawned session would
  kill every running delegation on each goblin restart. Verified
  2026-09-26: a named headless session starts and drives agents
  under the service's stripped env (no `HERDR_ENV`, service PATH).
  `install.sh` installs both. One session, named by the unit: the
  name `goblin` exists only in the unit's `--session`, and
  `delegation` has no session knob (dropped 2026-09-26 — an
  override could target a herdr session the unit does not host).
- **Targets (2026-10-06, superseding single-`machine` mode): the
  own **local** session plus configured machines.** Goblin's own
  local session — the unit's on the host goblin itself runs on,
  never a config knob (2026-09-26 stands) — is the default target
  for goblin's internal work. `delegation.machines`
  maps a label to `{ machine?: "<herdr machine label>", session?:
  "<name>", root?: "~/…", harnesses?: {…} }`: `machine` names a
  saved-machine profile (ssh target + pinned remote session live in
  herdr's registry, added by the operator with `machine add <host>
  --remote-session <name>` — goblin never duplicates ssh config);
  `session` alone is another local session; `root` resolves the
  target's relative cwds (remote paths must be absolute or `~/` —
  server-expanded, so no local stat: herdr validates at workspace
  create, fail-loud through the adapter). `--machine` and
  `--session` are mutually exclusive on the CLI, so the adapter
  builds one prefix per target. Harness availability is a property
  of the target host: `machines.<label>.harnesses` (same shape as
  the global map) declares what runs there; absent = the global map
  applies. Rows carry their target; ids and agent names are scoped
  per server and never mix.

  The whole `delegation` block is **boot-frozen**: the lifecycle's
  adapters and the tool's target/harness definitions are one
  snapshot (a live definition feeding a boot-built adapter could
  send a launch's paths from a new definition into the old
  adapter's session). Config saves warn "restart to apply"; a
  post-boot label fails its launch loud with that hint. NULL target is the
  own local session — local launches write it today, so no boot check
  may mislabel live local rows as pre-machines relics.
- **One protocol, target-agnostic (operator, 2026-10-06: "unify").**
  Launch, send, read, answer, stop behave identically local and
  forwarded. Results are collected by `agent read` (deep reads page
  alternate-screen transcript history for full-screen agents) — the
  report file demotes to the fallback herdr's own docs give it
  (output a transcript cannot hold): instructed as ever, attached
  when readable on this host, path named when it is not. Done =
  herdr `idle|done` **and** `completion_seq` advanced past the
  recorded baseline when the server reports it, else the
  seq-advance rule.
- **Only `src/herdr.ts` knows herdr** — a thin adapter over the CLI
  (`herdr --session <name> …` / `herdr --machine <label> …`, JSON out, zod-parsed; CLI errors are
  JSON on stderr with exit 1 and propagate with context). Every call
  logs (verb, target, outcome, ms).
- **The adapter's wire contract is pinned against the real CLI, not
  just fakes (2026-10-11).** `herdr.test.ts` fakes the runner —
  hermetic, but blind to upstream drift: a herdr upgrade changing an
  envelope shape or a success contract broke in production at
  runtime, not in the suite (found live when the check was written:
  `pane run` succeeds with empty stdout and the adapter's JSON demand
  threw on every successful call). `src/herdr.live.test.ts` is the
  gated drift check — `GOBLIN_HERDR_LIVE=1 bun test
  src/herdr.live.test.ts` boots a disposable `goblin-drift` session
  (never `default` or `goblin`), drives the adapter's verbs end to
  end, and tears the session down. Run it after any herdr upgrade;
  red means the CLI moved: re-pin with one throwaway-session probe,
  fix the adapter, never discover it live.
- **One lifecycle owner.** `src/delegation-lifecycle.ts` owns the
  delegation protocol end to end — launch, send, stop, read, the
  watcher's verdicts, boot recovery — including every workspace close
  owed by a row that stopped or failed while someone else held it.
  The tool validates model input and renders outcomes; the store
  (`delegations.ts`) stays pure rows; the ticker is a thin timer over
  the owner's scan. The same owner shape as the scheduler over
  programs and the approval gate over the mail outbox. A replacement
  that only forwards the old tool calls would be a shallow layer —
  the owner exists because the protocol (stop-vs-launch races,
  cleanup on stop/failed/recovery) has one home, not two.
- **Harnesses are config, never guessed.** `delegation.harnesses`
  maps a name to a herdr agent `kind` plus native args — the
  operator's choice of full-auto flags and model live there.
  Goblin never picks a model for a harness; absent args mean the
  harness's own defaults. Absent `delegation` block = tool absent.
- **Agents run full-auto; goblin never answers approvals.** The
  operator's ruling: harnesses start in their no-approval mode (the
  configured args), so there is nothing to approve. This is not a
  new trust level — goblin already has `bash`. If an agent still
  stops (`blocked`, or ends its turn with a question), goblin relays
  it to the topic and types the operator's answer back; it never
  invents one. Startup dialogs are the known trap: herdr reported a
  codex trust-directory prompt as `idle` in the 2026-09-26 probe, and
  `--dangerously-bypass-approvals-and-sandbox` does not skip it
  (codex 0.155.1) — directory trust is harness config (codex:
  `[projects."<dir>"] trust_level` in `~/.codex/config.toml`; claude:
  `bypassPermissionsModeAccepted` + `projects["<cwd>"]` trust flags in
  `~/.claude.json`). So launch pre-seeds those stores per kind
  (`harness-trust.ts`, added 2026-10-03, hardened 2026-10-04 —
  **write-if-absent only**: an explicit `false`/`"untrusted"` the
  operator recorded stands; seeding never manufactures a "yes" out of
  a remembered "no". Files are edited, never reformatted — TOML gets
  a parse-first check plus a single surgical line (into the existing
  section, after its last dotted key, or as an appended table), and a
  file we can't extend safely fails the launch instead of corrupting;
  symlinked settings write through to the managed target, never
  replace the link). Remote targets get the same markers through
  the delegation's own root pane (`pane run` of a write-if-absent
  shell snippet, before `agent start` — a fresh host starts with no
  harness state, so an absent-path write is the whole job; the pane is
  a shell goblin just created, so no new transport is owed).
  Panes
  run the operator's interactive shell, so shell aliases apply: args
  that duplicate an alias's flags make the harness refuse to start.
  Start relies on herdr's ready gate plus the watcher's stall rule,
  not on screen-scraping.
- **The seeded trust keys are pinned against the installed
  harnesses, not just fakes (2026-10-11).** Drift here is silent by
  nature: upstream renaming a key means the seed still succeeds and
  the launch shows the consent dialog anyway.
  `src/harness-trust.live.test.ts` (`GOBLIN_HARNESS_TRUST_LIVE=1`)
  seeds a temp HOME through the real entry, asserts the module still
  writes the pinned key names, then greps the installed
  codex/claude binaries for those exact literals — the keys are
  property/string literals in both bundles, so a rename is visible
  without launching anything (no harness is ever started: no cost,
  no auth, no panes; nothing real is touched). Run after harness
  upgrades; red means re-pin — probe the new bundle for the renamed
  key, fix `harness-trust.ts`, never discover it in a live launch.
- **State is rows.** `delegations` table in `goblin.sqlite`
  (`src/delegations.ts`): name, harness, cwd, task, pinned address,
  herdr agent name + pane/workspace ids, status
  (`starting|running|needs_input|done|failed|stopped`), the herdr
  `state_change_seq` observed after prompting (**null while
  baseline-pending** — a failed post-prompt read never stands a
  pre-prompt value in; the next scan captures, 2026-10-08, #95), the
  prompt time (captured *before* the prompt is sent), created/finished
  timestamps. Survives goblin restarts; the herdr unit keeps the
  panes alive meanwhile. `starting` is invisible to the watcher and
  flips to `running` in one write once the prompt landed; a
  `starting` row seen at watcher boot means goblin died mid-start →
  close its workspace, notify, `failed`. `prompt_pending` marks a row whose task
  never reached the agent: a startup-blocked launch parks
  `needs_input` with the task owed rather than dying — herdr rejects
  `agent start` on a blocked agent (`agent_not_ready`) and `agent
  prompt` on one too (`agent_blocked`), so the task is delivered by
  the watcher on the first seq advance past the park — whether the
  dialog was answered through `delegate answer` or the operator's own
  attach.
- **Watcher writes are compare-and-set; the notice lands first.**
  Every watcher transition applies only if status and prompt time
  still match what it read (a `send` or `stop` mid-poll wins), and
  only after its notice landed — an unsubmitted notice leaves the row
  as-is for the next tick. `stop` marks `stopped` only when the
  workspace closed, none was bound, or herdr confirms the agent is
  gone; otherwise the row stays watched and the tool reports it.
  One exception: a row whose target label left config stops by
  verdict, not observation — the operator's explicit stop wins over
  "can't prove dead", and the note says the agent may still run
  host-side (restoring the entry is the way to retire it by hand).
  For the watcher, an unreachable target stays cannot-observe.
- **Start**: one herdr workspace per delegation (cwd = the task's
  directory, label = name), `agent start <name> --kind <kind> --pane
  <root> -- <args>`, then `agent prompt` with the task plus one
  appended instruction: write the final report to
  `$GOBLIN_HOME/state/delegations/<id>/report.md`; on a machine
  target the instruction names the same shape under the target's
  `root` (the fallback file — see One protocol). herdr's own guide
  treats file output as the fallback for results a screen can't
  hold. **No concurrency cap** (operator, 2026-10-06): `maxRunning`
  is gone — the tool never refuses on volume; how much runs, where,
  is goblin's judgment.
- **Watcher ownership and shutdown.** One lifecycle ticker may own a
  delegations store object at a time; duplicate starts throw. `stopTicker`
  fences new scans and joins existing work — the in-flight scan plus every
  in-flight launch/send/answer/stop/read — before releasing ownership.
  Later ticks on the old handle only join that work or do nothing; a new
  owner may start after the stop promise settles. Shutdown depends on the
  join: it closes the store right after `stopTicker` settles, and an op
  running past that close would throw and strand its row's transition
  (a live agent's row would stay `starting` and boot recovery would kill
  the workspace as an interrupted launch).
- **The watcher is an in-process ticker** (15 s), the scheduler's
  twin: for each `running`/`needs_input` row, `agent get`,
  serialized per target (forwarded calls are ssh round trips —
  45 s local, 90 s forwarded budget). Scans share one in-flight
  promise — but the shared slot must be a `.finally`
  wrapper, never the work promise itself: a scan that completes
  without a single `await` (an empty store at boot) runs its cleanup
  before the assignment lands and wedges the ticker on a dead promise
  forever (found 2026-10-04 — the boot scan on an empty DB killed the
  watcher for the process's lifetime). Done =
  status `idle|done` **and** either `state_change_seq` advanced past
  the recorded one (a fresh prompt is idle before it's working) or a
  report file newer than the last prompt (catches an agent that
  finished before the baseline read; freshness keeps an old report
  from closing a follow-up). A baseline-pending row (null — the
  post-prompt `get` failed) gets **no verdict**: the scan captures
  the seq it can see under the same CAS every watcher write uses and
  returns; the next scan judges against it. The one exception is a
  parked row whose agent is no longer blocked — the advance its
  owed-prompt delivery keys on already happened while the baseline
  was missing, so the prompt is delivered in that same capture scan
  (comparing against just-captured "now" would never fire). An agent
  that already finished when the capture lands settles in that same
  scan (#119, 2026-10-08): the completion is folded into the captured
  seq and can never advance past it, so waiting is a strand — a
  report newer than the prompt attributes the completion to this run
  and reads done; without one the attribution is unknowable from
  outside and the row parks at `needs_input` (the screen tail shows
  the operator the truth, the row stays follow-up-able, and a notice
  that fails to land leaves the pending posture so the next scan
  retries). Blocked →
  `needs_input`, notify once.
  Idle with no seq advance 90 s after prompting → `needs_input`
  ("likely stuck on a startup dialog"). Parking re-baselines the seq;
  a parked row resumes on *any* seq advance, not a `working` glimpse
  — an operator answering through `herdr session attach` can finish
  the whole exchange between two polls. Agent gone (pane closed,
  process exited) → `failed`. A machine target that cannot be
  reached (ssh, auth, ACL — the launch proves the link with one
  forwarded `agent get` for a name that cannot exist:
  `agent_not_found` means the link answered; anything else fails
  the launch with herdr's own error, and herdr forwarding never
  falls back and never retries) is **cannot observe**, not agent gone:
  rows stay watched, the error is logged, and the agent keeps
  running host-side. Every transition submits one message
  into the pinned conversation, the same path as program fires:
  `[delegation: #<id> <name> · <done|needs input|failed>]` + the
  transcript collected by `agent read` (deep — pages alternate-screen
  history for full-screen agents), or the report file when one is
  readable on this host (capped at 16 KiB; beyond that, the path to
  read), or the file's path named when it lives on another host. The
  resulting turn tells the operator what happened, in goblin's
  voice. Reports and screen tails ride fenced like program events
  (`<event source="delegation">`, any `</event` neutralized) —
  untrusted data, never instructions: a delegated agent's output (or
  a malicious repo it processed) gains no authority by arriving in
  goblin's voice. The `read` action's screen output rides the same
  fence.
- **Management is the `delegate` tool**
  (start/list/read/send/answer/stop), bound per-turn to the running
  conversation like `program`. `read` peeks the screen tail; `send`
  prompts the agent (an answer, or a follow-up to a finished
  delegation — any status but `stopped`; it re-appends the
  report-file instruction on every prompt, resets the seq baseline
  (a failed post-prompt read records the pending posture — never the
  previous run's value, #95), and flips the row back to `running`); `answer` presses one
  whitelisted key on a *blocked* agent's dialog via `send-keys` —
  the only input a blocked agent accepts — strictly relaying the
  operator's stated choice; `stop` interrupts and closes the
  workspace. Notices and `list` carry the stable `#id` and the
  report-file path. A launch's failure screen travels fenced like a
  `read` result, never interpolated into error prose. Done
  delegations keep their workspace so the operator can inspect it;
  `stop` on a finished one is the cleanup.
- **The operator's session is reachable on ask, only through the
  `herdr` tool (2026-10-13, tool-enforced 2026-10-14).** When the
  operator points goblin at a tab in `default` ("send the P2s to Devin
  on tab 1"), `delegate` can't express it — those panes aren't
  goblin's delegations. Inspection and prompting of `default` go
  through the `herdr` tool — pane IDs, a kind check at send time —
  never the raw CLI from bash. What it reads is his context, quoted
  back only as far as requested. Raw `pane send-text`/`send-keys`
  into an agent pane is banned: a P2 handoff went line-by-line into
  the π review pane (`w8B:p8`) instead of devin (`w8B:p1`), was
  submitted with a manual Enter, and only the recipient's quota
  error contained it — that misfire is why the procedure is code.
- **A `herdr` tool reaches the operator's session (2026-10-14,
  implemented).** The 2026-10-13 procedure was model discipline over
  raw bash; the tool runs the checks in code. A new narrow tool, not
  a `delegate` extension: delegations are goblin's own acts with ids
  and async results, and his panes are neither. Session is
  hard-coded `default` — not a knob, so 2026-09-26 stands for
  `delegate`; this tool exists only to reach the one session goblin
  doesn't host. It never creates, closes, moves, renames, or sends
  raw keys/text, and it is not in `script`'s callable set —
  prompting his panes is deliberate per-call work, not scriptable
  fan-out. The backend is a separate `OperatorHerdr` adapter in
  `src/herdr.ts` sharing the delegation adapter's call/logging path.
  Verbs:
  - `list {}` — every agent in `default`, named or not: `pane_id`,
    workspace id+label, tab id+label, kind, `cwd`,
    `terminal_title`, status, `name` when set. `agent list` joined
    against `workspace list` plus a per-workspace `tab list
    --workspace <id>` (the unscoped form happens to cover all
    workspaces today; the scoped form can't regress). An empty
    agent set returns `[]` without the topology round-trips, and a
    record whose topology rows vanish mid-read gets null labels —
    never an invented one. The rendered list rides the untrusted
    fence: labels, titles and cwds are remote-controlled metadata.
  - `read {pane, lines?}` — `agent read --source recent-unwrapped`
    (default 200 lines, max 1000), fenced like a delegation
    `read`; his context, quoted back only as far as asked.
  - `prompt {pane, expect, text}` — `expect` is the agent kind the
    model believes is there. The adapter reads topology labels
    first, then `agent get <pane>` as the LAST read before sending
    and refuses (`HerdrRefusal`: missing/non-agent, pane id that
    resolved elsewhere, kind mismatch) before any bytes reach the
    pane; then a single `agent prompt --wait --until working
    --until blocked --timeout 120000 -- <pane> <text>`. The `--`
    keeps leading-dash text literal. The wait observes working or
    blocked, not task completion or a new turn: an already-working
    agent may still be on its previous turn. The process budget sits above
    the CLI's own wait (125 s vs 120 s) so `timeout`,
    `agent_prompt_stalled`, and `agent_blocked` arrive as herdr's
    codes, not our kill. A timeout is not non-delivery — no retry,
    in code or by the model, and no post-send reads that could turn
    a delivered prompt into an error. Abort signals gate every CLI
    boundary (before each call, and the get→send seam). The result
    echoes the identity actually hit (pane, kind, matched status,
    cwd, workspace/tab label). The kind check applies at get time:
    it cannot catch a same-kind replacement or any occupant change
    in the get-to-send gap. A `/stop` during the send can only kill
    the wait, not unsend the prompt.

  Targets are pane IDs: two pi agents in one cwd share kind, cwd,
  tab, and title — the pane ID is the only handle that tells unnamed
  agents apart (probed 2026-10-14, throwaway session). Closed pane IDs
  are never reused, so a stale ID either fails or lands on that
  pane's current occupant; the kind check catches a different-kind
  occupant (the w8B:p8-vs-p1 misfire was pi-vs-devin) but not a
  same-kind replacement — accepted. herdr agent names (unique, follow
  the occupant, cleared on exit) were weighed and rejected as the
  target: operator-launched agents are unnamed. Wire facts for the
  adapter: an unnamed agent's record omits `name` — the delegation
  `agentSchema`'s required `name` must not be reused here — and
  records carry `tab_id`, `terminal_title`, and `agent_session`. Every
  call logs verb, pane, expected/resolved kind/cwd/status, and
  outcome; this module never logs the prompt text (the generic
  per-turn `tool call` line still records bounded tool input like
  every tool — that is conversation history, not extra exposure).
  The herdr skill's operator section points at the tool; raw
  `herdr` from bash against `default` stays banned for tasking.
  The seeded skill (v2.2) syncs to the live workspace only with the
  approved backend deploy — not ahead of it.
- **Goblin may delegate on its own judgment** within a turn — long or
  coding-heavy work belongs in a harness, not in a lane-blocking
  `bash` call — and says that it did. Which harness (2026-10-11):
  work on the operator's projects goes to his agents through herdr;
  standalone code-heavy work goes to goblin's own worker subagent, and
  screen work to a computer subagent — never herdr
  (design/subagents.md → Routing). That judgment includes the
  target: work tied to another host's repos runs there, and the
  machine list rides the tool's description. `/stop` fences goblin's turn,
  not delegations: they aren't turns. `delegate stop` ends one.

Still out: subagent fleets inside goblin (a delegation is one
external agent per task, not an orchestrator), nesting, fan-out
tooling, ACP, the AI SDK harness wrappers.
