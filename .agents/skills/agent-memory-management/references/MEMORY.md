# Memory Lifecycle: Extraction & Consolidation

Memory transforms raw conversational noise into structured, persistent knowledge.

## 1. Extraction

The goal is to identify "meaningful" information. The most cost-efficient extraction pipeline processes most memories without any LLM call.

### Three-Stage Extraction Pipeline

```
┌──────────────────────────────────────────┐
│  Stage 1: Regex/Pattern Extraction       │
│  - Bilingual regex for personal facts    │
│  - Explicit commands: "remember X" → 0.99│
│  - Pattern-based: "I prefer..." → 0.88   │
│  - Max 2 implicit extractions per turn   │
│  Cost: Near-zero │ Latency: Real-time    │
└──────────────────┬───────────────────────┘
                   │ candidates
┌──────────────────▼───────────────────────┐
│  Stage 2: Rule-Based Scoring            │
│  - Factual signals: +0.28               │
│  - Preference signals: +0.10            │
│  - Transient signals: -0.18             │
│  - Procedural text: -0.40               │
│  - Length adjustments (short/long)       │
│  Cost: Near-zero │ Latency: < 1ms       │
└──────────────────┬───────────────────────┘
                   │ borderline cases only
┌──────────────────▼───────────────────────┐
│  Stage 3: LLM Judge (optional)          │
│  - Only for cases within 0.08 of threshold│
│  - Timeout: 5s │ Cache: 10 min LRU      │
│  Cost: Medium │ Latency: ~1s             │
└──────────────────────────────────────────┘
```

**Why three stages?** Most memories are clearly good or clearly bad — the rule-based scorer handles these instantly. Only borderline cases need the expensive LLM call. In production, fewer than 10% of candidates reach Stage 3.

### Extraction Triggers

| Trigger | Method | Cost | Latency | Best For |
|:---|:---|:---|:---|:---|
| **Background Reflector** | Dedicated loop (e.g., 60min) scans recent conversations | Medium | Non-blocking | Always-on fact extraction |
| **Auto-Capture** | Pattern matching on incoming messages | Near-zero | Real-time | Structured facts (preferences, decisions) |
| **Three-Stage Pipeline** | Regex → rule judge → optional LLM | Low (most skip LLM) | Near-real-time | Personal facts, preferences |
| **Explicit Command** | User says "remember that X" | None | Immediate | High-confidence user intent |
| **Manual** | Agent or user edits memory file directly | None | Immediate | Curated, high-trust knowledge |
| **Compaction-Triggered** | Extraction runs during session compaction | Medium | Non-blocking | Facts that surface in long conversations |

**Recommendation**: Combine auto-capture/three-stage pipeline + background reflector for coverage. Explicit commands handle edge cases. Compaction-triggered extraction catches facts that only surface during summarization.

### Memory Categories

Tag every memory with a category to enable targeted retrieval and display:

| Category | Description | Example | Confidence Baseline |
|:---|:---|:---|:---|
| `PROFILE` | User preferences and personal facts | "User prefers dark mode" | 0.70 |
| `KNOWLEDGE` | Domain knowledge, how-to information | "Project uses Bun, not npm" | 0.75 |
| `EVENT` | Temporal occurrences with timestamps | "Deployed v2.1 on March 15" | 0.65 |
| `personal-profile` | Identity facts (name, location, role) | "User's name is John" | 0.93 |
| `personal-preference` | Likes, dislikes, style preferences | "User prefers dark mode" | 0.88 |
| `personal-ownership` | Things the user has (pets, family, tools) | "User has a dog named Max" | 0.90 |

Categories with higher confidence baselines (personal-profile, personal-ownership) reflect that identity and possession facts are more stable and less likely to be noise.

### Memory File Format

When using file-based storage, adopt a consistent format across all memory files:

```yaml
---
description: One-line summary used for progressive disclosure (always visible in prompt)
limit: 5000          # max characters — prevents unbounded growth
read_only: false     # set by system; agents cannot modify read_only files
---

Memory content in markdown. Keep focused — one concept per file.
```

**Field semantics:**

| Field | Required | Purpose |
|:---|:---|:---|
| `description` | Yes | Progressive disclosure hook. The agent sees this without loading full content. Write it to enable relevance decisions at a glance. |
| `limit` | Yes | Size cap in characters. When a file exceeds its limit, the extraction pipeline should flag it for splitting. Prevents any single file from dominating the context window. |
| `read_only` | No | Access control. Set only by the system or human operator. Files marked `read_only: true` cannot be modified by the agent's memory tools — useful for identity files, system configuration, and human-authored knowledge. |

**Why frontmatter?** Memory files need metadata that's readable by both the agent (to decide whether to load full content) and the infrastructure (to enforce size limits and access control). YAML frontmatter in Markdown is the simplest format that achieves this without a separate metadata store.

### Bilingual Extraction

If your users are multilingual, extraction patterns must handle multiple languages:

- **English patterns**: "My name is...", "I prefer...", "I live in..."
- **Chinese patterns**: "我叫...", "我喜欢...", "我住在..."
- **CJK tokenization**: Use bigram tokenization for Chinese/Japanese/Korean instead of whitespace splitting.
- **Question detection**: Language-specific question suffixes (Chinese: 吗, 么, 呢) help reject questions that shouldn't become memories.

### Anti-Poisoning Guards

Not everything in a conversation should become a memory. Filter aggressively:

**Reject if:**
- Small talk or greetings ("How are you?", "Thanks!")
- Hedged or uncertain statements ("I think maybe...", "not sure but...")
- Contradictions of established high-confidence memories (flag for review instead)
- Content below a minimum length threshold (e.g., < 6 characters)
- Statements about the agent itself ("you're helpful", "you made a mistake")
- Questions or procedural text (commands, scripts, code)
- Request-like text ("please help me...", "can you...")

**Implementation**: Apply a confidence threshold at extraction. Memories below 0.45 confidence should be discarded. Background reflectors typically extract at 0.68–0.78 confidence; explicit user commands should be stored at 0.95+.

### Guard Levels

Offer configurable strictness to let users control the false-positive vs. false-negative tradeoff:

| Level | Explicit Threshold | Implicit Threshold | Best For |
|:---|:---|:---|:---|
| `strict` | 0.70 | 0.80 | High-stakes contexts where wrong memories are worse than missing ones |
| `standard` | 0.60 | 0.72 | Default — balanced coverage and quality |
| `relaxed` | 0.52 | 0.62 | Maximum coverage — useful when recall matters more than precision |

Higher thresholds for implicit memories reflect that they're inherently less trustworthy than explicit user statements.

## 2. Consolidation

Consolidation ensures the memory corpus remains coherent and accurate.

### Near-Duplicate Detection

When new memories are extracted, check for overlap with existing ones. Use multi-signal similarity — no vector embeddings required:

```
similarity = max(
    substring_containment_ratio(left, right),
    token_overlap_score(left, right),       // min-normalized word frequency
    character_bigram_dice(left, right)      // Dice coefficient on character bigrams
)
```

- **Threshold**: 0.82 — above this, candidates are near-duplicates and should be merged.
- **Token overlap**: Count shared words, normalize by shorter text length. Handles word-order differences.
- **Character bigram Dice**: Splits text into character pairs, computes Dice coefficient. Works well for CJK languages where word boundaries are ambiguous.
- **Substring containment**: Checks if one text is substantially contained within the other. Catches abbreviated versions.

**Merge rule**: When merging near-duplicates, prefer:
1. First-person pronouns ("I prefer...") over third-person ("The user prefers...")
2. Longer, more descriptive text over shorter fragments

### Deduplication Strategies

1.  **Fingerprint-based**: Compute SHA-1 of normalized text. Exact duplicates are trivially detected.
2.  **Similarity scoring**: Compute Jaccard similarity between new and existing memories. If similarity > 0.5, they're candidates for merge.
3.  **Topic-based keys**: Group memories by topic key (derived from category + entity extraction). Deduplicate within the same topic.
4.  **Multi-signal**: Use the three-signal approach above (token + bigram + substring) for fuzzy deduplication.

### Conflict Resolution

When a new memory contradicts an existing one:
- Prefer the **newer** memory if its confidence is higher.
- Prefer **explicit user input** over inferred knowledge when confidence is similar.
- **Never auto-delete** high-confidence memories based on a single low-confidence contradiction — flag for review instead.

### Confidence Decay

Memories that aren't accessed should lose confidence over time, making them less likely to be retrieved:

```
IF last_accessed > 7 days:
    confidence = MAX(0.1, confidence × decay_factor)
```

- **Decay factor**: Typically 0.85–0.95 per decay cycle.
- **Minimum floor**: Never decay below 0.1 (allows recovery if the memory becomes relevant again).
- **Access refresh**: When a memory is retrieved and used, reset its `accessed_at` timestamp.

## 3. Provenance & Trust

Track the lineage of every memory — and detect when the source disappears.

### Source Tracking

| Source | Trust Level | Description |
|:---|:---|:---|
| `Bootstrapped` | High | Pre-loaded knowledge, system configuration |
| `UserProvided` | High | Explicit user input ("remember that...") |
| `Conversation` | Medium | Extracted from conversation by LLM or regex |
| `Document` | Medium | Parsed from uploaded documents |
| `Observation` | Low-Medium | Derived from tool outputs |
| `Inference` | Low-Medium | Agent-derived conclusions |

### Orphan Detection

Link each memory to its originating session and message:

```sql
user_memory_sources (
    memory_id  REFERENCES user_memories(id),
    session_id,
    message_id,
    role,        -- 'user' | 'assistant' | 'tool' | 'system'
    is_active    -- false when source session is deleted
)
```

When sessions are deleted:
1. Mark all sources from that session as `is_active = false`
2. Check each affected memory: does it have any remaining active sources?
3. If not, and the memory was implicit (not explicit user command), mark as `stale`
4. Stale memories are excluded from retrieval but not deleted (allows recovery)

**Why this matters**: Without orphan detection, memories persist forever even when the evidence that created them is gone. A "User's dog is named Max" memory from a deleted session becomes an unverifiable claim.

### Self-Healing

At startup, run a cleanup pass to purge memories that shouldn't have been stored:
- Procedural commands and workflow instructions
- Agent behavior corrections ("next time, do X instead")
- System-level instructions that leaked into personal memory

This catches quality issues that slipped through the extraction pipeline.

## 4. Memory Scope

- **User-Level**: Persistent across all sessions for a specific user.
- **Session-Level**: Isolated to a single conversation (used for compaction).
- **Agent-Level**: Per-agent workspace with independent persona, memory, and session files.
- **Application-Level**: Shared baseline knowledge for all users (must be sanitized).

## 5. Dual Storage Pattern

For systems that need both structured querying and compatibility with file-based tools:

- **Primary store**: SQLite (source of truth, structured queries, provenance tracking)
- **Compatibility layer**: MEMORY.md (readable by file-based tools, git-friendly)
- **Sync**: Lazy migration — write to SQLite first, sync to MEMORY.md on read or change detection

This gives you database-level querying while maintaining human-readability and tool compatibility.
