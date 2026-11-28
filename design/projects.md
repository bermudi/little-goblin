# Projects & Notes — goblin design

> **Amended (operator, 2026-11-24, not built):** projects become
> [bots](../GLOSSARY.md#bot) after a first new bot works. Notes stay
> ([decision](decisions/one-assistant.md)).
>
> **Amended (operator, 2026-11-27, not built):** the projects feature goes
> completely: no Projects section, no New project, no project page. Project
> chats become side chats ([decision](decisions/bots-and-side-chats.md)).

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
already has a path — delegation through `delegate` (a terminal on Goblin's
private hc core, [delegation](delegation.md)), cwd = the project's `dir`.

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
hides the project and its conversations from the Chats pane, and leaves both
directories untouched. No project delete in v1 — a managed `home` needs a
destructive step, and `trash` > `rm` is a red line.

**A loose chat can move into a project** (ruling 2026-11-21, #839,
amends "binding is fixed at creation"). The move is in place: same
conversation, same link, and nothing already sent changes. The frozen
system prompt, the tool definitions and every stored message stay
byte-identical; the move appends one notice message
(`[project: moved into …]`) that names the new working directory and
carries the project section. The working directory and note scope switch
at once. Tool surfaces that depend on the project (responsibilities, the
program tool's project arm, delegate's responsibility link) follow the
binding the frozen prompt was built with, so they arrive together with the
project section at the next snapshot rebuild (compaction). A move is
refused while a turn runs, for a chat already in a project, for child
conversations and outside the app channel. The current rolling-chat
conversation is the one exception (ruling 2026-11-25, #938): it moves in
place, leaves the rolling lane, and a fresh roll starts behind it in the
same transaction; older rolls still cannot move. Moving between projects or
out of one is still not offered.

**Working directory and cache.** Paths are not confined — `dir` is a
default, not a wall. Project prompt changes load at the next snapshot
boundary, like global instructions.

**Memory** (operator ruling): `shared` by default — project conversations
retain to and recall from the one Hindsight bank like every other
conversation. `off` is a privacy act: switching a project to `off`
propagates the `memoryExcluded` flag write (no epoch bump — a live turn
finishes, retention refused at the gate, same as `/memory off`) to all
its conversations, marked `memory_excluded_by_project` so the gate's own
stamps stay distinguishable from operator choices. Switching back to
`shared` recomputes the effective flag: the gate's stamps lift, while an
exclusion the operator wrote (or confirmed under the gate) survives —
re-enabling an existing chat still belongs to them, not to the switch.
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

**Ownership** (operator, 2026-11-27, #982). Little Goblin owns existing
loose notes and new notes made outside projects. Global notes become shared
by an explicit move and every bot can read and edit them. Notes owned by a
bot are available in that bot's chats. Existing project notes keep their
project until it retires, then follow its successor bot or Little Goblin.
While projects exist, their existing chat and attachment rules still apply.
Settings → Notes has one searchable list with owner and archive filters.
Move, archive, restore, and delete work on the selection. A changed
selection refuses the whole operation. Only archived notes can be deleted,
after confirmation.

**Bot access** (operator, 2026-11-28, #982). The `note` tool in a bot's
chats reaches only that bot's notes and Global notes. Little Goblin's chats,
project chats included, reach every note except other bots' notes, which
they can read but never edit. The store re-checks this inside each agent
write, so a note moved mid-call cannot be edited by a chat that lost it.
Notes a chat made before it became a bot stay Little Goblin's; the operator
moves them to the bot by hand. Pins keep their stricter rule. The tool names
each note's owner and marks read-only notes. Settings → Notes lists bots by
name between Little Goblin and projects, in the owner filter and the Move
dialog. The server refuses an unknown or retired bot as filter or target.
Project notes move to a successor bot by hand until project retirement
moves them.

**Edit history** (operator, 2026-11-27, #982). Each new content revision
records its exact changed text and author. Bots record what they changed
and why. The operator can supply a reason for their next edit and keeps
autosave. The Versions panel shows edit history and restore snapshots.
The `note` tool lists history and reads individual diffs on demand. Existing
conversations on providers that resend the whole tool list keep their earlier
tool declaration until a prompt rebuild. Their edits still record the author
and diff.

**Chat pins** (operator, 2026-11-27, #982, pending). Each chat can pin
notes it can access. A new roll clears pins and compaction keeps
them. On its next turn, the model receives a short notice for new pins and
changes at the tail of the conversation. It reads bodies and diffs on
demand. The composer's Notes button shows pins and changes in the app.

**Editor: Milkdown** — chosen over Tiptap for being markdown-native (remark
parse/serialize), so `body_md` stays the only format. The editor saves only
when its serialization differs from the one it produced right after load —
opening an agent-written note never rewrites it.

**The agent edits through a `note` tool**, mounted on every operator
conversation (Telegram included; guests never). Results ride fenced like
other operator data; note bodies are the operator's words, not instructions
from a third party.

**How chats see notes.**

- **Project conversations** get a notes index in the frozen `## project`
  section; current text is a `note read` away.
- **One mode: pin (operator, 2026-11-28, #1002).** Picking a note pins it
  to the chat; there is no separate attach. The operator: "any time you pin
  a note, the model is probably going to read it … two modes make no
  sense." Rejected: attach as a second mode. It froze a copy of the body
  into one message, so after an edit the model held a stale copy plus a
  change line, and a long note stayed in context for the rest of the chat.
  Accepted cost: the model spends one `note read` before it uses a note.
- **Old attached notes.** Messages sent before #1002 keep their expanded
  `data-note` part: id, title, rev and the body as of send. Intake still
  resolves a `data-note` reference (an edited old message keeps its chip),
  stores what the server read, never client-supplied content, and the model
  view renders it fenced. The app no longer offers a way to add one.
- **Chat with this note** opens a new chat with that note staged as pinned
  and the cursor in the composer. Nothing is sent until the operator types.
- **Staged pins.** A chat that does not exist yet (the new-chat and
  project composers, and Little Goblin's chat before its first message)
  holds picked notes locally. The first send creates the chat and its pins
  in one transaction, before the message is admitted, so the first turn
  carries the pin notice. A note the new chat could not pin refuses the
  whole create; the draft stays, and the refused notes are unpinned with a
  line that names them. For Little Goblin's first message the server checks
  the notes before it routes, and pins them on the roll the message lands
  in. Candidates use the same access rule as an existing chat's pins.
- **Pin to a chat** (operator, 2026-11-27, #982; moved to the composer
  2026-11-28, #1002). The composer's Notes button opens a panel anchored to
  it on desktop, or a bottom sheet from the + menu on a phone. Search active
  notes in the chat's scope, see pinned notes and recent edits, and unpin
  from the same place. The button shows whether notes are pinned, with a
  count; hovering it lists the pinned names. A phone has no hover, so the
  operator opens the sheet to see names. The chat header has no Notes button.
  A new roll starts with no pins. Compaction keeps the existing pins.
  On the next turn, a pin notice names the note, ID, and revision. One line
  per edit names the actor, change, and any reason. Unpinning or losing
  access produces a final notice. Archive, deletion, or loss of access
  removes the pin. If moving a chat to or from a bot cuts off access to a
  note, the pin is removed in the same transaction. The operator can pin
  the note again once the chat can access it.
  The notice text and revision advance commit together at admission. The
  notice belongs to that turn's new input and replays at the same position.
  Editing a message can remove later notices with their delivery records.
  The replacement turn reports what changed since the last surviving
  notice. Retrying an unchanged input replays its recorded notice.
  The body and diff remain available through the note tool.

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
