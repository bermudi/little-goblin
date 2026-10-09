# Configuration

Two files in your goblin home folder (`~/goblin` unless `GOBLIN_HOME` says
otherwise). Settings go in one, secrets in the other — never the twain.

- `goblin.json5` — everything adjustable. No secrets here, ever.
- `auth.jsonl` — secrets. Mode `0600`.

You can edit `goblin.json5` by hand or from the Telegram Settings mini app —
both write the same file. The mini app refuses to save a config that drops
your own user id (that would lock you out), and it merges over what's
currently on disk so a hand-edit you made doesn't get silently discarded.

## `goblin.json5`

Annotated example ships as `goblin.json5.example`. Every knob, in one place:

### Independent channel settings

Root `model` and `thinking` are **app defaults for future conversations**.
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
  openrouter: { kind: "openrouter", auth: "openrouter" },
  // codex: { kind: "codex" },   // ChatGPT subscription via `codex login`
}
```

Three kinds exist:

| Kind | What it is | `auth` points at |
|---|---|---|
| `openai-compatible` | Any OpenAI-style endpoint (Z.AI, Ollama-style relays, …) | a secret in `auth.jsonl` |
| `openrouter` | OpenRouter | a secret in `auth.jsonl` |
| `codex` | ChatGPT-subscription models via the Codex CLI's own login | nothing — it reads `~/.codex/auth.json` (override with `authFile`) |

For `codex`, run `codex login` first. The bot refreshes expired tokens
itself and writes the rotated tokens back, so the CLI login keeps working.

### Model selection

```json5
model: "zai/glm-5.3-flash",
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
thinking: "medium",   // off | low | medium | high | xhigh | max
```

This is *your* vocabulary, not the providers'. Each model honestly maps it
onto what it can actually do — a forced-thinking model clamps `off` up to
its lowest rung rather than pretending thinking is disabled; the mini app
only offers the levels the current model supports.

### Speech

```json5
// tts: { kind: "edge", voice: "en-US-AriaNeural", rate: "+0%" },
// transcription: { kind: "whistle", keywords: ["goblin", "bermudi"] },
```

TTS is on by default with Edge's `en-US-AriaNeural` voice; configure `tts`
to change the voice or rate, or set `tts: ""` to turn it off. It powers
spoken replies (`/voice`, the 🔊 button, the `speak` tool). Transcription
is off when unset; configuring it transcribes incoming voice and video
notes so text-only models can read them, and gives the bot a `transcribe`
tool for other audio files on request. `kind: "whistle"` runs locally
(keyless, private — artifacts auto-download once); groq, openai,
openrouter, mistral, elevenlabs, gemini, and mimo are the cloud kinds,
each defaulting its model and auth record. TTS needs `ffmpeg` in `PATH`;
whisper transcription needs it always (it is the decoder), cloud kinds
only over the upload cap. Details in [Voice](voice.md).

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

### Telegram

```json5
allowedUsers: [123456789],
// telegram: { apiRoot: "http://127.0.0.1:8081" },
// publicUrl: "https://goblin.your-tailnet.ts.net",
http: { port: 8787 },
```

- `allowedUsers` — your Telegram user id(s). Only these can talk to the bot.
  DM `@userinfobot` to find yours. Checked on every message, so mini-app
  edits take effect immediately.
- `telegram.apiRoot` — leave unset for Telegram's cloud API. Point it at a
  self-hosted `telegram-bot-api` in `--local` mode for large files (uploads
  up to 2 GB, files read straight off disk). Needs an `api_id`/`api_hash`
  app registration on the server side.
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
  when `publicUrl` is a funnel address. Boot-pinned: changing it by hand
  needs a restart.
- `logLevel` — `debug` | `info` | `warn` | `error` (default `info`).

## `auth.jsonl`

One JSON object per line, file readable only by you (`chmod 600` — the bot
refuses to load it otherwise):

```json
{"name": "telegram", "value": "123456:ABC-your-bot-token"}
{"name": "zai", "value": "literal-key-works-too"}
{"name": "openrouter", "value": "!pass-keys run goblin-dev -- printenv OPENROUTER_API_KEY"}
```

- `telegram` (the bot token) is always required, plus one record per
  provider `auth` name (and `transcription.auth` if configured).
- The `pass-keys` example requires a configured `goblin-dev` profile with
  that key item granted. Direct `pass-cli` commands are refused at install:
  they would run as the owner, not the scoped agent. See
  [Proton Pass](../DESIGN.md#proton-pass-2026-09-26).
- A value starting with `!` is executed as a shell command when the secret
  is needed, and its output (trimmed) is the secret. Resolution is lazy —
  the command runs on first use, not at boot — with a 15-second timeout.
  A successful value is cached for the process lifetime; a failure is
  retried on the next use and surfaces as a configuration error, never a
  silent blank.
- Resolved secrets never end up in the shell environment (the bot's `bash`
  tool would expose them), in the model context, or in logs. If a
  credential command's error output could contain a secret, it is deliberately
  kept out of the error message.

## Per-topic settings

Voice mode and memory inclusion are the per-topic settings, toggled from
chat (`/voice`, `/memory on`·`off`). Changing either interrupts whatever
the topic is currently doing, so a reply never comes from a half-applied
setting. `/model` and `/think` remain retired: Telegram model/thinking
are shared channel settings, while each app conversation remembers its own.
Model/thinking changes take effect on the next turn without interruption.
