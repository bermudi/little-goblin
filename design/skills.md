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
over ssh is the fallback, not the flow. Where to fetch *from* (the
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
in the tool-call log. Explicit invocation (ruling 2026-10-21, below)
rides a message part, not a tool. Still out: a skill tool, per-skill
tool scoping, fingerprints, immutable skill snapshots, additional
catalog roots (host, project), per-conversation selection.

## Skill invocation (ruling 2026-10-21, operator ask)

The prompt-mediated path is probabilistic — the model can skip the
`read_file`, and a manual-only skill is by design unadvertised, so the
operator has no lever that guarantees the body lands in context. The
operator now has one: an invocation part on a user message, injected
server-side. The app picker and the Telegram `/skill` command are two
doors onto one mechanism.

**The part.** `data-skill` on a user message, a union like the note
part: `{ name }` resolves against the catalog (manual-only included —
naming it IS the operator's override of `disable-model-invocation`);
`{ url, path }` is a temp skill (below). Store format = wire format: the
part persists, replays, and copies with history, and renders as a chip
on the message — the transcript never lies. Validation is zod at the
wire, mirroring the attachment-ref gate: a name matches the spec name
rule; a temp path must name the descriptor's own cached SKILL.md —
`<cache>/<digest>/<name>/SKILL.md`, not merely a descendant of the
cache root (refined 2026-10-22: a support file is unscored, unbounded
by the body cap, and never an injectable body; the resolver re-checks
the binding against the descriptor so stored parts degrade the same
way).

**Owning-turn injection.** Every model view renders the part as a
one-line marker (`[skill: name]` / `[temp skill: name (host)]`), so
later turns know the invocation happened. The **body** is injected only
into the turn that owns the invoking message — as an appended user
ModelMessage after it, at admission (whole history) and on the steer
path (claimed steers), the same append-only tail steering uses, so the
prefix bytes never rewrite within the turn. The next turn's view carries
the marker alone — a bounded suffix rewrite at the invocation point,
the accepted price of owning-turn-only semantics. A body read that
fails (skill deleted mid-flight, cache evicted) logs a warning and the
marker stands alone; the turn never dies for a missing body. For a
non-owning turn the resolver excludes the body outright: historical
invocations resolve the marker name only, never re-reading SKILL.md.
A temp marker still reads its descriptor for the display name.
An injected body is a
log line (`skill invoked`: conversation, skill or source host, bytes)
plus the durable part — activation stays answerable from the log,
though no tool call marks it.

**Picker (app).** The composer gains a skill button opening the
catalog: every valid entry, advertised and manual-only, with
description and body size (no silent truncation — an explicit
invocation is an explicit context-cost decision; the 105KB claude-api
body is real). Picking stages a chip beside the upload chips; send
appends the part. The `## skills` prompt section is untouched —
manual-only stays unadvertised to the model; injection is server
behavior, not a prompt contract, so conversations with prompts frozen
before this ruling invoke identically.

**Temp skills (ruling 2026-10-21, operator ask: "temp skill, not
install"; hardened 2026-10-22).** A GitHub skill URL (tree/blob/raw
forms; a SKILL.md leaf takes its parent dir — a skill is a directory)
fetches server-side: one capped tarball download from codeload (public
repos — private fails loud), and the fetched bytes are both the cache
identity input and the extraction input — never a second fetch that
could race a changed upstream. Cache identity is
`sha256(sha256(tarball) + "\0" + canonicalSourceUrl)`, so equivalent
tree/blob/raw forms of one skill share `state/skillcache/<digest>/`
while sibling subtrees of the same tarball do not (cache, not state —
deletable). Whole directory staged because skills' work lives beside
their SKILL.md in script dirs the body tells the model to run.

Pre-flight before payload. The archive's own `tar -t` listing
(GNU tar, env-pinned) is parsed defensively before a single file is
extracted: one safe common top-level prefix discovered from entries
(never the synthesized `repo-ref`), canonical selected paths, regular
files and directories only inside the selected subtree — links and
specials refuse before extraction, as do the resource caps (256KiB
root SKILL.md, 10MiB dir, 500 files, 500 dirs — inode-only payloads
are payloads). Only then does member-anchored `tar -x` run, with the
post-extraction walk retained as defense in depth. A cache dir whose
descriptor is absent or corrupt is a broken cache, not a cache miss:
it fails loud, never re-extracts over or repairs the incumbent, and a
publish-race loser re-reads the incumbent. Frontmatter must parse and
the name must match the directory — the operator previews a
known-valid skill.

**The gate is System One, the decision is the operator's.** The
fetched body scores through the injection checker (the shared
`design/system1.md` client) with the full cached bytes — no head-cut
sampling, so a tail payload is scored, not skipped. The preview card
shows name, description, body size, source repo, and the verdict —
the operator clicks yes or no before anything stages or sends. The
verdict is advisory, not a gate: a skill may legitimately instruct,
and the operator may accept it. The route stamps the verdict onto the
descriptor before the card renders — `previewed` marks the check
*completed* (including `unavailable`), not consent; consent is the
channel's confirm/tap on the preview card. The stamp is immutable:
identical cached bytes (one digest) keep their first verdict — a
re-preview shows the persisted verdict and runs no second score, so
no outstanding confirmation's advisory can change under it (ruling
2026-10-22). Injection gates on
`previewed`, and a stamped `unavailable` rides the body as advisory
preamble text, never a silent clean. On the app the card is the confirm; on Telegram `/skill <url>`
replies with the preview and a ✅/🚫 row (pending keyed by a short
token — the URL cannot ride the 64-byte callback cap; a pending
confirm dies with the process, and the command re-runs instantly off
the cache). `/skill <url> text…` holds the text for the turn the
confirmation submits.

**Injection preamble.** A temp body is injected wrapped: fetched-from
line, the verdict line, not-installed notice, and the staged directory
path — the model reaches the scripts with `read_file`/`bash`, no new
capability. What never happens is persistence: a temp skill produces
no catalog entry, no proposal, no provenance row. Catalog membership
remains only via install, which stays the operator-approved
conversational path — the fetched copy in skillcache is bytes beside
a cache, not a skill.

**Residual, accepted.** A temp skill is un-reviewed instruction text
injected verbatim into context — the same residual every skill
carries, minus prior review. Mitigations are the preview-before-send,
the scored verdict, the caps, and operator-initiation being the only
trigger. One-shot remote invocation without a confirm was considered
and rejected: it injects unvalidated bytes with no decision point.

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
