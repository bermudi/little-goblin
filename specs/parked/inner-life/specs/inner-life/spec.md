# inner-life

## ADDED Requirements

### Requirement: Persist durable wake records before reflection

Every inner-life wake SHALL have a versioned, schema-validated record under `$GOBLIN_HOME/state/inner-life/wakes/<wakeId>.json` before model reflection begins. The record SHALL include a stable wake ID, wake kind, creation time, lifecycle state, selected capability-profile ID and version, optional home `SurfaceId`, reflection-attempt metadata, validated effect intents, and effect outcomes. Writes MUST use atomic single-file replacement; invalid records and non-`ENOENT` filesystem errors MUST fail loudly.

#### Scenario: New wake is accepted

- **WHEN** an inner-life source requests a wake with a supported kind
- **THEN** the system SHALL persist its pending wake record before invoking a model
- **AND** the model SHALL receive the same durable wake ID for correlation

#### Scenario: Wake record is malformed

- **WHEN** startup reads a wake record that fails schema or version validation
- **THEN** startup SHALL fail with the wake path and validation reason
- **AND** SHALL NOT guess defaults or execute effects from that record

### Requirement: Wake kinds select code-owned capability profiles

Each supported wake kind SHALL resolve to one code-owned, versioned capability profile before reflection. The frozen profile reference SHALL bound model access, maximum effect count, permitted effect kinds, and whether proactive contact is possible. Prompt or model output MUST NOT add tools, effect kinds, filesystem authority, home Surfaces, or other capabilities outside that profile. An unknown wake kind or missing profile version SHALL fail before model execution.

#### Scenario: Profile is frozen for a wake

- **WHEN** a wake kind resolves to profile `reflection-v1`
- **THEN** the wake record SHALL persist that profile ID and version
- **AND** restart SHALL use the same profile semantics rather than silently adopting a newer profile

#### Scenario: Model requests an unpermitted effect

- **WHEN** reflection output names an effect kind outside the wake's profile
- **THEN** validation SHALL reject that effect before execution
- **AND** the durable wake outcome SHALL record the bounded rejection

### Requirement: Reflection produces bounded effect intents

Inner-life reflection SHALL be separate from effect execution. Model output SHALL be parsed as a closed, versioned effect-intent union with bounded payloads and count. The system SHALL validate syntax, profile authority, home-Surface requirements, and current policy before persisting accepted intents. Free-form assistant text, tool-call-shaped text, and unknown object fields MUST NOT execute as effects.

#### Scenario: Valid reflection proposes no effects

- **WHEN** reflection returns the valid no-effect result
- **THEN** the wake SHALL complete without entering effect execution
- **AND** the reflection outcome SHALL remain durable

#### Scenario: Reflection output is not valid intent data

- **WHEN** the model returns prose or malformed JSON instead of the bounded result schema
- **THEN** the reflection attempt SHALL fail observably
- **AND** no effect attempt SHALL be created or executed

### Requirement: Effect kinds declare separate delivery guarantees

Every registered effect kind SHALL declare code-owned execution semantics covering authorization timing, idempotency or deduplication key, retry eligibility, ambiguous external outcomes, pending state, and terminal failure. The system MUST persist an effect attempt before crossing its external boundary and persist the observed outcome afterward. It SHALL NOT claim universal exactly-once execution.

The initial proactive-contact effect SHALL use at most one automatic Telegram API invocation per durable effect attempt: it persists a dispatching marker before the call, retries while the destination is known unavailable and no call has begun, and records an interrupted or ambiguous in-flight call as `delivery_unknown` without automatic resend.

#### Scenario: Proactive destination is unavailable before dispatch

- **WHEN** a validated contact effect cannot resolve its home Surface as reachable before any Telegram API call begins
- **THEN** it SHALL remain pending according to its retry policy
- **AND** no dispatching marker or Telegram call SHALL be produced

#### Scenario: Process stops after dispatch begins

- **GIVEN** a contact effect persisted its dispatching marker
- **WHEN** startup cannot prove whether the Telegram call completed
- **THEN** reconciliation SHALL mark the delivery outcome unknown
- **AND** SHALL NOT automatically invoke Telegram again for that attempt

### Requirement: Proactive contact requires layered consent

A proactive-contact effect SHALL execute only when deployment-wide `innerLife.proactiveContact` is enabled, the home Surface currently permits proactive contact, and the frozen WakeProfile permits the contact effect. Missing policy SHALL default to denied. Every applicable layer SHALL be checked when the intent is accepted and again immediately before delayed delivery; a restrictive outer layer MUST NOT be overridden by another layer.

#### Scenario: Surface consent is absent

- **GIVEN** deployment-wide contact is enabled and the wake profile allows contact
- **WHEN** the home Surface has no affirmative proactive-contact consent
- **THEN** the contact effect SHALL be denied before Telegram dispatch
- **AND** the denial SHALL be recorded against the wake

#### Scenario: Consent is revoked while delivery is pending

- **GIVEN** a contact effect was accepted and retained pending for an unavailable Surface
- **WHEN** Surface consent is revoked before the next attempt
- **THEN** the effect SHALL become terminally denied
- **AND** SHALL NOT contact the user

### Requirement: Surface proactive consent has an explicit command

The authorized `/presence on|off|status` command SHALL inspect or update proactive-contact consent for the invoking Surface without creating a Conversation. Consent SHALL persist by canonical SurfaceId and survive `/new`, `/resume`, archive, and temporary unbinding. `on` MUST NOT override a disabled deployment-wide master policy; status SHALL report both the Surface choice and whether effective contact is currently denied by deployment policy.

#### Scenario: Enable presence on an unbound Surface

- **WHEN** an authorized user sends `/presence on` on an unbound Surface
- **THEN** affirmative Surface consent SHALL be persisted without creating a Conversation
- **AND** the reply SHALL report whether deployment policy currently permits effective proactive contact

#### Scenario: Disable presence while contact is pending

- **WHEN** the user sends `/presence off` on a Surface with pending contact effects
- **THEN** future consent checks SHALL deny those effects
- **AND** the command SHALL NOT need to load or create a Conversation

#### Scenario: Presence status is non-mutating

- **WHEN** the user sends `/presence status`
- **THEN** the reply SHALL identify Surface consent and deployment master state
- **AND** no wake, Conversation, or policy mutation SHALL occur

### Requirement: Contact is routed only to the explicit home Surface

A wake capability profile that permits proactive contact SHALL require one canonical home `SurfaceId` in the wake record. Contact SHALL resolve delivery from that Surface only. It MUST NOT infer or replace the destination from the current Conversation binding, shared Execution Environment, memory scope, project root, or another reachable Surface. Changing a home Surface requires a new explicit wake or future operator-controlled migration; an in-flight wake is never silently retargeted.

#### Scenario: Another Surface shares the environment

- **GIVEN** the home Surface is unavailable and another reachable Surface has the same project Execution Environment
- **WHEN** a contact effect is considered for delivery
- **THEN** no message SHALL be sent to the other Surface
- **AND** the original home Surface SHALL remain the effect's destination

#### Scenario: Wake kind cannot contact

- **WHEN** a non-contact capability profile creates a wake
- **THEN** its record MAY omit a home Surface
- **AND** any returned contact intent SHALL be rejected as outside the profile

### Requirement: Inner-life processing does not create Conversations

Inner-life reflection and delivery SHALL inspect the home Surface's current binding late and non-mutatively when Conversation context is needed. An unbound home Surface MUST NOT cause Conversation creation. A wake MAY reflect without a Conversation only when its profile defines sufficient bounded deployment context; otherwise it remains pending or fails according to that profile.

#### Scenario: Home Surface is unbound

- **WHEN** a contact-capable wake inspects an unbound home Surface
- **THEN** no Conversation SHALL be created
- **AND** pending reflection or delivery SHALL follow the profile's explicit no-binding policy

#### Scenario: Surface binding changes before delivery

- **WHEN** a wake's home Surface rotates or resumes another compatible Conversation
- **THEN** the wake SHALL retain the same home Surface
- **AND** any allowed late Conversation context SHALL come from the Surface's current binding rather than the original Conversation

### Requirement: Startup reconciles interrupted wakes before scheduling new work

Startup SHALL validate and reconcile every non-terminal wake and effect state before inner-life sources begin scheduling new wakes. Reflection states with no external effect MAY retry under a bounded attempt policy. Persisted effect states SHALL follow their effect-specific recovery semantics. Reconciliation and execution SHALL emit structured logs containing wake ID, kind, profile, home Surface when present, state transition, effect kind, and bounded failure reason without prompt bodies or secrets.

#### Scenario: Startup finds interrupted reflection

- **WHEN** a wake was persisted as reflecting but has no validated effect intents
- **THEN** reconciliation SHALL return it to a bounded retryable reflection state or mark it terminal according to its attempt limit
- **AND** SHALL NOT synthesize an effect outcome

#### Scenario: Reconciliation finishes before wake scheduling

- **WHEN** Goblin starts with non-terminal wake records
- **THEN** reconciliation SHALL complete or fail startup before heartbeat, dreaming, or other inner-life sources enqueue new wakes
- **AND** polling SHALL not expose partially reconciled effect authority

### Requirement: Heartbeat remains outside inner life

This change SHALL NOT convert heartbeat schedules into inner-life wakes or alter their existing Surface ownership, prompt resolution, interval, pending behavior, or dispatch through the Conversation runtime. Any future heartbeat integration MUST be established by a separate decision and delta specification.

#### Scenario: Heartbeat becomes due

- **WHEN** an existing Surface heartbeat occurrence becomes due after inner life is installed
- **THEN** it SHALL follow the `conversation-lifecycle` heartbeat contract
- **AND** SHALL NOT create a wake record merely because inner life exists
