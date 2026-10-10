# Setup

Getting a fresh checkout to answering messages on Telegram and serving `/app/`.
There is no setup wizard: two operator-created files plus a non-interactive
installer. Provisioning credentials and optional services is your responsibility.

**Integration status:** this is the approved first-delivery onboarding contract,
not a claim that production has been updated. Shared diagnostics, safe parser
errors, threshold-independent startup logging and launcher bootstrap are
integrated on the feature branch. Source-work approval
is not approval to install units, publish a live client, restart, or deploy.

## What you need

- Linux with a working **systemd user manager/user bus**, and permission to
  enable linger so user services keep running after logout and start at boot.
  Linger does not unlock a credential wallet.
- Bash and GNU core utilities, plus writable checkout, Goblin home and user
  unit directory. Dependencies and the client build write into the checkout;
  state and workspace writes need space and inodes in the home.
- [Bun](https://bun.sh) in the **target service PATH**, not only your interactive
  shell. The declared minimum is 1.1; it is not a certified compatibility floor.
  The currently installed development version is 1.4.2.
- Online access for `bun install --frozen-lockfile` and the client build's
  dependencies, plus runtime access to Telegram and your chosen providers.
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (`/newbot`),
  and your user id from [@userinfobot](https://t.me/userinfobot).
- At least one model provider credential, or an explicit `codex login` for
  the Codex provider. Onboarding does not select a provider or model for you.
- A free loopback HTTP port (default `8787`), or `http.port: 0` to allocate
  one at boot. Acceptance gets the actual port from the same invocation's
  safe `goblin up` event; a missing or contradictory port cannot pass.
  Remote HTTPS exposure is a
  separate operator action, not something the installer provisions.
- Absolute home/checkout/tool paths without spaces or shell/systemd
  metacharacters. Fresh setup rejects unsupported paths rather than writing
  a misquoted unit. The target PATH includes the selected Bun directory,
  `~/bin`, `~/.local/bin`, `/usr/local/{sbin,bin}`, and `/usr/bin`.

### Optional capability dependencies

A seeded skill is not proof its executable, login, or service is ready.
Complete provisioning for the capabilities you configure **before preflight**;
leave unused capabilities disabled rather than silently installing everything.
Diagnostics do not install, provision, warm, unlock, download artifacts, or
launch work to make a finding pass.
Configured synthetic embedding probes may load/cache the configured model;
they do not retain facts in a memory bank.

| Capability | Operator prerequisites / readiness boundary |
| --- | --- |
| TTS / ASR | TTS is enabled by default; install `ffmpeg` in service PATH, or explicitly set `tts: ""`. Without ffmpeg, boot disables TTS with a warning. ASR is absent unless `transcription` is configured. Whistle always needs ffmpeg and a supported platform; its pinned engine/weights download on first use with network/cache access, not during diagnosis. Cloud ASR needs its configured auth and ffmpeg over the upload cap. See [Voice](voice.md). |
| Pass command refs | `pass-keys` (and its sync dependencies), scoped agent/grants, profiles, explicit initial sync and an available unlocked persistent Secret Service/KWallet. Service PATH must find the commands. See the snapshot steps below. |
| MCP | Frozen dependencies supply Goblin's pinned mcporter; configure its own `mcporter.json` with `imports: []` and placeholders only. Provision `goblin-mcp-dev` and any server executables/OAuth separately. A seed with no servers is intentionally empty. |
| Browser | Install `agent-browser` and Chromium separately; the browser skill alone does not install them. |
| Mail / Workspace | Install `gws`, perform its scoped login, and provision configured send/System One auth refs. See [Mail design](../design/mail.md). |
| Delegation | Install herdr and the configured harnesses on each target, with their own logins and service PATH. Diagnostics do not create panes or launch agents. |
| Long-term memory | Hindsight is a separate service, not Goblin's SQLite store. Choose an existing endpoint or follow the separately approved [memory setup](memory.md). A local stack needs rootless Podman/user units and subuid/subgid; local embeddings additionally need configured Ollama/model/relay access. No automatic memory deployment or embedding-model change. |
| Remote app / Settings access | Configure a reverse proxy or tailnet HTTPS door and `publicUrl`. Loopback acceptance does not verify the public route. Public exposure requires app bearer auth (`appToken`); trust mode is only appropriate for a trusted private door. |

## The two files

The home defaults to `~/goblin`; override it with `GOBLIN_HOME`. These commands
are for a **new** home, not a way to overwrite an existing installation.

**1. `goblin.json5`** — settings, never credentials:

```sh
mkdir -p ~/goblin
cp goblin.json5.example ~/goblin/goblin.json5
```

Edit the copy:

- `allowedUsers`: your user id. Unauthorized users cannot operate your bot.
- `providers`: the registry has **four** kinds, including `responses`; see
  [Configuration](configuration.md#providers).
- Root `model`/`thinking`: app defaults for **new** conversations.
- `telegram.model`/`telegram.thinking`: the independent shared Telegram
  selection. The shipped example sets these explicitly; editing only root
  `model` does **not** change which model answers Telegram.
- Remove unused provider entries and adjust references/favorites accordingly;
  provision all auth names you retain, including configured optional features.

**2. `auth.jsonl`** — one JSON object per line. Create it restrictively
**before entering any values**, rather than writing secrets then fixing mode:

```sh
(umask 077; touch ~/goblin/auth.jsonl)
chmod 600 ~/goblin/auth.jsonl
```

Then edit privately; these are placeholders, not real credentials:

```json
{"name": "telegram", "value": "123456:ABC-your-bot-token"}
{"name": "zai", "value": "replace-with-your-provider-key"}
```

`telegram` is required. Add a record for every configured provider `auth`
(except Codex, which uses its own OAuth file) and optional auth reference.
Never put credentials in environment variables, command-line arguments,
`goblin.json5`, workspace files or shared logs. MCP's scoped wrapper injects
keys only into its child environment; it does not populate Goblin's environment.

A value starting with `!` is a credential command. For Proton Pass use
`!pass-keys get goblin-dev ZAI_API_KEY` after explicit provisioning. `get`
reads only the encrypted local snapshot; there is no network fallback.
Direct `pass-cli` auth commands are refused because they could use the
owner's unscoped session. The example file's legacy `!pass show ...` comment
is a password-store command, not the scoped Pass snapshot mechanism; use
this runbook's `pass-keys` form instead. See
[Proton Pass](../design/auth.md#proton-pass-2026-09-26).

**Parser safety:** shared CONFIG/AUTH source fixes now construct safe locations
and categories rather than exposing input fragments. Older deployed code and
old logs may still contain fragments; source integration does not update prod.
Do not share raw parser errors/logs or use an old checker with real credentials
as a diagnostic shortcut. New diagnostics never resolve arbitrary commands.

### Initialize Pass snapshots (operator action)

For Pass refs, first provision the dedicated `goblin-dev` agent, narrow
item grants, ID-addressed profiles and OS-store bootstrap PAT named
`goblin-dev` (not `~/goblin/pass-cli.env`). Then explicitly sync:

```sh
pass-keys warm goblin-dev
pass-keys warm goblin-mcp-dev
pass-keys status goblin-dev
pass-keys status goblin-mcp-dev
```

The MCP profile shares the agent/bootstrap but has its own snapshot;
initialize it even when its refs map is empty if using the shipped warmer/MCP
path. `warm` always refreshes from Pass. `status` shows metadata, not values.
The installed `goblin-keys.service`/`.timer` maintain snapshots at boot and
twice daily; Goblin does not wait for remote warm. A failed sync preserves
last-good snapshots; age is information, not expiry.

Missing snapshots/keys or a locked/unavailable wallet fail loud. Persistent
snapshots survive reboot only with an available, unlocked wallet. Linger is
not wallet unlock, and PAM auto-unlock is unverified. Bootstrap/profile/auth
migration for an existing installation is a separate operator action. Auth
edits or resolved-key rotation need an approved restart; see
[Operations](operations.md#key-snapshots).

## Install

**Fresh targets only.** The installer must reject any existing installed
Goblin target **before dependency sync**, even if it is stopped. It is not
an idempotent update/repair command. Existing-target reinstall or repair
requires separate explicit operator authority; prod updates use approved
`scripts/deploy.sh` instead.

Once the shared integration above is complete, and installation itself is
explicitly authorized, run from the selected checkout:

```sh
GOBLIN_HOME="$HOME/goblin" scripts/install.sh
```

The required executable order is:

1. Cheap host/input/path checks and existing-installed-target refusal,
   before any dependency, asset or service mutation.
2. `bun install --frozen-lockfile` in that checkout. Dependency-using
   validation runs only after the frozen install, never through incidental
   Bun auto-install/cache resolution.
3. Confirm explicit operator provisioning is already complete. The installer
   does not create credentials, log in, warm or unlock a wallet for you.
4. From the checkout, with the chosen `GOBLIN_HOME` and **target service PATH**,
   run `bun --no-install run src/doctor.ts --phase preflight` (optionally `--json`).
   Preflight checks configured start-readiness, not an untouched checkout;
   it skips expected boot-created paths/DB, not-yet-installed units and
   not-yet-built assets. Missing configured dependencies block readiness.
5. Build the app with `bun run app:build`, then run the dedicated
   `scripts/check-app-assets.ts` helper, which invokes shared
   `checkAppAssets(checkout)`. This is a separate post-build gate **before**
   units/enable, not a second implementation of asset diagnosis.
6. Validate rendered user units, then install/reload/enable them and start
   the approved target with linger established.
7. Run `scripts/check-startup.ts`: within a bounded deadline require the
   **current invocation's** boot-complete (`goblin up`) and
   `long polling started` events, plus actual loopback `/app/` HTML and its
   referenced local assets. Old events, merely active status, restarts,
   missing evidence or failed HTTP/assets cannot pass. Report only safe
   event metadata/failure categories, never raw journal bodies.
   Only those two lifecycle events bypass the normal log threshold; there
   is no requirement to keep `logLevel: "info"`.
8. Run `bun --no-install run src/doctor.ts --phase installed` with the same home/service
   PATH. This now includes post-boot layout, DB, units and assets.

If setup fails after installing units, it deliberately does not delete them
or retry another invocation. SIGINT/SIGTERM cancel owned command groups and
prevent later phases, but do not roll back accepted systemd jobs/services or
already-written files. Use its read-only Doctor remedy; recovery/reinstall
is a separately authorized operator action, not another fresh-installer run.
9. Complete the explicit operator handshake below. Installer success is
   not proof of model generation or public HTTPS access.

## First boot and acceptance

Boot seeds missing files without overwriting operator/agent edits:

```text
$GOBLIN_HOME/
├── goblin.json5            # operator settings
├── auth.jsonl              # operator credentials (0600)
├── mcporter.json           # empty MCP seed, imports: []
├── mcp                     # symlink to checkout scripts/mcp
├── goblin-mail             # symlink to checkout scripts/goblin-mail
├── doctor                  # symlink to checkout scripts/doctor
├── workspace/              # every agent tool runs here
│   ├── SOUL.md             # identity template
│   ├── AGENTS.md           # operating-notes stub
│   ├── USER.md             # operator-model stub
│   ├── skills/             # browser/pass-cli/mcp/gws seeds, then agent-owned
│   └── attachments/        # incoming files
└── state/
    ├── goblin.sqlite       # durable conversations/history and local state
    └── goblin.log          # durable structured log
```

From the workspace, `../doctor` targets `scripts/doctor`, which delegates to
Doctor with default phase **installed**. The launcher is bootstrap wiring,
not a new native tool.
Home shims are refreshed as symlinks on boot; real-file collisions are
reported, not overwritten. Optional caches/wrapper state appear when used.
Hindsight holds optional long-term memory separately from this SQLite DB.

For final acceptance, **you** must message the bot from the allowed Telegram
account and confirm an actual reply, then open `/app/` and confirm a working
conversation. Exercise any configured optional capability you intend to rely
on, and check the public route separately if configured. Local diagnostics do
not resolve arbitrary credential commands or make a paid model-generation test;
they cannot prove provider/model access or the correctness of your user id.

Edit `workspace/SOUL.md` to taste. The system prompt refreshes at a **prompt
snapshot boundary** (new conversation/DM roll, compaction or spin-off), not
on the next message of an existing conversation. Read tools can see disk edits
immediately; no restart is needed just to edit identity notes.

## If it doesn't answer

Check service status and, once integrated, run the installed Doctor from the
intended checkout/home. Findings give safe metadata and manual remedies; they
do not repair or restart. Consult [Troubleshooting](operations.md#troubleshooting).
Keep raw logs private; old deployed code/logs may still contain parser fragments.

## Updating

Do **not** re-run the fresh installer on an existing target. Reinstall/repair
is a separately authorized operator procedure. On prod (g7), use the approved
[`scripts/deploy.sh` rollout](operations.md#deploying).

The built client in `app/dist` is read live on every request; building there
can publish a new client before the backend restarts. Verification builds must
use an isolated output directory, not live `app/dist`. Client publication and
backend restart are one coordinated rollout requiring bermudi's OK. Source edits
and these instructions authorize neither. The plain Settings mini app has no
build step and its client is loaded at backend startup.

Conversation state, settings and workspace files live in `GOBLIN_HOME`, not
in the checkout. Updates must preserve them and never silently migrate keys
or deploy the separate memory stack.

## App client development

`bun run app:dev` runs the Vite dev server (HMR on save) at
`http://localhost:5173/app/`, proxying `/api` to the local goblin listener
(config `http.port`; `GOBLIN_HTTP` overrides). The proxy strips browser
origin headers so trust-mode mutations pass — the app talks to the live
backend, so edits there are real. It never writes `app/dist`; publishing
the client still goes through `bun run app:build` + the approved rollout.
