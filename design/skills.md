# Skills — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Skills

Agent Skills (agentskills.io format): one directory per skill holding
`SKILL.md` — YAML frontmatter plus a Markdown body — plus any
scripts/references/assets it points at. Frontmatter is validated per spec:
`name` + `description` required; `license`, `compatibility`, `metadata`,
`allowed-tools` shape-checked when present, then ignored for behavior —
except `compatibility`, which joins the catalog line so a skill needing
missing tools isn't a dead-end invitation. `allowed-tools` is
spec-experimental and nothing here enforces per-skill tool scope.
`disable-model-invocation` is a non-spec extension the operator's catalog
already carries; honored below. Unknown keys pass through — real skills
carry extra fields.

One catalog, fixed: `workspace/skills/`, inside the agent's cwd so goblin
can author its own — writing `skills/<name>/SKILL.md` is the whole
publishing flow, live at the next conversation boundary (a DM roll or
compaction; the system prompt is frozen per conversation, the SKILL.md
read fresh on use). Design-mandated skills ship from the repo — browser,
pass-cli, mcp, gws, herdr seeded by `ensureHomeLayout` (write-if-absent,
from `deploy/skills/<name>/SKILL.md`) — so a rebuilt box regains them
without operator prompting or agent memory. Write-if-absent also means a
seed update never overwrites an installed copy: a repo text change syncs
the live `workspace/skills/` copy in the same change, except a skill
requiring a new backend tool — defer that sync until the approved
deployment verifies availability (docs/operations.md → Deploying; the
herdr v2.0 seed against a v1.0 live copy misfired a pane-send,
2026-10-13). Sharing in a host skill is a symlink — made by goblin on
request, or by hand; no second root, no source policy, no selection UI.
One sibling directory: `workspace/skills-proposed/` holds the skill
reviewer's validated drafts — same shape, outside the catalog, listed
separately in the prompt only while pending (below).

The lifecycle is the filesystem, and the agent is the operator's hands:
**install** = "install the mq skill" in chat → goblin links or copies it
into `skills/`, fetches a repo via `bash`, or files a SKILL.md that
arrived as a Telegram attachment; **update** = edit the files; **remove**
= delete the entry. Each is live next turn — no command, registry, cache,
or tombstone, and no ssh: the operator asks in Telegram; goblin is
already on the box. Where to fetch *from* (the operator's skills repo,
the host catalog) is deployment fact, not code, living in the workspace
`AGENTS.md` so the agent knows its sources. Hand-editing `skills/` over
ssh always works; it is the fallback, not the flow. `skills-ref validate`
is installed for authoring-time checks — goblin runs it via `bash` after
writing a skill; a skipped entry plus the warn log is the failure signal
when it doesn't.

Discovery is per conversation snapshot, in `buildSystemPrompt`: scan
`skills/*/SKILL.md` (symlinks resolved), parse a bounded head of each file
for frontmatter — the body is never injected — and render a `## skills`
section listing name + description (+ compatibility when set) + path. It
renders even when the catalog is empty: the notice that the capability
exists.

- `name` must equal its directory name and follow the spec rule —
  1–64 chars, `a-z0-9` and hyphens, no leading/trailing hyphen, no
  consecutive hyphens; `description` is required, ≤1024 chars.
- `disable-model-invocation: true` excludes the skill from the list —
  manual-only. The operator can still name it; the agent can `ls skills/`
  and read it; it just isn't advertised every turn.
- A malformed entry never kills a turn: `log.warn` with path + reason,
  skip it, and the section notes the skip count so the agent can surface
  it in chat — and fix the file, when it's one it authored.
- Sorted by name; deterministic. Same-name conflicts can't exist —
  name == dirname means they'd be the same directory.

Scan contract: each entry in `skills/` is stat'ed (symlinks followed). A
directory without `SKILL.md` warns and skips; a non-directory is ignored
silently; a broken symlink warns and skips. Frontmatter is read from a
bounded head (16 KiB — a `---` that doesn't close inside it is
malformed). The catalog caps at 128 entries: over that, the
sorted-first-128 list plus a warn — a self-authored catalog that big is
already a bug worth surfacing.

The section, approximately:

```text
## skills

Skills are directories under `skills/` — each a SKILL.md (frontmatter:
name, description) with instructions plus any scripts/files it needs.
When a request matches one, read_file its SKILL.md and follow it. This
catalog is yours: write skills/<name>/SKILL.md when you learn a
repeatable task, then `skills-ref validate ./skills/<name>` via bash.
Edits load when the next conversation starts.

- mq — jq for Markdown … [Requires the mq CLI] (skills/mq/SKILL.md)
- pdf — Extract PDF text … (skills/pdf/SKILL.md)
(1 entry skipped as malformed — see goblin.log)
```

An empty catalog renders the header plus "(none yet)".

Invocation is `read_file`: the model sees the catalog line, reads the
SKILL.md when one matches, runs its scripts via `bash`. Activation is
already observable in the tool-call log — no skill tool, no per-skill
tool scoping, no snapshots, no fingerprints.

Still out — machinery that returns only on demand: additional catalog
roots (host, project), per-conversation selection, a `/skills` command or
mini-app surface, immutable skill snapshots.

## Skill provenance (ruling 2026-10-16)

Operator ask: which skills a conversation generated must be answerable
from durable state, not the log — the PWA shows it on the thread
(design/app.md → Thread sources). Two authoring paths, each recording
itself into the same table at write time:

- **Reviewer proposals** — the reviewer knows the conversation and
  review id; it records `(skill, conversation, review)` after a
  successful proposal swap.
- **Turn writes** — a `write_file`/`edit_file` call (a script's nested
  calls included) whose resolved output path lands under `skills/` or
  `skills-proposed/` records `(skill, conversation)`; the turn stream
  owns the observation because it owns the conversation id. Resolved
  paths keep project conversations honest — `skills/…` written inside a
  project workdir is that project's file, not the catalog. A symlinked
  skill dir writing through to its outside target is a documented miss
  (the state viewer's symlink precedent: links are second-class). Bash
  is not scanned: arbitrary shell is not parseable, and approvals move
  directories through bash, so a string match would record an approval
  as a generation. The miss is a documented edge, not a secret: the
  panel shows what is recorded, never a claim of completeness.

`skill_sources` in the conversation store's SQLite, keyed
`(skill, conversation_id)` — a skill regenerated in two threads shows in
both, first and last write preserved. The row is immutable source;
current state (installed / proposed / gone) resolves live from the
filesystem at read, so out-of-band dir moves can never desync it.
`GET /api/skills/from?conversation=` (both doors) is the read; the PWA
sheet never mutates skills. Backfill: a one-shot `goblin.log` parse of
`reviewer review done` lines — the only surviving source for pre-deploy
skills.

## Skill reviewer

On demand (2026-09-26, the second slice of "richer inner life"). After a
turn, goblin may distill what it learned into a skill unprompted. A
better model of the operator is **not** this feature — that is Hindsight's
job (tune it, don't duplicate it).

- **Gate: System One on every completed turn** — the shared System One
  client (`design/system1.md` — models, retry policy, wire protocol)
  asks typed `noul` questions: a decision model, not a chat model. State:
  operator message(s) (tail-first), reply (head-first), tool-call count
  and names — bounded to ~22k chars against its 32k context. The gate
  never sees tool arguments or results (a heavy gate is a non-goal); the
  digest below is the reviewer's evidence. Two `noul` questions — *did
  the operator correct how goblin did something?* / *did the turn carry
  out a repeatable multi-step procedure worth a skill?* — both criteria
  sides required, the OpenRouter transport rejects a one-sided noul.
  Either question at ≥ its own threshold → review:
  `reviewer.thresholds.correction` / `procedure` (default
  `reviewer.threshold`, 0.8; separate cutoffs may be needed). Both
  firing → correction trigger (the prior turn rides along). Not gated:
  fenced or failed turns, the reviewer's own writes (they submit no
  turns), memory-excluded turns (below). **Experiment:** every gate logs
  both probabilities, thresholds, trigger, unique tool names, decision,
  input tokens, cost, latency, and consecutive-fallback count — cost,
  hit rate, and outage drift answerable from the log alone. Any gate
  failure → "≥ 8 tool calls" fallback (trigger: procedure), logged on
  the same line; the streak count makes an outage a rising number, not
  scattered lines.
- **Evidence: a bounded tool digest, captured per turn.** The runtime
  records the last `evidence.calls` (default 8) tool calls during the
  stream — name, truncated arguments (`evidence.argChars`, 300),
  truncated result (`evidence.outChars`, 300), ok/fail — a ring, so a
  long turn keeps its tail. Captured while the stream exists (gone at
  completion), only when the reviewer is configured; the gate never sees
  it. A correction trigger also attaches the previous completed turn
  (operator text, reply, its digest) — what's being corrected is usually
  the turn before. Space-tight preservation order: current operator
  message (tail-first), current answer (head-first), prior wrong turn —
  anything older dropped first. An off-the-record turn is never stored
  as prior context. The completed turn also snapshots the built-in tool
  inventory — sorted names, each description capped at 200 chars, only
  when the reviewer is configured (ruling 2026-10-17): the review prompt
  lists it and rules that procedures built-in tools already perform are
  not skills — a `transcribe`/`bash` recovery is config or a tool call,
  never a new skill. Callback-typed SDK descriptions contribute `""` (no
  context exists at review time).
- **Reviewer: staging, validation, then an atomic proposal.** A
  background model call, off the conversation lane — fire-and-forget,
  never delays the next turn; shutdown doesn't await it (a missed save
  is benign — the next similar turn re-gates — and logged). Model
  defaults to the conversation's model, resolved live per review;
  `reviewer.model` overrides. The review runs in a private skills-tree copy —
  `workspace/.reviewer-staging/<review_id>/skills` (same filesystem as
  `skills/`, dot-prefixed so no catalog scan sees it, wiped at boot) —
  so **nothing live is touched until validation passes**: the catalog
  rereads every turn and must never see a half-written or later-rejected
  skill. Ruling 2026-09-27 (superseding the snapshot/restore ruling):
  read/write/edit tools root at the staging copy; changes stay scoped to
  paths its own writes touched (attribution survives — each written
  path's hash against the copy manifest), and failure is "discard
  staging": model-call failure, 5-minute abort, >100KB of new bytes, or
  `skills-ref validate` failing on any touched skill — either way the
  live catalog is byte-identical. Confinement is lexical **and** real:
  `..`-escapes refuse, every path resolves through realpath, a symlink
  inside the root pointing out is refused for read and write
  (superseding the lexical-only ruling). Proposing one skill is a
  directory swap on the same filesystem: earlier undecided proposal →
  staging-area trash, staged → `skills-proposed/<name>/`, trash deleted,
  rollback to the earlier proposal if the swap fails — never a
  half-updated proposal. A newer review replaces an undecided same-name
  proposal (latest distillation wins, logged). A pending draft is
  reviewer-owned: replacement is wholesale, hand edits inside
  `skills-proposed/<name>/` never merged or preserved (tweak after
  approving, or discard first). A later failed swap cannot undo earlier
  proposals — those are written to history and announced before the
  failure surfaces; failed trash cleanup is logged, not a failed
  proposal. A skill whose live copy changed mid-review (operator hand
  edit, undo, approval) is **skipped, never proposed from a stale
  base** — hashed against the copy manifest at propose time: approving a
  stale-base proposal would clobber those bytes sight-unseen. Reviews
  serialize in turn completion order (a monotonic seq; gate latency must
  not reorder): overlapping runs would propose over each other's
  announced writes. Approval and discard run out-of-band as ordinary
  agent shell work: an approve racing a newer replacement installs
  whatever bytes sit on disk at move time — accepted, not locked. The
  queue holds at most `reviewer.queueCap` (default 3) queued reviews; a
  full queue drops the incoming review and logs the drop (the newest
  turn is the most re-gateable).
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
  decides mechanically — install swaps the proposal into `skills/`
  (replacing any live copy; a symlink on either path refuses the swap),
  discard deletes the staged dir — and appends a resolution history
  event. Over the 64-byte callback cap the row degrades to the
  conversational notice below. The decision mechanics live in
  `src/skill-decisions.ts` (ruling 2026-10-17): one domain path the
  Telegram callback and the operator `POST skills/decide` route both
  drive, so the PWA decides identically to the ✅/🚫 row (gone → 404,
  conflict → 409, unwired → 503; the JSON-body/CSRF backstop guards the
  app door). It lands in history as a system event, so the next turn
  knows. Approve and discard stay conversational as the fallback: the
  history event tells the next turn that approve means moving the dir
  into `skills/` (replacing any live copy) and discard means deleting
  it — goblin is already the operator's hands for installs. The
  `## skills` section lists pending proposals (same scan, same
  conversation-boundary load) so an approve request works in any
  conversation. Manual installs are unchanged: the operator asking in
  chat IS the approval — the ruling covers only the unattended path.
- **Instrumentation.** Every line carries the review id: gate (fields
  above), review started (seq, trigger, model, staged path), model call
  (usage), validation (per skill, ok + output), proposal skipped
  (drifted paths), review done (proposed skills, validated results).
  Approval and discard are conversational, so the closest outcome signal
  is where the skill dir sits — `scripts/reviewer-stats.ts` correlates
  the log by review id and checks proposed skills against disk (still
  proposed / installed / gone): saves, drops, cancels, rejects, gate
  scores vs outcomes. No UI; logs and a script. Good/bad turn labels
  don't exist yet — the field ships empty until they do.
- Config: optional `reviewer` block `{threshold?, thresholds?,
  queueCap?, evidence?, model?, auth}` (auth = the OpenRouter key);
  absent = feature off. Hand-edited-only, like delegation and mail — no
  mini-app surface, gate auth and thresholds boot-captured (system1's
  auth/model/baseUrl ride the same capture; the shared System One
  client's auth closure resolves live per call); the review model
  resolves live per review.
