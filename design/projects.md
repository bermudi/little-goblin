# Projects & Notes — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Projects & Notes (ruling 2026-10-10)

Operator ask: projects in the app — a named home for related chats with
their own instructions and working directory — and notes, a writing
surface outside conversations that chats can read, attach, and edit.
Shapes borrowed from ChatGPT/Claude/Grok projects (name, instructions,
memory choice) and Open WebUI's Notes (rich editor, snapshot-before-AI-
edit, range edits guarded by `expected`, attach-to-chat; mechanisms only,
grounded via DeepWiki on `open-webui/open-webui`, unverified against its
source). Classified **machinery** (DESIGN.md → Non-goals): returned on
demand, designed here before any code.

**Rejected: a second harness.** Pi Durable (Earendil, 2026-10-01) was
weighed as the engine for project work and declined on mechanism: it is
built on pi-ai, the model layer this rewrite exists to leave (DESIGN.md →
Why), and its crash recovery — re-send the cut-off model request, rerun
replay-safe tools — contradicts the authority rule's notify-don't-retry.
Projects need no new engine: a project is a scope over the existing turn
loop, and long work inside a project directory already has a path —
delegation through herdr, cwd = the project's `dir`. The idea worth
keeping (a conversation stores its own agent: cwd plus instructions) is
exactly this design, built from what exists.

### Projects

**A project scopes app conversations.** App channel only — Telegram
conversations, spin-offs and guests never belong to one (disjoint
channels; a spin-off lands ungrouped). Ungrouped app chats keep working
from `workspace/` exactly as before.

**State is a row.** `projects` in `goblin.sqlite`: `id`, `name`, `slug`,
`home`, `dir`, `instructions`, `memory` (`shared|off`), `created_at`,
`archived_at`. `conversations` gains `project_id` (nullable).

**Two paths per project.**

- `home` = `$GOBLIN_HOME/projects/<slug>/`, always created at project
  creation. Goblin-owned scratch for the project; notes do **not** live
  here (see Notes — they are rows).
- `dir` = the working directory. Defaults to `home` (app-managed). The
  operator may instead link an existing directory on goblin's host: an
  absolute path (`~/` expanded server-side), validated at creation —
  exists, is a directory, `realpath`ed, not under `$GOBLIN_HOME/state`.
  A validated path field, not a server-side folder browser: no new
  filesystem-listing HTTP surface (operator ruling).

The slug derives from the name once (lowercase ASCII, `-2` on collision)
and is frozen — renaming a project never moves `home`, so paths recorded
by delegations, sandboxes, and tool output stay valid. Archiving a
project hides it and its conversations from the rail; it never touches
either directory. No project delete in v1 — a managed `home` would need
a destructive step, and `trash` > `rm` is a red line.

**Binding is fixed at creation** (operator ruling). The client creates a
project chat with `POST /api/app/conversations {id, projectId}` before
its first turn; reposting the same id with a different `projectId` is a
409. The lazy runtime-created row (a chat POST to an unknown id) is
always ungrouped. No move between projects: it would rewrite a live
conversation's cwd and prompt — the only sanctioned prefix rewrites are
listed in Cache stability, and this is not one of them.

**What a project changes for its conversations.** One seam each, all
existing parameters:

- **cwd.** `makeTools({ cwd })` receives `dir` instead of
  `paths.workspace()`; the sandbox mounts `dir` where it mounts the
  workspace; the delegate tool resolves relative cwds against `dir`.
  Paths are not confined today — absolute paths reach anywhere — so
  `dir` is a default, not a wall. A `dir` that vanished fails the turn
  at admission with the path in the error and the log; it never falls
  back to the workspace.
- **Prompt.** The environment line becomes per-conversation (`Working
  directory: <dir>`, dropping "same for every chat"). A `## project`
  section follows the environment: name, instructions, the notes index
  (Notes below), and — for a linked `dir` — that directory's own
  `AGENTS.md` if present, capped and truncated like the workspace's.
  SOUL.md, USER.md, goblin's own AGENTS.md, and the skill catalog stay
  global and unchanged.
- **Cache.** No new rule. The prompt is frozen per conversation
  (`prompt_snapshots`): instruction, notes-index, and project-AGENTS.md
  edits load at the next boundary (new conversation, compaction), same
  as SOUL.md. `noteSource` gains `project`, `project-AGENTS.md`, and
  `notes-index` so drift is visible in the log.

**Memory** (operator ruling): `shared` by default — project
conversations retain to and recall from the one Hindsight bank like
every other conversation. `off` stamps `memoryExcluded` on each
conversation the project creates. Switching a project to `off`
propagates to all its conversations (a privacy act: each gets the
existing `memoryExcluded` patch, epoch bump included); switching back
to `shared` applies to new conversations only — re-enabling an existing
chat stays a per-conversation choice. Project-only banks are out:
multiple banks would multiply the bank lifecycle, forget protocol, and
destination history (design/memory.md) for one operator.

### Notes

**Notes are rows, not files** (operator ruling, amending "files stay
where humans edit them" for this one object). The human editing surface
for a note is the app's editor — the same reason conversations are rows.
What files cannot give and these features need is that **the server
mediates every mutation**: snapshot before an agent edit, `expected`-
guarded range edits, live refresh of an open editor, FTS, stable ids
for attach and pin. An agent editing files with the generic
`write`/`edit` tools bypasses all of it.

- `notes`: `id`, `project_id` (nullable — loose notes), `title`,
  `body_md`, `rev`, `pinned_at`, `archived_at`, `created_at`,
  `updated_at`.
- `note_versions`: `note_id`, `rev`, `body_md`, `source`
  (`app|agent|rewrite|append|restore` — the write that superseded this
  state), `conversation` (nullable), `at`. Full
  copies, as Open WebUI keeps them; capped at the newest 100 per note,
  oldest pruned in the same transaction.
- `notes_fts`: FTS5 over title + body, the `events_fts` pattern.

**Markdown is the only format** (operator ruling). `body_md` is the
truth and exactly what the model reads. The rich editor is limited to
what GFM expresses — headings, lists, task lists, tables, code, links,
image links by URL — so there is no tri-format sync to drift (Open
WebUI stores Tiptap JSON + HTML + markdown per note and per version).
Embedded uploads (images/files inside a note) are out of v1.

**Scope** (operator ruling): a note belongs to a project or is loose. A
top-level Notes view lists loose and project notes; the project page
lists its own. Any note attaches to any app chat. Unlike a
conversation, a note may move between projects (or out to loose): it
carries no prompt cache, and frozen notes indexes simply show it until
their next boundary.

**Editor: Milkdown** (`@milkdown/kit`, commonmark + gfm presets),
mounted directly — no React wrapper package. Chosen over Tiptap because
it is markdown-native (remark parse/serialize), so `body_md` stays the
only format. remark normalizes on serialize (bullet markers, emphasis
style); the gate is that serialization is idempotent and
content-preserving over a GFM fixture set. The editor saves only when
its serialization differs from the serialization it produced right
after load — opening an agent-written note never rewrites it.

**Every mutation is one path.** `rev` increments per content write
(title or body; pin/archive/project moves are flags and bump nothing).
Before a content write the pre-write state is recorded as a version —
always for `agent`, `rewrite`, `append`, and `restore` writes, so every
non-operator edit is one restore away. Operator `app` writes are the
editor's debounced autosave, so they coalesce: an `app` write records a
version only when the note's previous write was not `app` or the newest
version is older than 10 minutes — a typing session is one version, not
hundreds. App saves carry `If-Match: <rev>` (the operator
console's etag pattern); a stale rev is a 409 with the current note,
never a silent overwrite. The single real conflict — the operator typing
while the agent edits — surfaces as that 409, and the editor offers
reload-or-keep-mine. No Yjs/CRDT: one human.

Leaving a dirty note asks before discarding. Confirmation drops unsent
body/title work, including the editor's debounce and unmount drain;
already-sent PATCHes cannot be recalled. Declining keeps the draft.
Reopening the same note neither asks nor adds a history entry.

**The agent edits through a `note` tool**, mounted on every operator
conversation (Telegram included — "add this to my groceries note" is
natural there; guests never). Actions: `list`, `search`, `read`,
`create`, `append`, `replace` (whole body), `replace_range` (`start`,
`end` character offsets into `body_md`, required `expected` — the text
currently at that range; mismatch refuses with the current text so the
model can retry). `read` windows long bodies; its footer reports the
returned absolute character range (final window included), and
`replace_range` offsets always count into the full body — a paged
window's base plus the position inside it. Ranges in one call must not
overlap and apply back-to-front. `list`/`search` default to the conversation's project
(loose notes outside a project); `scope: "all"` widens. `create`
defaults to the current project. Results ride fenced like other
operator data; note bodies are the operator's words, not instructions
from a third party.

**How chats see notes** (operator ruling: index + attach).

- **Project conversations** get a notes index in the frozen
  `## project` section: id + title, pinned first then most recent,
  capped at 50 entries. Current text is a `note read` away.
- **Attach.** The composer's attach picker adds notes. The client sends
  only a reference (`data-note` with the id); intake resolves it and
  stores the expanded part — id, title, rev, and the body as of send —
  so history holds what the server read, never a client-supplied body.
  The model view renders it fenced. Appended content — the cache invariant
  holds — and an honest snapshot: a later edit is visible through `note
  read`, never by rewriting the old message.
- "Chat with a note" is a new conversation with that note attached to
  its first message. No separate mechanism.

**Refresh without push.** The editor fetches on mount and on window
focus; a newer server rev under a clean editor reloads silently, under
a dirty one it raises the conflict choice. In v1 a note and a chat
never share a screen, so there is no open editor for a streamed `note`
tool result to refresh; when they do share one, that tool result is the
refetch trigger. No socket, no new push channel (Streaming members'
"parked" ruling stands).

**Fenced reply → append** (operator ask). In app conversations the
model may wrap note-ready content in a `note` fence — four backticks so
code inside survives:

`````text
````note title="Copenhagen packing list"
- passport
- adapter
````
`````

The transcript renderer shows the fence as a card with "Append to
note…" (picker: existing notes, or new with the suggested title). Only
the fence body is appended — never the surrounding "OK, here's…"
prose. The append is an ordinary note write (`source: append`, version
first). One prompt line on app conversations states the convention;
it loads at each conversation's next boundary.
An unclosed fence hides its append action only while its message is
streaming, including inside UI blocks. Once settled or reloaded, its
visible body is final and may be appended even without a closing fence.

**AI rewrite on selection.** The editor serializes the selection to
markdown and posts `{selection, instruction}` to
`POST /api/app/notes/<id>/rewrite`. The server makes one plain generate
call with the root app-default `model`/`thinking` (the selection a
future conversation would get — never a model the operator didn't
configure), no tools, and returns the replacement. It writes nothing:
the editor previews, the operator accepts, and the accepted change is a
normal save with `source: rewrite`. Not a conversation, not a turn —
the `titleModel` precedent.

The editor captures the ProseMirror selection before opening the rewrite
panel, locks editing, and finishes pending autosaves before requesting a
proposal. Thus the pre-rewrite version contains the operator's latest
text, not the preceding autosave. Cancel/discard unlocks without applying
the proposal. Accept computes the replacement on a detached transaction,
then PATCHes the resulting Markdown with `source: rewrite` and `If-Match`.
Only a successful server save replaces the live document; a changed local
document or a newer remote revision refuses acceptance without discarding
the operator's buffer. Title/flag controls are disabled during this flow.

The one-off request has no tools or automatic retry, a 120-second timeout,
a 50,000-character selection cap, and a 2,000-character instruction cap.
Empty or truncated model output fails visibly rather than offering a
partial replacement. Logs carry the configured model, note id, byte
counts, usage, outcome, and elapsed time, never note text.

### HTTP surface

All under `/api/app/*`, behind the channel's bearer/trust gate and the
trust-mode origin check; JSON bodies require `application/json`.

- `projects` (GET list, POST create), `projects/<id>` (GET, PATCH
  `{name?, instructions?, memory?, archived?}`). `dir` is immutable
  after creation in v1.
- `notes` (GET list with `project`/`q`/archived filters, POST create),
  `notes/<id>` (GET, PATCH with `If-Match`, DELETE only when archived —
  the conversation archive pattern), `notes/<id>/versions` (GET),
  `notes/<id>/versions/<rev>/restore` (POST — a write like any other,
  current body versioned first), `notes/<id>/rewrite` (POST). The list
  is bounded at 1000 rows per filtered read, and the response carries
  `truncated`: true when the filter
  matched beyond the bound (the store is asked for limit+1, so the
  flag needs no second query), telling the client to say so rather
  than show a capped shelf as complete. No pagination: a narrower
  `project`/`q` is how the rest is reached. Content writes refuse on
  archived notes and PATCH applies the archive flag after the content
  write, so `{body, archived: true}` lands in one request while
  unarchive-and-edit is two (`{archived: false}`, then the edit).
- `conversations` POST accepts `projectId`; the list payload carries
  `projectId` per summary.

### Logging

`project created|updated|archived` (id, slug, dir, managed|linked,
memory); `project memory off propagated` (project, conversation count);
`note write` (note, rev, source, conversation, bytes before/after);
`note conflict` (note, expected rev, current rev); `note range refused`
(note, conversation, reason); `note restored` (note, from rev, new rev);
`note rewrite` (note, model, selection bytes, outcome, ms) — the model
call also rides the shared observed-model line. `app note list
truncated` (project, q, archived) marks a capped index read. `prompt
snapshot built` carries the project sources.

### Phases

1. **Projects:** table + binding, create dialog (name, instructions,
   home: managed with the derived path shown, or a linked path), the
   rail's Projects section and the project page, cwd/prompt/sandbox/
   delegate wiring, memory `off`.
2. **Notes:** tables + FTS, the `note` tool, Notes view + rich markdown
   editor (library picked and verified at build — GFM round-trip is the
   gate), versions + restore, attach to chat, the project notes index,
   fenced reply → append.
3. **AI rewrite on selection.**

**Out, explicitly:** project-only memory banks, moving conversations
between projects, Telegram projects, a server-side directory browser,
note sharing/permissions, real-time co-editing (Yjs), embedded uploads
in notes, a note-anchored side-panel chat (Open WebUI's NotePanel —
"chat with a note" covers it), project delete.
