# Skills

Skills are repeatable tasks the bot has learned — each one a folder with an
instruction file the bot reads when the topic calls for it. They follow the
[Agent Skills](https://agentskills.io) format, so skills from the wider
ecosystem usually just work.

You never touch the machinery. Everything happens in chat.

## Using skills

Just ask. The bot sees the list of installed skills on every reply and reads
the instructions when one matches:

- *"install the mq skill"* — the bot fetches it (from your skills repo, a
  link, or a file you send it) into its catalog. Live on the next message.
- *"update the pdf skill to handle tables"* — it edits the files. Live next
  turn.
- *"remove the mq skill"* — it deletes the folder. Gone next turn.

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

## Limits worth knowing

- The bot only reads the instruction file when a request matches — skills
  don't slow down unrelated chats.
- The catalog caps at 128 skills. If you somehow get there, that's a bug
  worth mentioning to the bot.
- There is deliberately no skills UI, no versioning, no approval flow. A
  skill is files in a folder; installing it is writing those files. Don't
  install skills from sources you don't trust — their instructions run with
  the bot's shell.
