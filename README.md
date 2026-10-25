# goblin v2
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/bermudi/little-goblin)


A personal AI assistant with an installable app and an optional Telegram
channel. One operator, one process, running on your own machine. Talk to it in
the app or a Telegram chat; it answers, runs shell commands, reads and writes
files, handles photos and voice notes, and can speak replies back as voice notes.

Built on the Vercel AI SDK. [DIRECTION.md](DIRECTION.md) records the product
aspiration: Goblin as Chief of Staff, carrying work while the operator stays
in the outer loop. [ROADMAP.md](ROADMAP.md) charts the next acceptance targets;
`DESIGN.md` records implementation contracts and non-goals.

It runs in one place: g7; `bun scripts/release.ts` builds a commit into an
immutable release, flips the live symlink, and restarts locally, and
publishing to GitHub is separate (see
[`docs/operations.md`](docs/operations.md)).

## How it works, in one paragraph

The app is the primary operator channel: chat, approvals, programs, settings,
memory, notifications, and recovery all live under `/app/`. Telegram is a
parallel conversation channel when `telegram.enabled` is true — each forum
topic (or the bare chat, if there are no topics) keeps its own history. Your
messages get answered by whatever model you've picked, with tools for files,
shell, speech, scheduling, memory recall, web search and more. Some optional
integrations are configured by hand. Everything is stored under one folder
(`~/goblin` by default).

## Quick start

1. Install [bun](https://bun.sh) (>= 1.1) and make sure it's in your `PATH`.
2. Copy `goblin.json5.example` to `~/goblin/goblin.json5` and fill it in
   (while Telegram is enabled, the bot token goes in `~/goblin/auth.jsonl`,
   not the config — see below).
3. Run `scripts/install.sh`. It refuses to start a half-configured service,
   so if something's missing it tells you what to fix instead of crash-looping.
4. Open `/app/` on the configured HTTP door; if Telegram is enabled, message
   your bot there too.

Full walkthrough: [`docs/setup.md`](docs/setup.md).

## Daily use

- **The app owns the workflow:** chat, approvals, programs, settings, memory,
  notifications, and recovery are all available under `/app/`, even when
  Telegram is disabled.
- **Telegram topics are conversations.** No `/new`, no `/resume` there —
  Telegram does that job when the channel is on.
- **Six commands:** `/voice` (voice-note replies on/off), `/stop`
  (interrupt), `/memory` (memory status, per-topic inclusion), `/forget`
  (delete remembered content), `/compact` (summarize older history), and
  `/start` (a canned hello). The settings ones are per-topic; model and
  thinking effort live in the Settings view.
- **Send anything:** photos, files, voice notes, videos. Voice gets
  transcribed so even text-only models can "hear" it.
- **Memory is automatic (when enabled):** exchanges are remembered and
  recalled on their own — no "remember this". `/forget` removes; see
  [`docs/memory.md`](docs/memory.md).
- **Settings:** the app Settings view owns the common settings; delegation,
  Gmail, and the skill reviewer remain hand-configured.
- **Telegram:** `<publicUrl>/t/` is the channel-specific mini app when
  `telegram.enabled` is true; it disappears with a clear 503 when the channel
  is off. Bearer token or tailnet trust protects the app door —
  see [`docs/security.md`](docs/security.md#the-app-channels-auth).

Details: [`docs/usage.md`](docs/usage.md). Voice features:
[`docs/voice.md`](docs/voice.md). Skills: [`docs/skills.md`](docs/skills.md).

## Configuration in 30 seconds

Two files, side by side in `~/goblin/`:

| File | What | Secrets? |
|---|---|---|
| `goblin.json5` | providers, default model, thinking, speech, Telegram, web UI | never |
| `auth.jsonl` | one `{"name": ..., "value": ...}` per line, file mode `0600` | always |

A secret value is either the credential itself or a `!command` that fetches
it when needed. Direct Pass commands are refused; use a configured
`pass-keys` profile for Pass-backed secrets.
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

- Start product/roadmap work with [`DIRECTION.md`](DIRECTION.md) and
  [`ROADMAP.md`](ROADMAP.md): settled intent, the inspected baseline, and the
  next acceptance target. Check current source before treating either as
  evidence of shipped behavior.
- `bun test` runs the suite, `bun run typecheck` typechecks (both tsc
  programs). Both should pass
  before committing.
- Read `DESIGN.md` (the core: domain model, authority rule, cache
  stability, non-goals) plus the `design/` file for the area you're
  touching before any structural work. `docs/` is operator documentation,
  not spec. Read `AGENTS.md` for the working rules (strict TypeScript, zod
  at boundaries, fail loud, log everything).
- Only `src/tg/` knows about Telegram internals; everything else is plain
  domain code. Tests live next to the files they cover.

## Docs map

- [`DIRECTION.md`](DIRECTION.md) — the product aspiration and settled operator intent
- [`ROADMAP.md`](ROADMAP.md) — current baseline, recommended build order, and acceptance targets
- [`docs/setup.md`](docs/setup.md) — install, first boot, what gets created where
- [`docs/configuration.md`](docs/configuration.md) — every config knob and secret
- [`docs/usage.md`](docs/usage.md) — topics, commands, media, the mini app
- [`docs/voice.md`](docs/voice.md) — voice notes in and out, transcription, `/voice`
- [`docs/skills.md`](docs/skills.md) — teaching the bot repeatable tasks
- [`docs/operations.md`](docs/operations.md) — service, logs, backups, troubleshooting
- [`docs/security.md`](docs/security.md) — trust model: who is trusted, what crosses each boundary, fail-open vs fail-closed
- [`docs/memory.md`](docs/memory.md) — optional Hindsight memory; opt-in
- [`DESIGN.md`](DESIGN.md) + [`design/`](design/) — the design spec (why it's built this way)
- [`V1-V2-MAP.md`](V1-V2-MAP.md) — what changed from little-goblin, feature by feature
