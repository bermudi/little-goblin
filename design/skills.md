# Skills — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Skills

Skills are the Agent Skills format (agentskills.io): one directory per
skill holding a `SKILL.md`. `allowed-tools` is spec-experimental —
nothing here enforces per-skill tool scope; `disable-model-invocation`
is a non-spec extension the operator's catalog carries, honored as
manual-only.

One catalog, fixed: `workspace/skills/`, inside the agent's cwd so goblin
can author its own. Publishing is an ordinary write at operator request —
no command, registry, cache, or tombstone — live at the next conversation
boundary (a DM roll or compaction; the system prompt is frozen per
conversation, the SKILL.md read fresh on use), and no ssh: the operator
asks in Telegram; goblin is already on the box. Hand-editing `skills/`
over ssh is the fallback, not the flow. Where to fetch _from_ (the
operator's skills repo, the host catalog) is deployment fact, not code,
living in the workspace `AGENTS.md`. `skills-ref validate` is installed
for authoring-time checks. Sharing in a host skill is a symlink — made
by goblin on request, or by hand; no second root, no source policy, no
selection UI.

Design-mandated skills ship from the repo, seeded write-if-absent so a
rebuilt box regains them without operator prompting or agent memory. A
seed update never overwrites an installed copy: a repo text change syncs
the live copy in the same change, except a skill requiring a new backend
tool — defer that sync until the approved deployment verifies
availability (docs/operations.md → Deploying; the herdr v2.0 seed
against a v1.0 live copy misfired a pane-send, 2026-10-13).

Invocation is `read_file` plus `bash`; activation is already observable
in the tool-call log. Still out: a skill tool, per-skill tool scoping,
fingerprints, immutable skill snapshots, additional catalog roots (host,
project), per-conversation selection, a `/skills` command or mini-app
surface.

## Skill provenance (ruling 2026-10-16)

Which skills a conversation generated must be answerable from durable
state, not the log — the PWA shows it on the thread (design/app.md →
Thread sources). Two authoring paths record into the same table at write
time — a reviewer proposal after a successful swap, a turn write. A
write's resolved output path decides the skill name — `skills/…` written
inside a project workdir is that project's file, not the catalog. Bash
is not scanned: arbitrary shell is not parseable, and approvals move
directories through bash — a string match would record an approval as a
generation. A symlinked skill dir writing through to its outside target
is a documented miss (links are second-class). The row is immutable
source; current state (installed / proposed / gone) resolves live from
the filesystem at read, so out-of-band dir moves can never desync it —
the panel shows what is recorded, never a claim of completeness.
Pre-table skills backfill from `goblin.log` in one shot — the only
surviving source for pre-deploy drafts.

## Skill reviewer

On demand (2026-09-26, the second slice of "richer inner life"). After a
turn, goblin may distill what it learned into a skill unprompted. A
better model of the operator is **not** this feature — that is Hindsight's
job (tune it, don't duplicate it).
- **Gate: System One on every completed turn** — the shared client
  (`design/system1.md`) asks two typed `noul` questions; a decision
  model, not a chat model. Both criteria sides are required — the
  OpenRouter transport rejects a one-sided noul. Either question at ≥
  its own threshold triggers a review:
  `reviewer.thresholds.correction` / `procedure` (default
  `reviewer.threshold`, 0.8; separate cutoffs may be needed). The gate
  never sees tool arguments or results (a heavy gate is a non-goal); the
  tool digest is the reviewer's evidence. A gate failure falls back to
  "≥ 8 tool calls" (trigger: procedure); the consecutive-fallback count
  makes an outage a rising number. This is an experiment: every gate
  logs both probabilities, thresholds, trigger, decision, tokens, cost,
  and latency so cost, hit rate, and outage drift are answerable from
  the log alone.
- **Evidence: the turn's tool digest and built-in tool inventory.** A
  procedure a built-in tool already performs is not a skill — a
  `transcribe`/`bash` recovery is config or a tool call, never a new
  skill (ruling 2026-10-17). A correction trigger also carries the
  previous completed turn — what's being corrected is usually the turn
  before.
- **Reviewer: staging, validation, then an atomic proposal.** A
  background model call, off the conversation lane — fire-and-forget,
  never delays the next turn; shutdown doesn't await it (a missed save
  is benign — the next similar turn re-gates — and logged). The review
  works in a private staging copy of the skills tree: **nothing live is
  touched until validation passes** (ruling 2026-09-27, superseding the
  snapshot/restore ruling) — the catalog rereads every turn and must
  never see a half-written or later-rejected skill. Read/write/edit
  tools root at the staging copy, confined lexically **and** really:
  `..`-escapes refuse, every path resolves through realpath, a symlink
  inside the root pointing out is refused for read and write
  (superseding the lexical-only ruling). Any staging failure — model
  call, abort, size budget, or validation — discards it: the live
  catalog is byte-identical either way. Each validated skill is proposed
  by a directory swap on the same filesystem into
  `skills-proposed/<name>/` — rollback on failure, never a half-updated
  proposal. A newer review replaces an undecided same-name proposal
  (latest distillation wins, logged). A pending draft is
  reviewer-owned: replacement is wholesale, hand edits inside it never
  merged or preserved (tweak after approving, or discard first). A later failed swap cannot undo earlier proposals —
  those are written to history and announced before the failure
  surfaces. A skill whose live copy changed mid-review (operator hand
  edit, undo, approval) is **skipped, never proposed from a stale
  base** — approving a stale-base proposal would clobber those bytes
  sight-unseen. Reviews serialize in turn completion order (a monotonic
  seq; gate latency must not reorder) — overlapping runs would propose
  over each other's announced writes. Approval and discard run
  out-of-band as ordinary agent shell work: an approve racing a newer
  replacement installs whatever bytes sit on disk at move time —
  accepted, not locked. The queue holds at most `reviewer.queueCap`
  (default 3) queued reviews; a full queue drops the incoming review
  and logs the drop (the newest turn is the most re-gateable).
- **/stop cancels the conversation's reviews.** Ruling 2026-09-28:
  /stop is the operator's panic lever, and a background skill-write from
  a topic the operator just fenced must not outlive it. Queued reviews
  are dropped; the in-flight one (if that conversation's) is aborted —
  staging discarded, live catalog untouched, everything logged with the
  review id. Shutdown passes through the same path.
- **Off the record means no distillation.** Ruling 2026-09-28: a
  memory-excluded conversation never gates — `/memory off` means retain
  nothing from here, and a durable skill IS retention. The skip is
  unconditional (no config flag) and logged; an excluded turn is also
  never stored as the next turn's correction context.
- **It proposes, then tells (ruling 2026-10-10).** Auto-created skills
  are proposed, not installed — the reviewer never writes the live
  catalog: a validated skill parks in `skills-proposed/<name>/` and
  installs only on operator approval. A proposal posts a short note to
  the topic ("proposed skill: X — approve to install") with an in-chat
  ✅ Install / 🚫 Discard row per skill (ruling 2026-10-13): the tap
  decides mechanically, and the decision lands in history as a system
  event, so the next turn knows; over Telegram's 64-byte callback cap
  the row degrades to the conversational notice. Approve and discard
  stay conversational as the fallback: the history event tells the next
  turn that approve means moving the dir into `skills/` (replacing any
  live copy) and discard means deleting it — goblin is already the
  operator's hands for installs. The `## skills` section lists pending
  proposals too, so an approve request works in any conversation. Manual
  installs are unchanged: the operator asking in chat IS the approval —
  the ruling covers only the unattended path.
- **Instrumentation.** Every line carries the review id; outcomes are
  where the skill dir sits, so `scripts/reviewer-stats.ts` reads the log
  back by review id and reports proposals against disk (still proposed /
  installed / gone). No UI. Good/bad turn labels don't exist yet — the
  field ships empty until they do.
- **Config.** Optional `reviewer` block; absent = feature off.
  Hand-edited-only, like delegation and mail — no mini-app surface; the
  gate's auth and thresholds are boot-captured, the review model
  resolves live per review.
