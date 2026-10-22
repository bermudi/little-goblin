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
- **No concurrency cap** (operator, 2026-10-06): `maxRunning` is gone —
  the tool never refuses on volume; how much runs, where, is goblin's
  judgment.
- **A machine target's link is proven at launch by one forwarded `agent
  get` for a nonexistent name** — `agent_not_found` means the link
  answered, else the launch fails with herdr's own error; forwarding
  never falls back or retries. An unreachable target is **cannot
  observe**, not agent gone: its rows stay watched, the error logs, the
  agent runs host-side. A parked row resumes on _any_ seq advance, not
  a `working` glimpse — an attached operator can finish the exchange
  between polls. A completion that folds into a captured baseline
  settles from a fresh local report or parks `needs_input` —
  attribution is unknowable from outside (#119, 2026-10-08).
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
  nothing sent); a send-time error leaves delivery uncertain, and a
  timeout is not non-delivery: no retry, in code or by the model, and
  no post-send reads that could turn delivery into an error. This
  module never logs the prompt text (the per-turn tool line records
  bounded tool input like every tool — conversation history, not extra
  exposure). The list rides the untrusted fence: labels, titles and
  cwds are remote-controlled metadata. The herdr skill's operator
  section points at the tool; the seeded skill (v2.2) syncs to the live
  workspace only with the approved backend deploy — not ahead of it.
- **Goblin may delegate on its own judgment** within a turn — long or
  coding-heavy work belongs in a harness, not in a lane-blocking `bash`
  call — and says that it did. Which harness (2026-10-11): work on the
  operator's projects goes to his agents through herdr; standalone
  code-heavy work goes to goblin's own worker subagent, and screen work
  to a computer subagent — never herdr (design/subagents.md → Routing).
  That judgment includes the target: work tied to another host's repos
  runs there. `/stop` fences goblin's turn, not delegations: they aren't
  turns. `delegate stop` ends one.

Still out: subagent fleets inside goblin (a delegation is one external
agent per task, not an orchestrator), nesting, fan-out tooling, ACP, the
AI SDK harness wrappers.
