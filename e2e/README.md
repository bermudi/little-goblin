# Goblin E2E smoke suite

End-to-end tests that drive goblin as a real Telegram user via [gotd/td](https://github.com/gotd/td) (MTProto 2.0). Exercises the full feature surface: slash commands, agent turns, tool calls, memory, subagents, voice, files, forum topics, MCP.

## Prerequisites

- **Go 1.23+** (`go version`)
- **Goblin running** in a separate terminal (`bun run dev`)
- **Telegram API credentials** — `api_id` and `api_hash` from [my.telegram.org/apps](https://my.telegram.org/apps)
- **A real Telegram user account** to drive the tests (the harness logs in as you)

## Setup

```sh
# 1. Install Go dependencies (first run only).
cd e2e && go mod download

# 2. Configure environment.
cp .env.example .env
# Edit .env: set E2E_API_ID, E2E_API_HASH, E2E_GOBLIN

# 3. Start goblin in another terminal.
cd .. && bun run dev

# 4. Run the smoke suite.
cd e2e && go run .
```

### First-run login

On the first run, the harness prompts for:
1. **Phone number** (international format, e.g. `+15551234567`)
2. **Login code** (sent by Telegram)
3. **2FA password** (if enabled)

The session is cached to `e2e/.session.json` (gitignored). Subsequent runs reuse it — no re-login needed.

## Environment variables

See [.env.example](.env.example) for the full list. Required:

| Variable | Description |
|---|---|
| `E2E_API_ID` | Telegram API id (integer) |
| `E2E_API_HASH` | Telegram API hash |
| `E2E_GOBLIN` | Goblin's bot username (without `@`) or numeric user id |

Optional feature gates (tests skip cleanly when unset):

| Variable | Enables |
|---|---|
| `E2E_CHAT` | Target a specific chat instead of goblin's DM |
| `E2E_FORUM_CHAT` | Forum topic test (supergroup username/id) |
| `E2E_FORUM_TOPIC_ID` | Topic id, or `create` to make a fresh one |
| `E2E_PROJECT_DIR` | File round-trip test (writable directory) |
| `E2E_VOICE=1` | Voice note test (requires Edge TTS: `uvx edge-tts`) |
| `E2E_MCP_PROBE_PROMPT` + `E2E_MCP_PROBE_EXPECT` | MCP tool-call test |

Optional tuning:

| Variable | Default | Description |
|---|---|---|
| `E2E_TIMEOUT_MS` | `180000` | Agent reply timeout |
| `E2E_SETTLE_MS` | `2500` | Stream settle window (no-edit quiet period) |
| `E2E_COMMAND_TIMEOUT_MS` | `30000` | System reply timeout |
| `E2E_ONLY` | — | Comma-separated test names to run exclusively |
| `E2E_SKIP` | — | Comma-separated test names to skip |

## Test inventory

**Commands:** `ping`, `help`, `start`, `debug`, `name`, `new`

**Conversation + tools:** exact literal reply, bash echo, read file, memory write+recall, memory_read tool

**Subagents:** spawn + bash stdout, `/subagents` list

**Media:** `/voice` returns a voice note, file round-trip (send→read back), >20k char rollover to `reply.md`

**Optional:** MCP tool call, forum topic `/ping`

## Architecture

The harness is a standalone Go program, separate from goblin's Bun process:

```
e2e/
├── main.go          # Entry point: create client, auth, run tests
├── env.go           # Environment variable contract
├── client.go        # gotd client + interactive auth (terminal-based)
├── inbox.go         # LiveInbox: capture + classify goblin's messages
├── driver.go        # GoblinDriver: send text/files/voice, await replies
├── runner.go        # Sequential test runner with pass/fail/skip report
├── assert.go        # Minimal expect/assert (no external deps)
├── tests.go         # All test cases (registered via init())
├── go.mod           # Go module (separate from goblin's package.json)
└── .session.json    # Cached session (gitignored, created on first run)
```

### Message classification

The inbox classifies each incoming message from goblin:

- **system** — `[info]…`/`[ok]…`/`[error]…`/`[warn]…`/`[queued]…` (goblin's `systemReply` wrapper)
- **status** — `🤔 thinking…` + tool slots (`🔧`→`✅`/`❌`)
- **agent** — streamed assistant response (the final text)
- **media** — voice note, document, or photo

`awaitAgentReply` picks the newest agent/media message and returns once it has gone `E2E_SETTLE_MS` without an edit (goblin streams by editing, so this detects when the stream is done).
