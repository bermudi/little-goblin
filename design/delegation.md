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
them. Instead harnesses run **interactively in goblin's own herdr
session** — herdr is the terminal multiplexer already on the host,
it recognizes agents in panes and reports their state
(`idle|working|blocked|done|unknown`). The operator can `herdr
session attach goblin` at any time to watch or take over.

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
- **Only `src/herdr.ts` knows herdr** — a thin adapter over the CLI
  (`herdr --session <name> …`, JSON out, zod-parsed; CLI errors are
  JSON on stderr with exit 1 and propagate with context). Every call
  logs (verb, target, outcome, ms).
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
  replace the link). Panes
  run the operator's interactive shell, so shell aliases apply: args
  that duplicate an alias's flags make the harness refuse to start.
  Start relies on herdr's ready gate plus the watcher's stall rule,
  not on screen-scraping.
- **State is rows.** `delegations` table in `goblin.sqlite`
  (`src/delegations.ts`): name, harness, cwd, task, pinned address,
  herdr agent name + pane/workspace ids, status
  (`starting|running|needs_input|done|failed|stopped`), the herdr
  `state_change_seq` observed after prompting, the prompt time
  (captured *before* the prompt is sent), created/finished
  timestamps. Survives goblin restarts; the herdr unit keeps the
  panes alive meanwhile. `starting` is invisible to the watcher and
  flips to `running` in one write once the prompt landed; a
  `starting` row seen at watcher boot means goblin died mid-start →
  close its workspace, notify, `failed`. The cap counts
  starting+running+needs_input — and a follow-up that reactivates a
  `done`/`failed` row spends a slot too (the tool refuses it like a
  fresh launch past the cap). `prompt_pending` marks a row whose task
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
- **Start**: one herdr workspace per delegation (cwd = the task's
  directory, label = name), `agent start <name> --kind <kind> --pane
  <root> -- <args>`, then `agent prompt` with the task plus one
  appended instruction: write the final report to
  `$GOBLIN_HOME/state/delegations/<id>/report.md`. herdr's own guide
  treats file output as the fallback for results a screen can't
  hold; here it is the primary channel because a TUI screen is a
  lossy transport. Concurrency cap `delegation.maxRunning` (default
  3) — the tool refuses beyond it, naming what's running.
- **The watcher is an in-process ticker** (15 s), the scheduler's
  twin: for each `running`/`needs_input` row, `agent get`. Scans share
  one in-flight promise — but the shared slot must be a `.finally`
  wrapper, never the work promise itself: a scan that completes
  without a single `await` (an empty store at boot) runs its cleanup
  before the assignment lands and wedges the ticker on a dead promise
  forever (found 2026-10-04 — the boot scan on an empty DB killed the
  watcher for the process's lifetime). Done =
  status `idle|done` **and** either `state_change_seq` advanced past
  the recorded one (a fresh prompt is idle before it's working) or a
  report file newer than the last prompt (catches an agent that
  finished before the baseline read; freshness keeps an old report
  from closing a follow-up). Blocked → `needs_input`, notify once.
  Idle with no seq advance 90 s after prompting → `needs_input`
  ("likely stuck on a startup dialog"). Parking re-baselines the seq;
  a parked row resumes on *any* seq advance, not a `working` glimpse
  — an operator answering through `herdr session attach` can finish
  the whole exchange between two polls. Agent gone (pane closed,
  process exited) → `failed`. Every transition submits one message
  into the pinned conversation, the same path as program fires:
  `[delegation: #<id> <name> · <done|needs input|failed>]` + the
  report
  file (capped at 16 KiB; beyond that, the path to read) or, absent a
  report, the screen tail (`recent-unwrapped`, last ~80 lines). The
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
  report-file instruction on every prompt, resets the seq baseline,
  and flips the row back to `running`); `answer` presses one
  whitelisted key on a *blocked* agent's dialog via `send-keys` —
  the only input a blocked agent accepts — strictly relaying the
  operator's stated choice; `stop` interrupts and closes the
  workspace. Notices and `list` carry the stable `#id` and the
  report-file path. A launch's failure screen travels fenced like a
  `read` result, never interpolated into error prose. Done
  delegations keep their workspace so the operator can inspect it;
  `stop` on a finished one is the cleanup.
- **Goblin may delegate on its own judgment** within a turn — long or
  coding-heavy work belongs in a harness, not in a lane-blocking
  `bash` call — and says that it did. `/stop` fences goblin's turn,
  not delegations: they aren't turns. `delegate stop` ends one.

Still out: subagent fleets inside goblin (a delegation is one
external agent per task, not an orchestrator), nesting, fan-out
tooling, ACP, the AI SDK harness wrappers.

