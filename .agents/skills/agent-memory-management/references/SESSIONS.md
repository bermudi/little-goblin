# Session Management & Compaction

Sessions act as the container for an entire conversation. In production, these must be stored in a persistent database (e.g., Spanner, Redis) to maintain state across stateless API calls.

## Event Types
A session log should track:
- `user_input`: Text, audio, or image data from the user.
- `agent_response`: The model's reply.
- `tool_call`: The agent's decision to invoke an external API.
- `tool_output`: The raw data returned from the tool.

## Managing Long Context
As conversations grow, you must compact the history to manage costs and avoid "context rot."

### Compaction Strategies
1.  **Tool Output Truncation**: Truncate old tool outputs to a size cap (e.g., 3KB for old, 50KB for recent). Cheapest tier — reduces tokens without losing conversation flow.
2.  **Keep Last N Turns**: Simple and effective for short-term tasks.
3.  **Token-Based Truncation**: Count tokens from the most recent message backward until a limit (e.g., 4000 tokens) is reached.
4.  **Recursive Summarization**: Use an LLM to summarize the oldest messages. Prefix this summary to the remaining verbatim messages.

### Triggering Compaction
- **Ratio-Based**: Trigger when token usage reaches a percentage of max context (e.g., 75% for first tier). Most common and reliable.
- **Count-Based**: Trigger when turn count or token size exceeds a threshold.
- **Time-Based**: Trigger after a period of inactivity (e.g., 30 minutes).
- **Event-Based**: Trigger upon task completion or topic change.

## Tiered Compaction (Production Pattern)

Single-strategy compaction breaks down in long or complex conversations. Instead, escalate through tiers based on context pressure:

| Context Fill | Tier | Action | Rationale |
|:---|:---|:---|:---|
| 70–75% | **Truncate Tool Outputs** | Cap old tool outputs at 3KB, recent at 50KB | Cheapest tier — preserves conversation flow |
| 75–85% | **Move to Workspace** | Extract key facts to long-term memory; keep recent turns verbatim | Preserves detail for active conversation |
| 85–95% | **Summarize** | LLM summarizes oldest messages; prefix summary before recent turns | Reduces tokens while preserving context |
| 95%+ | **Truncate** | Drop oldest messages entirely | Last resort to prevent overflow |

### Why Tiered?

- **Different pressure levels need different responses.** Aggressive summarization at 75% wastes context; truncation at 85% loses important detail.
- **Graceful degradation.** Each tier is a fallback for the one above it. If summarization fails, truncation prevents total failure.
- **Validated pattern.** This 4-tier escalation is the gold standard observed in production systems (IronClaw's context monitor, CoPaw's compaction hook).

## Tool-Armed Summarization

The most impactful innovation in session compaction: give the summarizer file tools.

When the LLM performs summarization, equip it with `read_file`, `write_file`, and `edit_file` tools. Instead of just compressing old messages, the summarizer can:

1. **Read existing memory files** to understand what's already stored
2. **Write important information** to daily notes (`memory/YYYY-MM-DD.md`) and long-term memory (`MEMORY.md`)
3. **Edit existing memory files** to update or merge facts

This transforms compaction from a lossy compression step into an active memory-persistence step. Information that would have been lost in summarization is instead explicitly written to persistent storage.

**Implementation**: Run the summarizer as a background task after compaction completes. Validate the result (`is_valid` check). On failure, save debug data and return empty string rather than corrupting state.

```
Compaction triggered (75% threshold)
    ↓
1. Preserve most recent 10% of messages (reserve ratio)
2. LLM summarizes remaining messages
3. Background task: summarizer reads/writes memory files
    ├─ Writes to memory/YYYY-MM-DD.md (daily log)
    ├─ Updates MEMORY.md (long-term facts)
    └─ Preserves thinking blocks if configured
4. Validate result — save debug data on failure
```

**Best for**: Any system where important information surfaces in long conversations and might be lost during compaction. Particularly valuable for agents that work on complex, multi-step tasks.

## User-Turn Boundary Detection

Only compact at user-turn boundaries — not mid-exchange. This ensures:

1.  **Tool-call/tool-result pairs stay intact.** Splitting a tool call from its result creates illegal message sequences for most LLM APIs.
2.  **Conversation coherence.** Summaries don't cut off mid-thought.
3.  **Legal message boundaries.** Ensure the compacted history starts with a `user_input` event.

**Implementation**: Track a `last_consolidated` offset (index into the message array). During compaction, scan forward from this offset and only consolidate up to the last complete user turn.

## Fallback Strategy

Compaction can fail (LLM timeout, malformed response, API error). Plan for this:

1.  **Retry with backoff** (up to 3 attempts for summarization).
2.  **Raw-archive fallback**: If summarization fails repeatedly, dump the raw messages to a history file and reset the session with a "previous context archived" marker.
3.  **Read-only degradation**: If the database is corrupted, fall back to read-only mode rather than serving incorrect data.
4.  **Validation**: After LLM summarization, check `result.is_valid`. On failure, save debug data (messages, config, result) to a debug file and gracefully return empty string.

## Crash Recovery

For file-based session storage (JSONL):

-   **Logical deletion**: Track a `Skip` offset in metadata instead of rewriting the file. Cheaper on flash storage and crash-safe.
-   **Corrupt line recovery**: Silently skip malformed JSON lines (likely from partial writes during crashes).
-   **Stale meta reconciliation**: On load, count actual lines vs. stored metadata count to detect and repair inconsistencies.
-   **Write order**: Write metadata before the data file — prefers "too many messages" over data loss.
-   **Atomic writes**: Use temp file + fsync + rename pattern for crash safety.

## Hot-Reload System Prompt

Identity and behavior files (AGENTS.md, SOUL.md, PROFILE.md) should be rebuilt from disk on every session load or reconnect. This enables:

- **Immediate effect**: Edits take effect without restart.
- **Human editability**: Users can edit memory files directly in a text editor.
- **Git-friendliness**: Changes are version-controllable.

**Implementation**: On session start, read all identity files from disk and build the system prompt. Do not cache across sessions — always read fresh.

## Bootstrap Flow

For first-time setup, provide a BOOTSTRAP.md file that guides the agent through:

1. Asking the user about their preferences and identity
2. Writing PROFILE.md with user information
3. Writing SOUL.md with personality configuration
4. Deleting BOOTSTRAP.md after completion (one-time guide)

This ensures the agent starts with useful context from the first real conversation.
