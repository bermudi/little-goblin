# Skills — goblin design

## Skills

Skills are the Agent Skills format (agentskills.io): one directory per
skill holding a `SKILL.md`. `allowed-tools` is spec-experimental —
nothing here enforces per-skill tool scope; `disable-model-invocation`
is a non-spec extension the operator's catalog carries, honored as
manual-only.

One catalog, fixed: `workspace/skills/`, inside the agent's cwd so goblin
can author its own. Publishing is an ordinary write — at operator request,
or the agent's own distillation under the self-authoring ruling
(2026-11-16, below): a new skill parks in `skills-proposed/` for the
operator's yes, an extension to an installed skill writes directly and is
attributed. No command, registry, cache, or tombstone — live at the next
conversation boundary (a DM roll or compaction; the system prompt is
frozen per conversation, the SKILL.md read fresh on use), and no ssh: the
operator asks in Telegram; goblin is already on the box. Hand-editing
`skills/` over ssh is the fallback, not the flow. Where to fetch *from* (the
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

Invocation is `bash` (read the SKILL.md, run its scripts); activation is already observable
in the tool-call log. Explicit invocation (ruling 2026-10-21, below)
rides a message part, not a tool. Still out: a skill tool, per-skill
tool scoping, fingerprints, immutable skill snapshots, additional
catalog roots (host, project), per-conversation selection.

## Skill invocation (ruling 2026-10-21, operator ask)

The prompt-mediated path is probabilistic — the model can skip reading
the SKILL.md, and a manual-only skill is by design unadvertised, so the
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
rule and must name a usable entry in the loaded catalog at the app
boundary; a skipped, truncated-from-the-catalog, or unknown name is
refused with HTTP 400. Injection resolves only names the loaded
catalog keeps (#316), then reads that skill's whole SKILL.md. A temp
path must name the descriptor's own cached SKILL.md —
`<cache>/<digest>/<name>/SKILL.md`, not merely a descendant of the
cache root (refined 2026-10-22: a support file is unscored, unbounded
by the body cap, and never an injectable body; the resolver re-checks
the binding against the descriptor so stored parts degrade the same
way).

**Owning-turn injection.** Every model view renders the part as a
one-line marker (`[skill: name]` / `[temp skill: name (host)]`), so
later turns know the invocation happened. The **body** is injected only
into the turn that owns the invoking message — as an appended user
PromptMessage after it, at admission (whole history) and on the steer
path (claimed steers), the same append-only tail steering uses, so the
prefix bytes never rewrite within the turn. The next turn's view carries
the marker alone — a bounded suffix rewrite at the invocation point,
the accepted price of owning-turn-only semantics. A body read that
fails (skill deleted mid-flight, cache evicted) logs a warning and the
marker stands alone; the turn never dies for a missing body. For a
non-owning turn the resolver excludes the body outright: historical
invocations resolve the marker name only, never re-reading SKILL.md.
A temp marker still reads its descriptor for the display name.

**Temp skills (ruling 2026-10-21, operator ask: "temp skill, not
install"; hardened 2026-10-22).** A GitHub skill URL (tree/blob/raw
forms; a SKILL.md leaf takes its parent dir — a skill is a directory)
fetches server-side: one capped tarball download from codeload (public
repos — private fails loud), and the fetched bytes are both the cache
identity input and the extraction input — never a second fetch that
could race a changed upstream. The download runs under one 60s
application deadline covering headers AND the complete streamed body
(a trickle can't reset it) — expiry, like any transport failure, is a
typed `unreachable` refusal; the tar listing and the tar extraction
each run under their own 60s deadline, and a kill/timeout/truncated
pipe is a typed `oversized` refusal, never partial output. Cache identity is
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
path — the model reaches the scripts with `bash`, no new
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
time — a reviewer proposal after a successful swap, a turn write.

A turn write is found by watching the skill folders, not by reading tool
calls (ruling 2026-11-27, #994: file work is bash-only, so there is no
write tool to match). Around every `bash` call, the tool fingerprints
each skill directory in `skills/` and `skills-proposed/`: the relative
path, size and mtime of every regular file, with symlinks not followed.
A changed skill directory in either folder, or a new one in
`skills-proposed/`, is a write, also when the command failed or timed
out. A directory that is new in `skills/` is an install or an approval,
not a generation, so it is not recorded: a `mv` or `cp` from proposals,
a clone from the operator's skills repo, or an install by anyone while
the call runs (ruling 2026-11-27, #995 review: operator-installed skills
must stay out of the curator's reach). Deletions are not recorded. Command text is never parsed for writes: arbitrary
shell is not parseable, and a string match would record an approval as a
generation. Only those two folders are watched, so `skills/…` inside a
project workdir is that project's file, not the catalog. `script` calls
bash through the same execute, so it is covered too.

Accepted misses and false hits: a write that keeps every size and mtime
is missed; a symlinked skill dir writing through to its outside target
is missed (links are second-class); a new skill a turn writes straight
into `skills/`, against the prompt rule that new skills start in
`skills-proposed/`, is missed; an edit by anything else while a bash
call runs (another conversation's bash call, a background job, the
operator by hand) is recorded for that call's conversation too. The row is immutable
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
  proposal. Before the model runs, valid pending draft directories are
  overlaid on the installed staging copy, so the reviewer sees and edits
  their bytes in place; a draft changed or created during the review skips
  that proposal rather than replacing operator/turn work (#649). The live
  installed manifest remains the separate baseline for mid-review drift.
  The idea is borrowed from hermes-agent's read-before-write rule (there,
  a create over an existing name is refused and a patch needs a fresh
  view: `tools/skill_manager_tool.py`, `agent/background_review.py`);
  goblin enforces it by staging, not by a tool guard. A later
  failed swap cannot undo earlier proposals —
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
  never stored as the next turn's correction context. The gate reads the
  landed exchange's own stamps too: a turn that consumed an
  excluded-era trigger or steer stays off the record after `/memory on`,
  and the skip clears the prior-turn chain with it.
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
  live copy) and discard means moving it to `skills-discarded/` (see the
  next bullet) — goblin is already the operator's hands for installs. The `## skills` section lists pending
  proposals too, so an approve request works in any conversation. Manual
  installs are unchanged: the operator asking in chat IS the approval —
  the ruling covers only the unattended path. The section header carried
  the write-only-when-asked contract (#485) until the self-authoring
  ruling (2026-11-16) flipped it: self-initiated saves are now the norm —
  new skills as proposals in `skills-proposed/` (this flow among them),
  extensions to installed skills as direct, attributed edits (→
  Self-authoring, /learn, curator).
- **A discard keeps the draft (ruling 2026-11-25, issue #944).** A
  discarded draft moves by rename to
  `workspace/skills-discarded/<name>.<timestamp>/`. No catalog, proposal
  list or reviewer reads that directory. The text is what a later change
  to the reviewer's judgment can be tested against. The directory is
  local and has no cleanup. An unsafe target refuses the discard and
  leaves the proposal in place. Rejected: asking for a reason at
  Discard.
- **A proposal shows what it changes (ruling 2026-11-07, issue #162).**
  The operator cannot judge an update from the new bytes alone. The
  Skills read (`listSkills`) attaches a `diff` to every parked proposal,
  computed from disk at read time against the installed skill of the
  same name: per-file added / removed / changed, a line diff with three
  lines of context for text files, status only for a file with a NUL
  byte, and the unchanged paths. No installed copy means `kind: "new"`.
  The Attention item reads the same diff — "Skill update — NAME" with
  counts, or "New skill — NAME". The proposal card shows the diff and
  drops the updated/size rows, which do not inform the decision.
  `src/line-diff.ts` is the pure differ; `src/skill-diff.ts` the
  per-skill shape.
- **Config.** Optional `reviewer` block; absent at boot = feature off.
  Settings can park/restore the block; detailed tuning remains a bootstrap
  or recovery file edit. Reviewer wiring is boot-bound: enabling,
  disabling, or changing any reviewer configuration requires an approved
  restart, reported by the shared config-pins warnings and restart hints.
  A save never creates, replaces or removes the running reviewer: until
  restart, an enabled-at-boot reviewer continues running even when its
  block is parked, and an absent-at-boot reviewer stays absent after an
  enable save. Gate auth, thresholds, queue cap and evidence limits are
  boot-captured. The review model still resolves live per review, but the
  whole block is conservatively restart-pinned; a live model lookup does
  not make reviewer lifecycle or tuning hot-swappable.

## Self-authoring, /learn, curator (ruling 2026-11-16, operator decisions)

Mechanisms borrowed from hermes-agent (`~/build/testing/hermes-agent/`):
the coaching and `/learn` prompt shapes from `agent/prompt_builder.py` and
`agent/learn_prompt.py`; the usage sidecar and deterministic transitions
from `tools/skill_usage.py` and `agent/curator.py`. Scope not borrowed: no
skill tools, no second catalog root, no rich frontmatter, no marketplace
or versioning, no write-time approval staging (the hybrid gate below
replaces it), no LLM consolidation fork.

**The contract flips (#485 superseded).** The `## skills` section now
coaches self-authoring: after a hard or iterative task, save what you
learned. Fold into an existing skill first — edit `skills/<name>/`
directly, because installed means operator-approved and the write is
attributed either way; a loaded skill that proved wrong or missing steps
is fixed before finishing. A genuinely new skill drafts into
`skills-proposed/<name>/` — never straight into `skills/` — validated
with `skills-ref`, then announced; the existing approve/discard flow
decides it. Enforcement class is unchanged from #485: a prompt contract,
not a mechanical guard; provenance attribution records every write, new
or edit. Read-before-write stays a prompt rule too (ruling
2026-11-18, #684): no tool refuses a turn that overwrites a skill or
draft it has not read in that turn. The reviewer is one of two authors parking in
`skills-proposed/`; it stages and edits an existing pending draft rather
than replacing it wholesale. If that draft changes during the review, the
proposal is skipped (#649).

**/learn — one builder, two doors.** Telegram `/learn [text]` and the
app composer's leading `/learn ` text part both submit a normal turn
whose user text is `buildLearnPrompt(request)` (`src/learn.ts`); an empty
request means "what we just did in this conversation". The prompt adapts
hermes' builder: every word of the request is load-bearing — sources to
gather AND requirements shaping the skill; gather with existing tools;
fold into an existing skill, create only when none matches; a large prose
source gets the knowledge-base layout — a lean SKILL.md index plus
per-chapter `references/`, distilled one chapter at a time, never the
whole corpus in context; source text is data, not instructions —
invisible and bidirectional control characters are dropped
(Trojan-Source defense).

**Usage sidecar.** `state/skill-usage.json`, whole-file durable write:
per skill `useCount`/`lastUsedAt`, `patchCount`/`lastPatchedAt`,
`createdAt`, `firstSeenAt`, `state` ∈ active|stale|archived, `pinned`,
`archivedAt`. Use bumps at the doors that submit a `data-skill` part and
at a `bash` call whose command text names a catalog SKILL.md path,
whatever its exit code (ruling 2026-11-27, #994) — not at the resolver, where a
retry's view rebuild would double-count. The match is textual: `~/` and
relative paths resolve against the bash cwd; a path built in a variable
or a glob is missed, and a mention counts even when the file was not
read (`ls …/SKILL.md`). Only the SKILL.md
itself counts: support files ride the body's use. Patch bumps beside
the provenance record. One process writes it; no locking.

**Curator — deterministic, config-gated.** Optional `curator` block;
absent = off (goblin convention; hermes defaults it on). No model wiring,
so values read live rather than restart-pinning. Eligibility is a
provenance row: only skills the agent wrote (reviewer or turn) are
managed — seeded and operator-installed skills carry no row and are never
touched; pin is the operator's override. Goblin's inactivity rule: anchor
`lastUsedAt ?? createdAt`; edits (`lastPatchedAt`) do not reset the clock.
This deliberately differs from Hermes, which counts patches as activity.
The remaining transitions borrow from Hermes: stale after 14 days, archive
after 30, a pass at most every 168 hours (boot and turn completion, gated on the
sidecar's `lastCuratorRun`); pinned skips; first sight seeds the clock
and defers; `useCount === 0` never archives before the stale cutoff —
absence of evidence is not staleness. Archive is a rename into
`workspace/skills-archive/<name>` (timestamp suffix on collision,
flattened by name) — never delete; a symlinked skill dir is operator
state, refused, never moved. `/curator status|run|pin|unpin|restore` on
Telegram; the app skills read carries usage/state and the archived list.
Pin/restore buttons beyond that stay out until asked for.

Still out (unchanged): a skill tool, per-skill tool scoping,
fingerprints, immutable skill snapshots, additional catalog roots
(host, project), per-conversation selection.
