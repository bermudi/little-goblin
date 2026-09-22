# goblin v2

A personal AI assistant that lives in Telegram. One operator, one process,
running on your own machine. Talk to it in a chat; it answers, runs shell
commands, reads and writes files, handles photos and voice notes, and can
speak replies back as voice notes.

This is a rewrite of `little-goblin` on the Vercel AI SDK (see `DESIGN.md`
for why). The old bot keeps running until cutover; nothing is shared between
them.

## How it works, in one paragraph

You message the bot on Telegram. Each forum topic (or the bare chat, if there
are no topics) is its own conversation with its own history — make a topic to
start something, post in an old topic to pick it back up. Your messages get
answered by whatever model you've picked, with five tools at its disposal
(read, write, edit, shell, speak). Settings live in Telegram: four commands
plus a Settings mini app. Everything is stored under one folder
(`~/goblin` by default).

## Quick start

1. Install [bun](https://bun.sh) (>= 1.1) and make sure it's in your `PATH`.
2. Copy `goblin.json5.example` to `~/goblin/goblin.json5` and fill it in
   (bot token goes in `~/goblin/auth.jsonl`, not the config — see below).
3. Run `scripts/install.sh`. It refuses to start a half-configured service,
   so if something's missing it tells you what to fix instead of crash-looping.
4. Message your bot on Telegram.

Full walkthrough: [`docs/setup.md`](docs/setup.md).

## Daily use

- **Topics are conversations.** No `/new`, no `/resume` — Telegram does that job.
- **Four commands:** `/model` (pick the model), `/think` (thinking effort),
  `/voice` (voice-note replies on/off), `/stop` (interrupt). All per-topic.
- **Send anything:** photos, files, voice notes, videos. Voice gets
  transcribed so even text-only models can "hear" it.
- **Settings mini app:** a Settings button in the chat opens a form for every
  knob — no SSH needed.

Details: [`docs/usage.md`](docs/usage.md). Voice features:
[`docs/voice.md`](docs/voice.md). Skills: [`docs/skills.md`](docs/skills.md).

## Configuration in 30 seconds

Two files, side by side in `~/goblin/`:

| File | What | Secrets? |
|---|---|---|
| `goblin.json5` | providers, default model, thinking, speech, Telegram, web UI | never |
| `auth.jsonl` | one `{"name": ..., "value": ...}` per line, file mode `0600` | always |

A secret value is either the credential itself or `!command` (e.g.
`"!pass show api/openrouter"`) that gets run to fetch it when needed.
Full reference: [`docs/configuration.md`](docs/configuration.md).

## Running it

It runs as a systemd user service (`deploy/goblin.service`): restarts on
failure, starts on boot. Logs stream as JSON lines to stdout and to
`~/goblin/state/goblin.log`. Ops guide — restarts, logs, backups, what to do
when it misbehaves: [`docs/operations.md`](docs/operations.md).

```sh
journalctl --user -u goblin -f   # live logs
systemctl --user restart goblin  # restart
```

## Developing

- `bun test` runs the suite, `bunx tsc --noEmit` typechecks. Both should pass
  before committing.
- Read `DESIGN.md` before any structural work — it owns the domain model, the
  authority rule, and the non-goals list. Read `AGENTS.md` for the working
  rules (strict TypeScript, zod at boundaries, fail loud, log everything).
- Only `src/tg/` knows about Telegram internals; everything else is plain
  domain code. Tests live next to the files they cover.

## Docs map

- [`docs/setup.md`](docs/setup.md) — install, first boot, what gets created where
- [`docs/configuration.md`](docs/configuration.md) — every config knob and secret
- [`docs/usage.md`](docs/usage.md) — topics, commands, media, the mini app
- [`docs/voice.md`](docs/voice.md) — voice notes in and out, transcription, `/voice`
- [`docs/skills.md`](docs/skills.md) — teaching the bot repeatable tasks
- [`docs/operations.md`](docs/operations.md) — service, logs, backups, troubleshooting
- [`docs/memory.md`](docs/memory.md) — optional Hindsight memory; implemented, needs authorized live verification
- [`DESIGN.md`](DESIGN.md) — the design spec (why it's built this way)
