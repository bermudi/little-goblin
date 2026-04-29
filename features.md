## Core Features

### **Telegram Integration**
- Bot runs via long-polling (no webhook required)
- User allowlist security — only configured Telegram user IDs can interact
- Forum topic support — each topic is its own isolated session
- DM support — private chat sessions

### **Commands**
- `/start` — Creates/resumes a session (DM) or confirms topic session
- `/new` — Creates a fresh DM session (orphans existing)
- `/ping` — Health check with user/chat info

### **Session Management**
- `(chat, topic)` session mapping
- Auto-created sessions for forum topics on first message
- Persistent session state in `$GOBLIN_HOME/sessions/`
- Events logged to `events.jsonl` per session
- Atomic file writes (tmp + rename)

### **Agent Features**
- Multi-model support: **Poe** (Claude, GPT, Gemini), **OpenRouter**, **OpenAI**, **Anthropic**
- Streaming responses with throttled Telegram edits
- Status line UI: `thinking → working → done` with tool indicators
- Tool visibility levels: `none | minimal | standard | verbose | debug`

### **Available Tools**
| Tool | Purpose |
|------|---------|
| `read` | Read file contents |
| `bash` | Execute shell commands |
| `edit` | Modify files |
| `write` | Create files |
| [memory] | Curate persistent memory (add/replace/remove) |
| `spawn_subagent` | Delegate work to subagent |
| `revive_subagent` | Resume completed/cancelled subagent |

### **Memory System**
- `memory.md` (4000 chars) — environment, projects, conventions, decisions
- `user.md` (2000 chars) — user preferences, communication style, recurring people/places
- Git-backed commits for every memory change
- Auto-injected into every turn

### **Subagents**
- Spawn named agents (specialists) or generic subagents (inherit context)
- Recursive spawning up to **depth 3**
- 10-minute default timeout
- Cancel and revive capabilities
- Isolated from Telegram — headless workers

### **Message Buffer Features**
- Streaming text with ~5 edits/sec throttling
- Automatic file attachment for responses >20k chars
- UTF-16 surrogate-safe splitting
- Chat action (typing) indicators

### **Configuration**
- JSON5 config file at `$GOBLIN_HOME/goblin.json5`
- Env var resolution: `"BOT_TOKEN"`, `"!pass show bots/goblin"`
- Configurable log levels: `debug | info | warn | error`
- Configurable tool visibility

### **Onboarding**
- `bun run onboard` — interactive CLI wizard for first-time setup

---

## Quick Test Checklist

1. **Basic connectivity**: `/ping`
2. **Session creation**: `/start` in DM, or message in a forum topic
3. **Conversation**: Just type — agent should respond with status line
4. **Memory**: Ask goblin to "remember that I prefer concise responses"
5. **Subagent**: Ask goblin to "spawn a subagent to list the files in /home"
6. **Big output**: Ask for a large file read (should attach as .md)
7. **Revive**: After a subagent completes, ask to "revive that subagent with a follow-up"
