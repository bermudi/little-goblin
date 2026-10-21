# Configuration

Two files in your goblin home folder (`~/goblin` unless `GOBLIN_HOME` says
otherwise). Settings go in one, secrets in the other — never the twain.

- `goblin.json5` — everything adjustable. No secrets here, ever.
- `auth.jsonl` — secrets. Mode `0600`.

Use **Settings** in the app or Telegram mini app for routine changes.
`goblin.json5` is the persisted configuration, not a parallel editing
interface. The Telegram mini app refuses to save a config that drops your
own Telegram user id (that would lock you out).
A save validates the incoming settings, then rewrites the file whole, as
one canonical JSON5 object with every default materialized. Comments and
key order are not configuration and do not survive a save; unknown keys
anywhere in the file are refused at load rather than silently stripped, so
a typo fails loud. Save freshness is guarded: the mini app sends the
version it loaded (`If-Match`), and a save from a stale page is refused
instead of overwriting a newer one.

Direct file edits are for bootstrap and recovery, including advanced blocks
that do not yet have Settings controls. Start from `goblin.json5.example`,
keep secrets in `auth.jsonl`, and validate with
[Doctor](operations.md#diagnostics-and-first-start-acceptance) from the intended
checkout before an approved restart. Reopen Settings afterward to load the
current version. A malformed or schema-invalid existing file blocks saves;
Settings will not silently reset it.

When updating to strict unknown-key validation, check the existing file with
Doctor from the new checkout before deployment. Unknown top-level or nested
fields must be corrected explicitly; they are never silently discarded.

## `goblin.json5`

Annotated example ships as `goblin.json5.example`. Every knob, in one place:

### Independent channel settings

Root `model` and `thinking` are **app defaults for future conversations**.
The copied example also sets `telegram.model` explicitly: changing only root
`model` does not change Telegram's answering model. Configure both selections
when setting up a provider; onboarding does not choose either for you.
Each app conversation keeps its own durable selection; changing defaults
never changes existing chats. The app chat's model/thinking controls edit
that conversation only.
On the app's empty start screen, the controls edit defaults for new chats.

Telegram uses one shared selection across all DMs and topics:

```json5
telegram: { model: "zai/glm-5.3-flash", thinking: "high", dmGapMinutes: 45 },
```

The Telegram Settings mini app offers separate Telegram and App default
controls. Old configs without Telegram model/thinking keys start with the
root values; a save writes them explicitly, so later app-default edits do
not change Telegram. Existing app chats initialize once at startup.
Changes affect the next turn, **not** an answer already running; no need to
stop it. Compaction follows the same channel/conversation selection.
Removing a provider still selected in an app chat is refused with the
affected chat ids; switch those chats to another provider first.

### Providers

```json5
providers: {
  zai: {
    kind: "openai-compatible",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    auth: "zai",          // name of the secret in auth.jsonl
  },
  // Alternative protocol for an endpoint that supports Responses:
  // zai: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
  openrouter: { kind: "openrouter", auth: "openrouter" },
  // codex: { kind: "codex" },   // ChatGPT subscription via `codex login`
}
```

Four kinds exist (the shipped example uses `responses` for Z.AI):

| Kind | What it is | `auth` points at |
|---|---|---|
| `openai-compatible` | OpenAI-style Chat Completions endpoints | a secret in `auth.jsonl` |
| `responses` | OpenAI Responses endpoints; requires the appropriate `baseUrl`, not a Chat Completions URL | a secret in `auth.jsonl` |
| `openrouter` | OpenRouter | a secret in `auth.jsonl` |
| `codex` | ChatGPT-subscription models via the Codex CLI's own login | nothing — it reads `~/.codex/auth.json` (override with `authFile`) |

For `codex`, run `codex login` first. The bot refreshes expired tokens
itself and writes the rotated tokens back, so the CLI login keeps working.

### Model selection

```json5
model: "zai/glm-5.3-flash", // app default for new conversations
telegram: { model: "zai/glm-5.3-flash", thinking: "high" }, // independent
favorites: ["zai/glm-5.3", "openrouter/anthropic/claude-sonnet-4.5"],
```

A model is written `provider/model-id`, split at the **first** slash —
model ids themselves contain slashes (`openrouter/anthropic/...`), and
that's fine. The provider name must exist in `providers`, otherwise the bot
fails loudly at startup/validation time instead of guessing.

`favorites` is the quick-switch shortlist the Settings mini app shows you.
`titleModel` names
a small cheap model used to auto-title new topics; leave it unset and topics
keep Telegram's placeholder name.

### Thinking

```json5
thinking: "medium",   // off | minimal | low | medium | high | xhigh | max
```

This is *your* vocabulary, not the providers'. Each model honestly maps it
onto what it can actually do — a forced-thinking model clamps `off` up to
its lowest rung rather than pretending thinking is disabled; the mini app
only offers the levels the current model supports. `off` appears only when
the model can really switch reasoning off, and `minimal` only where a
provider expresses it.

### Speech

```json5
// tts: { kind: "edge", voice: "en-US-AriaNeural", rate: "+0%" },
// transcription: { kind: "whistle", keywords: ["goblin", "bermudi"] },
```

TTS is on by default with Edge's `en-US-AriaNeural` voice; configure `tts`
to change the voice or rate, set `kind: "openrouter"` for OpenRouter's
cloud speech models (`fish-audio/s2.1-pro-free:free` by default, needs the
`openrouter` auth record), `kind: "logfare"` for Logfare's (Deepgram
Aura, `aura-2-en` by default, needs the `logfare` auth record), or
`kind: "mimo"` for Xiaomi's (`mimo-v2.5-tts` by default, needs the `mimo`
auth record), or set `tts: ""` to turn it off. It powers
spoken replies (`/voice`, the 🔊 button, the `speak` tool). Transcription
is off when unset; configuring it transcribes incoming voice and video
notes so text-only models can read them, and gives the bot a `transcribe`
tool for other audio files on request. `kind: "whistle"` runs locally
(keyless, private — artifacts auto-download once); groq, openai,
openrouter, mistral, elevenlabs, gemini, mimo, and logfare are the cloud
kinds, each defaulting its model and auth record. TTS needs `ffmpeg` in `PATH`;
whistle and mimo transcription need it always (their wav profile is the
decoder), other cloud kinds only over the upload cap. Details in [Voice](voice.md).

### Vision

```json5
// vision: { model: "openrouter/google/gemini-2.5-flash", maxTokens: 2000, mode: "auto" },
```

Off when unset. With a `vision` block, the bot gets a `vision` tool: it
asks the configured vision model targeted questions about image files on
disk — screenshots, downloaded images, frames it extracted with ffmpeg —
and relays the answers. This is the only way the bot can see an image
file's content (images you send in chat are already visible to
vision-capable models); `followUp: true` continues the previous thread
about the same image. The model ref uses the same `providers` map as your
daily driver, and its output is capped by `maxTokens` (default 2000).

`mode` decides when the tool is in the set: `"auto"` (default) registers
it only while the chat model can't consume images itself — exactly the
case the tool exists for; `"always"` keeps it for vision-capable models
too, since a file on disk is still invisible to them (tool results carry
text, not image bytes).

### Image generation

```json5
// image: { model: "logfare/flux-2-dev", size: "1024x1024" },
```

Off when unset. With an `image` block, the bot gets a `generate_image`
tool: it POSTs the OpenAI images shape to `{baseUrl}/images/generations`
and delivers each generated file to the chat as a photo (Telegram) —
plus saving it to the attachment store, so the returned path works with
`vision` (inspect the result) and `send_file` (resend it). The `model`
ref uses the same `providers` map as your daily driver, but the provider
must be `openai-compatible` or `responses` — only those carry the
`baseUrl` the call posts to. `size` is the default `"WxH"`; the tool may
override it per call, and `n` caps at 4 images per call. Hand-edit only —
the mini app round-trips the block untouched.

### Web access

```json5
// search: { kind: "brave", auth: "brave" },
// fetch: { kind: "parallel", auth: "parallel" },
```

`search` selects the provider behind the `search` tool — kinds `brave`,
`exa`, `jina`, `tavily`, `firecrawl`, `parallel`, `ddg`. Unset means the
tool is absent. `jina` and `ddg` work keyless (rate-limited, unofficial
for ddg); every other kind names an `auth.jsonl` record.

Either tool also accepts an ordered **list** of entries — a fallback
chain. First entry is primary; transport, HTTP, or auth failures advance
to the next; an empty result set is a valid answer and stops the walk.
When a fallback serves, the result says so (`(via ddg — brave: HTTP
402 …)`) and each failed attempt gets its own log line. Chains are
explicit config — no provider is ever injected you didn't write.

`fetch` selects the extraction provider behind the `fetch` tool — kinds
`local` (default when unset: direct HTTP + readability, no key), `jina`,
`tavily`, `firecrawl`, `parallel`, with the same list rule (`local` may
appear in the chain). Search and fetch are chosen independently, so a
search-only key like Brave's free tier pairs with a full-extraction
provider.

### Sandbox

```json5
// sandbox: {
//   image: "docker.io/library/alpine:latest",
//   idleHours: 24,
//   memory: "2g",
//   cpus: 2,
//   pids: 512,
// },
```

Off when unset (`""` clears it, same as `search`). With a `sandbox`
block, the bot gets a `sandbox` tool: one disposable rootless-podman
container per conversation — a place to install things, run fetched
code, and try the destructive path without touching your machine. You
are root inside; nothing is shared with the host (no mounts, no env);
files cross only through the tool's `import`/`export` actions.
Network is off until the `network` action enables it — and when it's
on, the container can reach the internet **and** your LAN/tailnet, so
the safe pattern for untrusted code is enable → download → disable →
run. See [Sandbox](../design/sandbox.md) for the measured wall.

This advanced block has no Settings controls yet; configure it during
bootstrap or recovery, validate it with Doctor, and use an approved restart.
Settings preserves its validated values when saving other settings. `image` must
already be pulled — the bot never pulls (`--pull=never`); a missing
image errors with the exact `podman pull` line to run. Containers are
kept until `reset` or the idle reap: every sandbox call sweeps
sandboxes idle longer than `idleHours` (0 = never reap). A goblin or
host restart never reaps — files inside survive until the next call
restarts the container. `memory`/`cpus`/`pids` are the container's
resource caps; disk is not capped (reaping bounds it).

### Telegram

```json5
operators: [123456789],
allowedUsers: [],
// telegram: { apiRoot: "http://127.0.0.1:8081" },
// publicUrl: "https://goblin.your-tailnet.ts.net",
http: { port: 8787 },
```

- `operators` — your Telegram user id(s): you, plus any of your own
  accounts. Full personal agent on every surface, app doors included.
  DM `@userinfobot` to find yours. Checked on every message, so mini-app
  edits take effect immediately.
- `allowedUsers` — people you name. Sandboxed: a guest persona with
  search-only tools, no memory, no app. Their DM is a standing chat; in
  groups they @mention you. Everyone else gets one refusal line per
  summons and nothing else.
- `telegram.apiRoot` — leave unset for Telegram's cloud API. Point it at a
  self-hosted `telegram-bot-api` in `--local` mode for large files (uploads
  up to 2 GB, files read straight off disk). Needs an `api_id`/`api_hash`
  app registration on the server side. The Telegram client reads this at
  startup: a change saved from Settings is written at once but applies on
  the next restart (the status card lists it under "Restart applies").
- `telegram.richReplies` — default `true`. Bot API 10.3 rich replies in
  your DM: the answer streams as a live draft bubble and lands as one
  formatted markdown message. `false` restores plain-text delivery
  (chunked messages edited in place). Groups, topics and guests always
  use the plain path. Editable in Settings → Telegram; applies to new
  turns.
- `telegram.showReasoning` — default `false`. With rich replies on, the
  model's thinking streams into its own draft bubble and lands as a
  collapsed "Thinking" block above the answer. DMs only; guests never
  see it regardless of the flag. Same edit path as `richReplies`.
- `publicUrl` — the external HTTPS address of the web surfaces (the mini
  app and the app channel both hang off it — e.g. via `tailscale serve`,
  `tailscale funnel`, or any reverse proxy pointing at
  `http://127.0.0.1:<port>`). The bot itself only listens on localhost;
  this URL is what Telegram clients and the app load. Unset = no Settings
  menu button, and the app client is unreachable off-loopback.
- `http.port` — the localhost port (default `8787`).
- `appToken` — names the `auth.jsonl` record holding the bearer token
  `/api/app/*` demands (the app prompts for the token value once, then
  stores it on the device). Unset = trust mode: every `/api/app/*` request
  passes unauthenticated — fine when the only door is tailnet, **wrong**
  when `publicUrl` is a funnel address. Boot-pinned: changes need an approved
  restart.
- `logLevel` — `debug` | `info` | `warn` | `error` (default `info`).

## `auth.jsonl`

One JSON object per line, with no group/world permissions. For a new home,
create the file restrictively **before adding credentials**:

```sh
(umask 077; touch ~/goblin/auth.jsonl)
chmod 600 ~/goblin/auth.jsonl
```

Use your chosen `GOBLIN_HOME` path if different. Edit privately; never put
credentials in environment variables, shell arguments or `goblin.json5`.
The following values are placeholders:

```json
{"name": "telegram", "value": "123456:ABC-your-bot-token"}
{"name": "zai", "value": "literal-key-works-too"}
{"name": "openrouter", "value": "!pass-keys get goblin-dev OPENROUTER_API_KEY"}
```

- `telegram` (the bot token) is always required, plus one record per
  configured provider `auth` name. Codex uses its own OAuth file instead.
  Include configured optional auth references too: transcription, search/fetch,
  memory, mail, reviewer/System One and `appToken`, as applicable. A reference's
  presence does not prove the credential or remote model works.
- The `pass-keys` example requires a configured, ID-addressed `goblin-dev`
  profile, a viewer grant to its dedicated `goblin-dev` agent, and an
  encrypted local snapshot in Secret Service/KWallet. The bootstrap PAT
  is stored in the OS store under `goblin-dev`, not `pass-cli.env`.
  `get PROFILE NAME` reads only that snapshot: no login, sync, or
  Pass/network fallback. Missing snapshots/keys and locked/unavailable
  wallets fail loud. Direct `pass-cli` commands are refused at install:
  they would run as the owner, not the scoped agent. See
  [Proton Pass](../design/auth.md#proton-pass-2026-09-26).
- `pass-keys warm PROFILE` is explicit background sync and always
  refreshes from Pass; `goblin-keys.service`/`.timer` maintain snapshots
  without holding up foreground startup. Failed sync keeps the last-good
  snapshot usable. `pass-keys status PROFILE` reports age and local
  availability without printing values; age does not expire a snapshot.
  A persistent wallet preserves it across reboot if unlocked — wallet
  auto-unlock is not assumed. `scripts/mcp` keeps `pass-keys run
  goblin-mcp-dev -- …`, locally injecting its separate snapshot into the
  child environment and directly execing, without a network fallback.
- A value starting with `!` is executed as a shell command when the secret
  is needed, and its output (trimmed) is the secret. Resolution is lazy —
  the command runs on first use, not at boot — with a 15-second timeout.
  A successful value is cached for the process lifetime; a failure is
  retried on the next use and surfaces as a configuration error, never a
  silent blank. The auth file itself is loaded at boot: editing command
  refs or rotating a resolved key requires an approved Goblin restart,
  even after a successful snapshot sync. See
  [Operations](operations.md#key-snapshots).
- Resolved auth values are not injected into Goblin's shell environment or
  model context. MCP's explicit scoped wrapper is a separate boundary: keys
  enter only its child environment. Credential-command error output is kept
  out of error messages.

**Parser safety:** shared source fixes for malformed CONFIG/AUTH input now emit
safe locations/categories without original input fragments. This does not
update a running older installation or sanitize old logs. Do not share raw
parser exceptions/logs or use an older-code auth checker with real secrets
as a workaround. New diagnostics must
report only safe metadata (location/category/reference presence), never values,
commands or original parser messages. They do not resolve arbitrary auth
commands, provision credentials, warm snapshots or unlock wallets. See
[Setup](setup.md#install) for the installation phase order.

## Per-topic settings

Voice mode and memory inclusion are the per-topic settings, toggled from
chat (`/voice`, `/memory on`·`off`). Changing either interrupts whatever
the topic is currently doing, so a reply never comes from a half-applied
setting. `/model` and `/think` remain retired: Telegram model/thinking
are shared channel settings, while each app conversation remembers its own.
Model/thinking changes take effect on the next turn without interruption.
