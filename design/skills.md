# Skills — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Skills

Agent Skills (agentskills.io format): one directory per skill holding
`SKILL.md` — YAML frontmatter plus a Markdown body — alongside whatever
scripts/references/assets the body points at. The frontmatter is validated
per the spec: `name` + `description` required; `license`, `compatibility`,
`metadata`, `allowed-tools` checked for shape when present and then
ignored for behavior — except `compatibility`, which joins the catalog
line so a skill needing tools the box lacks isn't a dead-end invitation.
`allowed-tools` is spec-experimental and nothing here enforces per-skill
tool scope. `disable-model-invocation` is a non-spec extension the
operator's catalog already carries; it is honored (below). Unknown keys
pass through — real skills in the wild carry extra fields.

One catalog, fixed: `workspace/skills/`. It sits inside the agent's cwd so
goblin can author its own — writing `skills/<name>/SKILL.md` is the entire
publishing flow, live next turn. Three exceptions ship from the repo: the
browser, pass-cli, and mcp skills are seeded by `ensureHomeLayout` (write-if-absent,
from `deploy/skills/<name>/SKILL.md`) because DESIGN mandates the
capabilities — a rebuilt box must regain them without operator prompting
or agent memory.
Sharing in a host skill is a symlink —
made by goblin on request, or by hand; there is no second root, no source
policy, no selection UI.

The lifecycle is the filesystem, and the agent is the operator's hands:
**install** = "install the mq skill" in chat → goblin links or copies it
into `skills/`, fetches a repo via `bash`, or files a SKILL.md that
arrived as a Telegram attachment; **update** = edit the files; **remove**
= delete the entry. Each is live on the next turn — no command,
registry, cache, or tombstone for any of it, and no ssh: the operator
asks in Telegram and goblin already has a shell on the box. Where to
fetch *from* (the operator's skills repo, the host catalog) is
deployment fact, not code — it lives in the workspace `AGENTS.md` so the
agent knows its sources. Hand-editing `skills/` over ssh always works;
it is the fallback, not the flow. `skills-ref validate` is installed for
authoring-time checks — goblin runs it via `bash` after writing a skill,
and a skipped entry plus the warn log is the failure signal when it
doesn't.

Discovery is per turn, in `buildSystemPrompt`: scan `skills/*/SKILL.md`
(symlinks resolved), parse a bounded head of each file for frontmatter —
the body is never injected — and render a `## skills` section listing
name + description (+ compatibility when set) + path. The section
renders even when the catalog is empty: it's also the notice that the
capability exists.

- `name` must equal its directory name and follow the spec rule —
  1–64 chars, `a-z0-9` and hyphens, no leading/trailing hyphen, no
  consecutive hyphens; `description` is required, ≤1024 chars.
- `disable-model-invocation: true` excludes the skill from the list —
  manual-only. The operator can still name it and the agent can `ls
  skills/` and read it; it just isn't advertised every turn.
- A malformed entry never kills a turn: `log.warn` with path + reason,
  skip it, and the section notes the skip count so the agent can surface
  it in chat — and fix the file, when it's one it authored.
- Sorted by name; deterministic. Same-name conflicts can't exist —
  name == dirname means they'd be the same directory.

Scan contract: each entry in `skills/` is stat'ed (symlinks followed).
A directory without `SKILL.md` warns and skips; a non-directory is
ignored silently; a broken symlink warns and skips. Frontmatter is read
from a bounded head (16 KiB — a `---` that doesn't close inside it is
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
Edits are live next turn.

- mq — jq for Markdown … [Requires the mq CLI] (skills/mq/SKILL.md)
- pdf — Extract PDF text … (skills/pdf/SKILL.md)
(1 entry skipped as malformed — see goblin.log)
```

An empty catalog renders the header plus "(none yet)" — the notice that
the capability exists is the point.

Invocation is `read_file`. The model sees the catalog line, reads the
SKILL.md when one matches the request, runs its scripts via `bash`.
Activation is already observable in the tool-call log — no skill tool, no
per-skill tool scoping (`allowed-tools` is parsed and ignored), no
snapshots, no fingerprints.

Still out — machinery that returns only on demand: additional catalog
roots (host, project), per-conversation selection, a `/skills` command or
mini-app surface, immutable skill snapshots.

## Skill reviewer

On demand (2026-09-26, the second slice of "richer inner life").
Implemented 2026-09-26. After a turn, goblin may distill what it just
learned into a skill without being asked. A better model of the
operator is **not** this feature — that is Hindsight's job (tune it,
don't duplicate it).

- **Gate: Jev on every completed turn** — the shared System One client
  (default and backup `typesafe/jev-1.13`, configured primary
  `inception/mercury-decide:free`; see `design/mail.md`) via
  OpenRouter's Decisions API, a typed-decision
  model, not a chat model. `POST openrouter.ai/api/alpha/decisions`
  with `{model, state, questions}`; each `noul` answer is a
  yes-probability, `usage` carries input tokens and cost (the wire
  shape is pinned by a boundary test on a recorded response). State:
  the operator's message(s) (tail-first), the reply (head-first),
  tool-call count and names — bounded to ~22k chars against its 32k
  context. Deliberately lean: the gate never sees tool arguments or
  results (a heavy gate is a non-goal); the digest below is the
  reviewer's evidence, not the gate's. Two `noul` questions: *did the
  operator correct how goblin did something?* and *did the turn carry
  out a repeatable multi-step procedure worth a skill?* — both
  criteria sides required, the OpenRouter transport rejects a one-
  sided noul. Either question at ≥ its own threshold → review —
  `reviewer.thresholds.correction` / `procedure` (default:
  `reviewer.threshold`, 0.8; the questions may need different
  cutoffs, so they're split). When both fire, the trigger is a
  correction (the prior turn rides along). Fenced or failed turns are
  not gated; the reviewer's own writes never re-gate (they submit no
  turns); memory-excluded turns are not gated either (below). This is
  an **experiment**: every gate logs both probabilities, the
  thresholds, the trigger, unique tool names, the decision, input
  tokens, cost, latency, and the consecutive-fallback count, so cost,
  hit rate, and outage drift are answerable from the log alone. Any
  gate failure → fall back to "≥ 8 tool calls" (trigger: procedure)
  and log the fallback on the same line; the streak count makes an
  outage visible as a rising number instead of scattered lines.
- **Evidence: a bounded tool digest, captured per turn.** The runtime
  records the last `evidence.calls` (default 8) tool calls during the
  stream — name, truncated arguments (`evidence.argChars`, 300),
  truncated result (`evidence.outChars`, 300), ok/fail — a ring, so a
  long turn keeps its tail. Capture happens while the stream exists
  (it's gone at completion) and only when the reviewer is configured;
  the gate never sees it. When the trigger is a correction, the
  runtime also attaches the previous completed turn (operator text,
  reply, its own digest) — what the operator is correcting is usually
  the turn before. Preservation order when space is tight: the
  current operator message (tail-first), the current answer
  (head-first), the prior wrong turn — anything older is dropped
  first. An off-the-record turn is never stored as prior context.
- **Reviewer: staging, validation, then atomic publish.** A background
  model call, off the conversation lane — fire-and-forget, never
  delays the next turn, and shutdown doesn't await it either (a missed
  save on a racing shutdown is benign — the next similar turn
  re-gates — and logged). Model defaults to the conversation's model,
  resolved live per review; `reviewer.model` overrides. The review
  runs in a private copy of the skills tree —
  `workspace/.reviewer-staging/<review_id>/skills` (same filesystem as
  `skills/`, dot-prefixed so no catalog scan sees it, wiped at boot) —
  so **nothing live is touched until validation passes**: the catalog
  rereads every turn and must never see a half-written or
  later-rejected skill. Ruling 2026-09-27 (supersedes the same-day
  snapshot/restore ruling): the review's read/write/edit tools are
  rooted at the staging copy; what changed is still scoped to the
  paths its own writes touched (attribution survives — content truth
  is each written path's hash against the copy manifest), but failure
  handling is now simply "discard staging": model-call failure,
  5-minute abort, >100KB of new bytes, or `skills-ref validate`
  failing on any touched skill — the live catalog is byte-identical
  either way. Confinement is lexical **and** real: `..`-escapes refuse,
  and every path resolves through realpath — a symlink inside the
  root pointing out is refused for read and write (supersedes the
  lexical-only ruling; the operator's tree had no symlinks to break).
  Publishing one skill is a directory swap on the same filesystem:
  live → staging-area trash, staged → live, trash deleted, with
  rollback to the original if the swap itself fails — never a
  half-updated skill. A later skill's failed swap cannot undo earlier
  publications: those earlier saves are written to history and announced
  before the failure surfaces. Failed trash cleanup is logged, not
  treated as a failed publication.
  A skill whose live copy changed mid-review (operator hand edit,
  undo) is **skipped, never clobbered** — hashed against the copy
  manifest at publish time. Reviews serialize one at a time, in turn
  completion order (a monotonic seq; gate latency must not reorder
  them): overlapping runs would publish over each other's announced
  writes. The queue holds at most `reviewer.queueCap` (default 3)
  queued reviews — a full queue drops the incoming review and logs
  the drop (the newest turn is the most re-gateable).
- **/stop cancels the conversation's reviews.** Ruling 2026-09-28:
  /stop is the operator's panic lever, and a background skill-write
  from a topic the operator just fenced must not outlive it. Queued
  reviews are dropped; the in-flight one (if that conversation's) is
  aborted — staging discarded, live catalog untouched, everything
  logged with the review id. Shutdown passes through the same path.
- **Off the record means no distillation.** Ruling 2026-09-28: a
  memory-excluded conversation never gates — `/memory off` means
  retain nothing from here, and a durable skill IS retention. The
  skip is unconditional (no config flag) and logged; an excluded turn
  is also never stored as the next turn's correction context.
- **It publishes, then tells.** A publish posts a short note to the
  topic ("saved skill: X — reply to undo") and lands in history as a
  system event, so the next turn knows. "Reply to undo" is
  conversational, not mechanical: the history event tells the next
  turn that undo means deleting the skill dir. Skills are already
  goblin's to write; this adds no new authority.
- **Instrumentation.** Every line carries the review id: gate
  (scores, thresholds, trigger, tool names, fallback streak), review
  started (seq, trigger, model, staged path), model call (usage),
  validation (per skill, ok + output), publish skipped (drifted
  paths), review done (published skills, validated results). Undo is
  conversational, so the closest outcome signal is the skill dir's
  later absence — `scripts/reviewer-stats.ts` correlates the log by
  review id and checks published skills against disk: saves, drops,
  cancels, rejects, gate scores vs outcomes. No UI; logs and a
  script. Good/bad turn labels don't exist yet — the field ships
  empty until they do.
- Config: optional `reviewer` block `{threshold?, thresholds?,
  queueCap?, evidence?, model?, auth}` (auth = the OpenRouter key);
  absent = feature off. Hand-edited-only, like delegation and mail —
  no mini-app surface, gate auth and thresholds boot-captured
  (system1's auth/model/baseUrl ride the same capture; the shared
  JevClient's auth closure resolves live per call); the
  review model resolves live per review.
