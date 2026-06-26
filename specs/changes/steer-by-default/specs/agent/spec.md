# agent

## MODIFIED Requirements

### Requirement: In-flight prompts use pi's followUp queueing

The `AgentRunner` SHALL expose two distinct dispatch paths for incoming user content:

- `prompt(content, callbacks)` — starts a new turn. Called when the runner is idle (`isStreaming === false`). It SHALL reset `this.callbacks` and `this.accumulatedText`, inject the per-turn memory snapshot via `sendCustomMessage(..., { deliverAs: "nextTurn" })`, then call `session.sendUserMessage(content)`. If called while `isStreaming === true`, it SHALL throw an error indicating `prompt()` cannot be used mid-stream and `followUp()` must be used instead — this makes the steer-vs-new-turn contract explicit and catches bot-layer bugs that would clobber the in-flight turn's state.
- `followUp(content)` — steers the running turn. Called when the runner is streaming (`isStreaming === true`). It SHALL call `session.followUp(content)` directly and MUST NOT reset `this.callbacks` or `this.accumulatedText`. The in-flight turn's `MessageBuffer` continues to render; the new user text is injected into the model's context mid-turn. No memory snapshot is injected on a steer — the snapshot is per-turn, and the running turn already received its snapshot at `prompt()` time.

The runner MUST NOT implement its own queue. The decision of steer-vs-queue is the bot layer's responsibility (see the orchestration capability); the runner only exposes the two primitives.

`followUp` SHALL accept the same `string | (TextContent | ImageContent)[]` content shape as `prompt` and unpack multimodal content into `session.followUp(text, images?)` the same way `prompt` does. `followUp` SHALL throw `ModelNotCapableError` under the same conditions as `prompt` (image content with a non-image model) using the same `normalizeContentForModel` path.

#### Scenario: Steer while streaming

- **WHEN** `followUp("actually use the other file")` is called while `AgentSession.isStreaming === true`
- **THEN** the runner SHALL call `session.followUp("actually use the other file")` without resetting `this.callbacks` or `this.accumulatedText`
- **AND** no memory snapshot SHALL be injected
- **AND** the in-flight turn's `MessageBuffer` SHALL continue to render the same turn

#### Scenario: New turn after idle

- **WHEN** `prompt(content, callbacks)` is called while `AgentSession.isStreaming === false`
- **THEN** the runner SHALL reset `this.callbacks` and `this.accumulatedText`, inject the memory snapshot, and call `session.sendUserMessage(content)`, starting a new turn

#### Scenario: Steer with multimodal content

- **WHEN** `followUp([{ type: "text", text: "and this image" }, { type: "image", data, mimeType }])` is called while streaming on an image-capable model
- **THEN** the runner SHALL call `session.followUp("and this image", [image])` without resetting turn state

#### Scenario: Steer rejected for incapable model

- **WHEN** `followUp` is called with image content while the resolved model does not accept image input
- **THEN** the runner SHALL throw `ModelNotCapableError` without calling `session.followUp`

#### Scenario: Steer when session not yet initialized

- **WHEN** `followUp` is called before any `prompt()` has initialized the pi `AgentSession`
- **THEN** the runner SHALL throw an error indicating the session is not initialized (e.g. "Cannot steer: session not initialized. Call prompt() first.")
- **AND** `session.followUp` SHALL NOT be called

#### Scenario: Steer rejected when not streaming

- **WHEN** `followUp(content)` is called after `init()` while `AgentSession.isStreaming === false`
- **THEN** the runner SHALL throw an error indicating the session is not streaming (e.g. "Cannot steer: session is not streaming.")
- **AND** `session.followUp` SHALL NOT be called

#### Scenario: prompt rejected while streaming

- **WHEN** `prompt(content, callbacks)` is called while `AgentSession.isStreaming === true`
- **THEN** the runner SHALL throw an error before resetting any state or calling `sendUserMessage`
- **AND** the error message SHALL indicate that `followUp()` must be used to steer a running turn
- **AND** `this.callbacks` and `this.accumulatedText` SHALL remain unchanged (the in-flight turn's state is not clobbered)
