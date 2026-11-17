# Skills

Skills are repeatable tasks the bot has learned — each one a folder with an
instruction file the bot reads when the topic calls for it. They follow the
[Agent Skills](https://agentskills.io) format, so skills from the wider
ecosystem usually just work.

You never touch the machinery. Everything happens in chat.

## Using skills

Just ask. The bot sees the list of installed skills in its system prompt and reads
the instructions when one matches. The list is part of the prompt snapshot:
it changes at the next new conversation or DM roll, compaction, or spin-off,
not on the next message (see [Usage](usage.md#the-bots-identity-files)).
A skill's own files are read when used, so edits to them are live next turn.

- *"install the mq skill"* — the bot fetches it (from your skills repo, a
  link, or a file you send it) into its catalog. Listed from the next prompt snapshot.
- *"update the pdf skill to handle tables"* — it edits the files. Live next
  turn.
- *"remove the mq skill"* — it deletes the folder. Unlisted from the next prompt snapshot.

If a skill's instructions mention scripts or helper files, the bot runs them
with its shell. If a skill is broken, the bot says so in chat (broken ones
are skipped with a note in the log, never fatal) — and since it has a shell
on the box, it can usually fix the file itself.

## What's in a skill

For when you're curious, or editing over SSH by hand:

```text
workspace/skills/<name>/
└── SKILL.md            # instructions + required header (below)
    + whatever scripts/references/assets the instructions point at
```

`SKILL.md` starts with a header (name + one-line description), then plain
Markdown instructions:

```markdown
---
name: pdf
description: Extract text from PDF files, including scanned pages via OCR.
---

# PDF

...instructions, examples, script usage...
```

Rules the bot enforces: the folder name and the `name:` must match
(lowercase letters, numbers, hyphens), the description is required, and a
skill can opt out of being advertised (`disable-model-invocation: true` —
still usable when named explicitly, just not listed every turn). Extra
header fields pass through untouched.

Sharing a skill from elsewhere on the box is a symlink inside
`workspace/skills/` — the bot makes those on request too. Hand-editing
files over SSH always works; chat is the flow, SSH the fallback.

## Where skills come from

Which sources the bot fetches from (your skills repo, the host catalog) is
deployment fact, not code — it lives in `workspace/AGENTS.md`, the bot's
operating notes, so the bot knows where to look when you say "install X".
Tell the bot your sources once and it remembers.

The bot also writes skills itself. After a hard or iterative task it
saves what it learned: an existing skill gets folded ("update the pdf
skill…" by chat works the same), and a genuinely new one drafts into
`workspace/skills-proposed/` — never straight into the catalog — and
waits for your approve/discard like any proposal. `/learn` is the
explicit door: `/learn <what just happened, in your words>` (bare
`/learn` in Telegram means "what we just did in this conversation")
has the bot author a skill from the conversation itself.

## The curator

An optional `curator` block in the config turns on the catalog's usage
clock. Without it nothing ages; with it:

```json5
// goblin.json5
{
	curator: { staleDays: 14, archiveDays: 30 }, // the defaults
}
```

The bot tracks when each skill it wrote was last used or patched.
Skills you installed yourself are never touched — only the bot's own
authoring is managed, and only in these moves: after `staleDays` quiet
it's marked stale (a note in the list, nothing more), after
`archiveDays` quiet the folder moves to `workspace/skills-archive/` —
never deleted, so nothing is lost and a restore is one command. A pass
runs at most weekly (at boot and after settled turns); pinned skills
skip everything.

`/curator` on Telegram drives it: `status` shows every skill's clock,
`run` forces a pass, `pin`/`unpin <name>` is your keep override, and
`restore <name>` brings the newest archived copy back. The app's
Skills page shows the same counts per skill plus the archived names.

## Automatic proposals

This runs only with the optional `reviewer` block in the config —
without it the bot writes skills only when you ask, never on its own.
With it: after a turn where you corrected it or it worked through a
repeatable procedure, the bot may draft what it learned as a skill on
its own.
Drafts never install themselves: they park in `workspace/skills-proposed/`
and the bot says so in the topic (*"proposed skill: X — approve to
install"*). Approve and it moves the draft into the catalog; say discard
and it deletes it. The bot sees pending proposals in its skills list, so
you can approve from any chat, not just the one where the draft landed.

## Limits worth knowing

- The bot only reads the instruction file when a request matches — skills
  don't slow down unrelated chats.
- The catalog caps at 128 skills. If you somehow get there, that's a bug
  worth mentioning to the bot.
- There is deliberately no versioning and no marketplace. A skill is files
  in a folder; installing it is writing those files — you asking in
  chat is the approval. The one exception runs the other way: drafts
  the bot saves on its own always wait for your yes before they join
  the catalog. Don't install skills from sources you don't trust —
  their instructions run with the bot's shell.
