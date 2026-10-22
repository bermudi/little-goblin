# Projects & Notes — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Projects & Notes (ruling 2026-10-10)

Operator ask: projects — a named home for related app chats, with their own
instructions and working directory — and notes, a writing surface outside
conversations that chats can read, attach, and edit. Shapes borrowed from
ChatGPT/Claude/Grok projects and Open WebUI's Notes (rich editor,
snapshot-before-AI-edit, `expected`-guarded range edits, attach-to-chat;
mechanisms only, via DeepWiki on `open-webui/open-webui`, unverified against
its source). Classified **machinery** (DESIGN.md → Non-goals): returned on
demand, designed here before any code.

A project is a scope over the existing turn loop; long work in its directory
already has a path — delegation through herdr, cwd = the project's `dir`.

### Projects

**A project scopes app conversations.** App channel only — Telegram
conversations, spin-offs and guests never belong to one (disjoint channels;
a spin-off lands ungrouped).

**Two paths per project.** `home` is goblin-owned scratch, created with the
project — notes do **not** live here (see Notes — they are rows). `dir` is
the working directory, `home` for app-managed projects or a linked host
directory, validated at creation; operator ruling: a validated path field,
not a server-side folder browser — no new filesystem-listing HTTP surface.
`dir` is immutable after creation — a repoint would silently re-cwd every
chat under it; new project, new binding instead.

The slug derives from the name once and is frozen — renaming never moves
`home`, so delegation, sandbox, and tool-output paths stay valid. Archiving
hides the project and its conversations from the rail, and leaves both
directories untouched. No project delete in v1 — a managed `home` needs a
destructive step, and `trash` > `rm` is a red line.

**Binding is fixed at creation** (operator ruling). No move between
projects — it would rewrite a live conversation's cwd and prompt; the only
sanctioned prefix rewrites are listed in Cache stability.

**What a project changes for its conversations.** One seam each, all
existing parameters:
- **cwd.** `dir` feeds the existing cwd parameter; paths are not confined
  today — absolute paths reach anywhere — so `dir` is a default, not a
  wall. A vanished `dir` fails the turn at admission with the path in the
  error and the log; it never falls back to the workspace.
- **Prompt.** The environment line names `dir`; a `## project` section
  carries name, instructions, the notes index, and — for a linked `dir` —
  that directory's own `AGENTS.md`. SOUL.md, USER.md, goblin's own
  AGENTS.md, and the skill catalog stay global.
- **Cache.** No new rule. The prompt is frozen per conversation
  (`prompt_snapshots`): instruction, notes-index, and project-AGENTS.md
  edits load at the next boundary (new conversation, compaction), same as
  SOUL.md.

**Memory** (operator ruling): `shared` by default — project conversations
retain to and recall from the one Hindsight bank like every other
conversation. `off` is a privacy act: switching a project to `off`
propagates the existing `memoryExcluded` patch (epoch bump included) to all
its conversations; switching back to `shared` applies to new conversations
only — re-enabling an existing chat stays a per-conversation choice.
Project-only banks are out — they would multiply the bank lifecycle, forget
protocol, and destination history (design/memory.md) for one operator.

### Notes

**Notes are rows, not files** (operator ruling, amending "files stay where
humans edit them" for this object): the editing surface is the app's editor,
same as conversations. Rows let the server mediate every mutation — snapshot
before an agent edit, `expected`-guarded range edits, live refresh of an open
editor, FTS, stable ids for attach and pin — where generic `write`/`edit` on
files would bypass all of it.

**Markdown is the only format** (operator ruling): `body_md` is the truth
and exactly what the model reads; the rich editor is limited to what GFM
expresses, so no tri-format sync can drift. Embedded uploads (images/files
inside a note) are out of v1.

**Scope** (operator ruling): a note belongs to a project or is loose, and —
unlike a conversation — may move between projects (or out to loose): it
carries no prompt cache, and frozen notes indexes show it until their next
boundary. Any note attaches to any app chat.

**Editor: Milkdown** — chosen over Tiptap for being markdown-native (remark
parse/serialize), so `body_md` stays the only format. The editor saves only
when its serialization differs from the one it produced right after load —
opening an agent-written note never rewrites it.

**The agent edits through a `note` tool**, mounted on every operator
conversation (Telegram included; guests never). Results ride fenced like
other operator data; note bodies are the operator's words, not instructions
from a third party.

**How chats see notes** (operator ruling: index + attach).
- **Project conversations** get a notes index in the frozen `## project`
  section; current text is a `note read` away.
- **Attach.** The composer's attach picker adds notes. The client sends a
  reference and may add a display title for the chip — labels only; the
  server ignores it. Intake resolves the id and stores the expanded part —
  id, title, rev, and the body as of send — so history holds what the
  server read, never client-supplied content. The model view renders it
  fenced; the stored part is a frozen snapshot, and a later edit shows
  through `note read`, never by rewriting the old message.
- "Chat with a note" is a new conversation with that note attached to its
  first message. No separate mechanism.

**Refresh without push.** No socket, no new push channel (Streaming members'
"parked" ruling stands). In v1 a note and a chat never share a screen, so no
open editor awaits a streamed `note` tool result; when they do, that result
is the refetch trigger.

**Fenced reply → append** (operator ask). In app conversations the model may
wrap note-ready content in a `note` fence (four backticks, so code inside
survives). The transcript renderer shows the fence as a card with "Append to
note…"; only the fence body is appended — never the surrounding "OK, here's…"
prose — as an ordinary note write (`source: append`, version first).

**AI rewrite on selection.** The editor serializes the selection to markdown
and posts `{selection, instruction}` to `POST /api/app/notes/<id>/rewrite`.
The server makes one plain generate call with the root app-default
`model`/`thinking` (what a future conversation would get — never a model the
operator didn't configure), no tools, and returns the replacement. It writes
nothing: the editor previews, the operator accepts, and the accepted change
is a normal save with `source: rewrite`. Not a conversation, not a turn —
the `titleModel` precedent. Opening the rewrite panel drains pending
autosaves first, so the pre-rewrite version holds the operator's latest
text, not the preceding autosave; a changed local document or newer remote
revision refuses acceptance without discarding the operator's buffer.
Rewrite logs never carry note text.

**No pagination:** the note list is bounded, and a narrower `project`/`q`
is how the rest is reached.

**Out, explicitly:** project-only memory banks, moving conversations between
projects, Telegram projects, a server-side directory browser, note
sharing/permissions, real-time co-editing (Yjs), embedded uploads in notes, a
note-anchored side-panel chat (Open WebUI's NotePanel — "chat with a note"
covers it), project delete.
