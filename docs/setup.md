# Setup

Getting the bot from a fresh checkout to answering messages. There is no
setup wizard: two files plus one script.

## What you need

- A Linux box that stays on (a homelab machine is the intended home).
- [bun](https://bun.sh) version 1.1 or newer, in your `PATH`.
- A Telegram bot token — talk to [@BotFather](https://t.me/BotFather),
  `/newbot`, copy the token it gives you.
- Your Telegram user id — DM [@userinfobot](https://t.me/userinfobot), it
  replies with the number.
- At least one model provider: an API key (or a `codex login` — see
  [Configuration](configuration.md#providers)).
- Optional: `ffmpeg` in `PATH` if you turn on voice features (the installer
  warns you if it's missing — see [Voice](voice.md)).

## The two files

Everything lives in one folder, `~/goblin` by default (override with the
`GOBLIN_HOME` environment variable). You create two files in it by hand;
the bot creates everything else on first boot.

**1. `~/goblin/goblin.json5`** — settings. Start from the annotated example:

```sh
mkdir -p ~/goblin
cp goblin.json5.example ~/goblin/goblin.json5
```

Then edit it. The minimum to fill in:

- `allowedUsers`: put your user id from `@userinfobot`. Nobody else can talk
  to the bot — anyone else gets silently ignored.
- `providers` + `model`: which model answers by default (see
  [Configuration](configuration.md) for the three provider kinds).

**2. `~/goblin/auth.jsonl`** — secrets. One JSON object per line:

```json
{"name": "telegram", "value": "123456:ABC-your-bot-token"}
{"name": "zai", "value": "!pass show api/zai"}
```

- `"telegram"` is required — that's the bot token.
- You need one record per provider `auth` name in your config.
- A value starting with `!` is run as a shell command each time the secret
  is needed, and its output is used as the secret. That way the key itself
  never sits in a file. A plain value works too.
- Set the file mode so only you can read it: `chmod 600 ~/goblin/auth.jsonl`.
  The bot refuses to start if anyone else can read it.

## Install

```sh
scripts/install.sh
```

The script is idempotent — re-run it any time. It:

1. Checks `~/goblin/goblin.json5` and `~/goblin/auth.jsonl` exist. If either
   is missing it stops and tells you what to create, rather than installing
   a bot that would crash in a loop.
2. Installs dependencies (`bun install`).
3. Warns if you configured voice features but `ffmpeg` isn't installed.
4. Writes the systemd user unit (with your paths substituted in), enables
   linger so it runs without you being logged in, and starts the bot.

To use a different home folder: `GOBLIN_HOME=/somewhere scripts/install.sh`.

## First boot

On startup the bot creates the rest of its folder layout:

```text
~/goblin/
├── goblin.json5            # you wrote this
├── auth.jsonl              # you wrote this (mode 0600)
├── workspace/              # the bot's home: every tool runs here
│   ├── SOUL.md             # created from a template — the bot's identity
│   ├── AGENTS.md           # created from a stub — the bot's own operating notes
│   ├── skills/             # skills the bot installs for itself
│   └── attachments/        # photos/files/voice you send, saved here
└── state/
    ├── goblin.sqlite       # all bot memory: conversations + history
    └── goblin.log          # durable copy of the log
```

Then message your bot on Telegram. If it answers, you're done.

Edit `workspace/SOUL.md` to taste — it's who the bot thinks it is, and edits
take effect on the next message. No restart needed.

## If it doesn't answer

1. `systemctl --user status goblin` — is the service running?
2. `journalctl --user -u goblin -f` — the log usually says exactly what's
   wrong (bad token, missing secret, config typo with the offending line).
3. Check the [troubleshooting list](operations.md#troubleshooting).

## Updating

Pull the repo, re-run `scripts/install.sh`, restart:

```sh
git pull
scripts/install.sh
systemctl --user restart goblin
```

History, settings overrides, and workspace files all live in `~/goblin`,
not in the checkout, so updating never touches them.
