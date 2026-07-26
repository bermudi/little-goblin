# agent

## ADDED Requirements

### Requirement: AgentRunner receives one captured runtime memory context

A user-visible `AgentRunner` SHALL receive a complete immutable runtime memory context from the conversation-runtime factory. The capture SHALL already contain the validated source SurfaceId, deterministic ActiveScope projection, main caller descriptor, frozen summary, and frozen-summary deduplication inputs. `AgentRunner` MUST NOT accept `ChatLocator`, current-binding access, Conversation creation routing fields, or raw scope-policy knobs for memory behavior.

Capture SHALL occur when the conversation runtime is created, before lazy pi `AgentSession` initialization. Lazy initialization SHALL consume the existing capture without rereading Surface state. Disposing and replacing a runtime is the only way to change its memory context.

#### Scenario: Lazy initialization does not refresh memory context

- **GIVEN** a runtime has captured memory context from Surface X
- **WHEN** its pi AgentSession initializes later
- **THEN** it SHALL use the existing X capture
- **AND** SHALL not resolve a current binding or rebuild ActiveScope

#### Scenario: Replacement runtime receives destination capture

- **WHEN** orchestration replaces a moved Conversation's runtime on Surface Y
- **THEN** the new AgentRunner SHALL receive a newly captured Y context
- **AND** no memory-context field from X SHALL be retained

## MODIFIED Requirements

### Requirement: AgentRunner injects memory snapshot as per-turn aside

The `AgentRunner` SHALL use the frozen summary and frozen deduplication bodies supplied in its captured runtime memory context. It SHALL append the non-null summary to the base system prompt exactly once during lazy pi-session initialization and SHALL not rebuild or refresh it for the runtime lifetime. The accepted 1200-character bound and stale-memory guardrail SHALL remain.

Before each fresh `prompt()` it SHALL compute the bounded `## relevant memory` aside using the same capture and current prompt text, then inject it as `nextTurn`. It SHALL not inject the removed full snapshot, and `followUp()` SHALL not independently inject memory.

#### Scenario: Frozen summary uses captured destination context

- **WHEN** a replacement runtime on Surface Y initializes
- **THEN** its system prompt SHALL include the summary captured for Y at runtime creation
- **AND** SHALL not rebuild from a later binding

#### Scenario: Per-turn memory uses the same capture

- **WHEN** the runtime handles several fresh prompts
- **THEN** each relevant-memory search SHALL use the capture's ActiveScope and caller descriptor
- **AND** frozen-summary deduplication SHALL use the bodies captured with that summary

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL register `memory_search` and `memory_write` in addition to caller-supplied tools and SHALL keep `memory_read` and `memory_read_index` removed. Both tool factories SHALL receive the runner's captured runtime memory context. `memory_write` MUST NOT expose arbitrary scope input; `memory_search` SHALL preserve the accepted same-chat, corpus, `all_chats`, and persona rules. The runner SHALL not wire either tool from `(chatId, topicId)`, `ChatLocator`, current binding, or Conversation metadata.

#### Scenario: Runtime tools share one capture

- **WHEN** a runner is created for a topic Surface
- **THEN** both memory tools SHALL receive the same projected ActiveScope and main caller descriptor
- **AND** writes to `target = "memory"` SHALL resolve to that topic scope

#### Scenario: Caller tools remain present

- **WHEN** the runner receives caller-supplied tools
- **THEN** those tools plus `memory_search` and `memory_write` SHALL be registered as currently accepted
