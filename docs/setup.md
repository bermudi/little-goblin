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
- For Proton Pass command refs: `pass-keys` in the service `PATH`, and
  an available, unlocked Secret Service/KWallet with persistent storage.
  The operator provisions the dedicated `goblin-dev` agent and narrow
  item grants; its bootstrap PAT is stored in the OS store as
  `goblin-dev`, not in `~/goblin/pass-cli.env`.
- `ffmpeg` in `PATH` for speech, which is on by default. Without it the bot
  starts but disables speech with a warning; set `tts: ""` to turn speech
  off intentionally (see [Voice](voice.md)).

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
{"name": "zai", "value": "replace-with-your-provider-key"}
```

- `"telegram"` is required — that's the bot token.
- You need one record per provider `auth` name in your config.
- A value starting with `!` is run to resolve a secret when needed. If you
  use Proton Pass, configure the scoped, ID-addressed `goblin-dev`
  profile and item grants first, then use `!pass-keys get goblin-dev
  ZAI_API_KEY` for the `zai` record. `get` reads only the encrypted local
  snapshot — no Pass/network fallback. Direct `pass-cli` commands are
  refused by the installer: they would use the owner's unscoped session.
  See [Proton Pass](../design/auth.md#proton-pass-2026-09-26).
- Set the file mode so only you can read it: `chmod 600 ~/goblin/auth.jsonl`.
  The bot refuses to start if anyone else can read it.

### Initialize Pass snapshots (operator action)

Before first startup with Pass command refs, run an explicit sync after
provisioning the OS-store bootstrap and profiles:

```sh
pass-keys warm goblin-dev
pass-keys warm goblin-mcp-dev
pass-keys status goblin-dev
pass-keys status goblin-mcp-dev
```

The MCP profile shares the dedicated `goblin-dev` agent/bootstrap but has
its own snapshot; initialize it even when its refs map is empty.
`warm` always refreshes from Pass. `status` reports age and availability,
not values. Routine sync is background-only: the installed
`goblin-keys.service`/`.timer` run at boot and twice daily, without making
Goblin wait for remote warm. A failed sync leaves the last-good snapshot
usable. Missing snapshots/keys or a locked/unavailable wallet fail loud.
Persistent snapshots survive reboot only if the wallet is available and
unlocked; linger is not wallet unlock, and PAM auto-unlock is unverified.

For an existing installation, bootstrap/profile/auth migration is a
separate operator action; these source docs do not migrate credentials or
install units. Auth edits or successful key rotation need an approved
Goblin restart because it loads auth at boot and caches successful values.
See [Operations](operations.md#key-snapshots).

## Install

```sh
scripts/install.sh
```

The script is idempotent — re-run it any time. It:

1. Checks `~/goblin/goblin.json5` and `~/goblin/auth.jsonl` exist and refuses
   direct `pass-cli` secret commands before installing the service.
2. Installs dependencies (`bun install`).
3. Speech needs `ffmpeg`: if missing, the bot disables TTS at boot and logs
   a warning (the local whistle transcription engine needs it always; cloud
   kinds need it over the provider upload cap).
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
│   ├── USER.md             # created from a stub — the bot's model of you
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

**On prod (g7), use the approved `scripts/deploy.sh` rollout described in
[Operations](operations.md#deploying), not the manual sequence below.**
Deploying/restarting Goblin, installing/reloading units, and publishing
`app/dist` require bermudi's OK. Refreshing these unit sources does not
refresh installed units by itself; coordinate that separately. Never
build into the live `app/dist` merely to verify a change.

For a separate, non-production installation, pull the repo, re-run
`scripts/install.sh`, rebuild the app client, restart:

```sh
git pull
scripts/install.sh
bun run app:build
systemctl --user restart goblin
```

The rebuild matters if you use `/app/`: its client is a build artifact
(`app/dist`), not part of the checkout, so a `git pull` alone leaves last
release's client serving against the new API. A missing build fails loud —
`/app/` answers 500 and the log says to run `app:build`.

History, settings overrides, and workspace files all live in `~/goblin`,
not in the checkout, so updating never touches them.

## App client development

`bun run app:dev` runs the Vite dev server (HMR on save) at
`http://localhost:5173/app/`, proxying `/api` to the local goblin listener
(config `http.port`; `GOBLIN_HTTP` overrides). The proxy strips browser
origin headers so trust-mode mutations pass — the app talks to the live
backend, so edits there are real. It never writes `app/dist`; publishing
the client still goes through `bun run app:build` + the approved rollout.
