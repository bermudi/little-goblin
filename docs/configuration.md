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
// transcription: { kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" },
```

Unset (commented out) means off. `tts` enables spoken replies (`/voice`,
the 🔊 button, the `speak` tool). `transcription` transcribes incoming
voice and video notes so text-only models can read them, and gives the
bot a `transcribe` tool for other audio files on request. Both need
`ffmpeg` in `PATH`. Details in [Voice](voice.md).

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
- `publicUrl` — the external HTTPS address of the mini app (e.g. via
  `tailscale serve`, `tailscale funnel`, or any reverse proxy pointing at
  `http://127.0.0.1:<port>`). The bot itself only listens on localhost;
  this URL is what Telegram clients load. Unset = no Settings menu button.
- `http.port` — the localhost port (default `8787`).
- `logLevel` — `debug` | `info` | `warn` | `error` (default `info`).

## `auth.jsonl`

One JSON object per line, file readable only by you (`chmod 600` — the bot
refuses to load it otherwise):

```json
{"name": "telegram", "value": "123456:ABC-your-bot-token"}
{"name": "zai", "value": "literal-key-works-too"}
{"name": "openrouter", "value": "!pass show api/openrouter"}
```

- `telegram` (the bot token) is always required, plus one record per
  provider `auth` name (and `transcription.auth` if configured).
- A value starting with `!` is executed as a shell command when the secret
  is needed, and its output (trimmed) is the secret. Resolution is lazy —
  the command runs at the point of use, not at boot — with a 15-second
  timeout. Failing commands surface as configuration errors where the
  secret was needed, never as silent blanks.
- Resolved secrets never end up in the shell environment (the bot's `bash`
  tool would expose them), in the model context, or in logs. If a
  credential command's error output could contain a secret, it is deliberately
  kept out of the error message.

## Per-topic settings

Voice mode and memory inclusion are the per-topic settings, toggled from
chat (`/voice`, `/memory on`·`off`). Model and thinking are config-only —
set once in `goblin.json5` or the mini app, they apply everywhere (`/model`
and `/think` are retired). Changing a per-topic setting interrupts whatever
the topic is currently doing, so a reply never comes from a half-applied
setting.
