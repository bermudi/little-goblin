# ACP External Agents — Design

## Architecture

### Runtime boundary

The external-agent subsystem keeps its existing task-level API and persistence boundary while replacing everything below `ExternalAgentAdapter`:

```text
main Goblin agent
  └─ external_agent(start/status/message/cancel/list)
       └─ ExternalAgentRunner
            ├─ ExternalRunStore (meta/events/result)
            ├─ AcpAdapter (one instance per configured server definition)
            │    └─ AcpRunConnection (one ACP server process + one session)
            │         ├─ ACP stdio JSON-RPC
            │         ├─ permission + filesystem handlers
            │         └─ AcpTerminalHost (zero or more run-scoped PTYs)
            └─ configured server catalog
                 ├─ codex  → pinned codex-acp package bin
                 ├─ claude → pinned claude-agent-acp package bin
                 ├─ devin  → installed `devin ... acp` command
                 └─ custom → trusted command/args from goblin.json5
```

Goblin remains the orchestrating agent. The Telegram user prompts Goblin; Goblin's model calls `external_agent`; Goblin then sends ACP `session/prompt`, answers permissions, and supplies client methods itself. The external ACP agent never becomes a Telegram participant.

An ACP server process is transport, not durable work. Each run gets one server process to isolate cancellation, stderr, terminals, and failures. The durable identity is the agent-owned ACP session id stored in `meta.json`. Restart recovery creates a fresh server process and calls `session/resume`; it never adopts the old process.

This implements `ACP servers host external-agent runs` and `Goblin autonomously operates ACP sessions` while preserving the existing runner/tool ownership seam.

### Configured server catalog

`src/external-agents/servers.ts` builds one immutable catalog at startup:

```ts
type BuiltInExternalAgentId = "codex" | "claude" | "devin";
type ExternalAgentId = string;

type AcpProfilePolicy =
  | { kind: "session-mode"; readOnly: string; workspaceWrite: string }
  | { kind: "command"; readOnly: readonly string[]; workspaceWrite: readonly string[] };

interface AcpServerDefinition {
  id: ExternalAgentId; // persisted in ExternalAgentRunRecord.backend
  baseCommand: readonly string[];
  profilePolicy: AcpProfilePolicy;
  configOptions: Readonly<Record<string, string>>;
  resumeEpoch: string;
  resumeEligible: boolean;
  fingerprint: string;
  source: "builtin" | "custom";
}
```

Built-in commands are code-owned. Claude/Codex resolve exact dependency bins; Devin retains its installed command. Exact Claude/Codex package versions receive `resumeEligible: true` only after package inspection and authenticated create/terminate/fresh-process-resume gates pass before cutover. Planning candidates are `claude-agent-acp@0.59.0` and `codex-acp@1.1.2`; Devin and every custom definition are `resumeEligible: false` in this change. `@lydell/node-pty@1.2.0-beta.12` hosts virtual terminals.

Custom definitions are trusted deployment configuration, not model input. The schema gives every string/count an exact limit, requires session-mode ids for both profiles, accepts only string-valued ACP select options, and has no environment field. `prepareEnv()` remains the only child environment source. Codex and Claude use code-owned `session-mode` policies (`read-only`/`agent`, `plan`/`acceptEdits`); Devin uses a code-owned `command` policy that adds `auto`/`accept-edits` arguments. Custom servers always use `session-mode`. No policy selects bypass/full-access behavior through model input.

The fingerprint is SHA-256 over canonical JSON containing server id, base command, complete profile policy, sorted select options, resume epoch, and code-owned resume eligibility. Built-ins additionally include exact bridge package name/version. A custom executable replaced at the same path is an operator-controlled compatibility decision, so operators must increment `resumeEpoch` for an incompatible replacement. This avoids unreliable hashing of interpreter scripts named in arguments while providing explicit invalidation. A changed fingerprint blocks resume before session-id disclosure.

This implements `external agent configuration is explicit and bounded` and narrows decision 0012 only at the trusted-operator configuration boundary: the model still cannot select executable, arguments, cwd, environment, or ACP options.

### ACP connection and session routing

`src/external-agents/acp.ts` owns the generic protocol client. It uses `@agentclientprotocol/sdk` validation and typed methods but keeps its own session-id routing rather than relying only on the current Devin adapter's new-session `ActiveSession` helper. Recovery must attach handlers before sending raw typed `session/resume`; the connection therefore routes `session/update` notifications and request handlers by the one session id associated with that run.

New-run order:

```text
reserve concurrency slot synchronously
  → persist initial meta.json + absolute deadline
  → spawn server with sanitized env
  → initialize(clientInfo=goblin, fs=true, terminal=true)
  → validate protocol + capabilities
  → session/new(canonical cwd, no MCP servers)
  → persist acpSessionId + resume flag + fingerprint into meta.json
  → apply configured select values
  → enforce security profile last + verify resulting state
  → session/prompt(original task)
  → stream normalized updates until stop reason
```

This preserves the concurrency contract: rejected starts create nothing, and accepted starts reserve before filesystem mutation. Initial metadata lands before adapter execution; the session checkpoint follows `session/new` but precedes task delivery. Failure before spawn releases immediately. Failure after spawn claims pending `failed`, enters `stopping`, and releases only after confirmed child exit; cleanup failure blocks starts rather than reporting stopped work.

`session/update` mapping stays intentionally small:

- `agent_message_chunk` and `agent_thought_chunk` → bounded `output`;
- `tool_call`, `tool_call_update`, plan/usage updates → bounded `status`;
- mode/config updates → bounded `status` plus policy-state verification; drift cancels the prompt and claims pending `failed`;
- prompt stop reasons claim pending `completed`, `failed`, or `cancelled` as specified, then enter `stopping`;
- connection/protocol failure claims pending `failed` unless another outcome already won.

Terminal outcomes are not exposed until ordered persistence and local child exit complete. The adapter allows at most 32 concurrent agent-to-client requests; excess requests receive a typed overload response immediately, with no queue.

ACP has no `input_required` stop. `message` accepts only the current completed lineage head of a resume-eligible session, synchronously claims it, creates a child with new deadline/`continuedFromRunId`, starts a fresh server, resumes, reapplies policy, and prompts. The source stays completed. A serialized lineage/session claim checks persisted records for any existing child—terminal or not—and any non-terminal session user. Thus A→B makes A permanently stale; after B completes, only B may continue.

The adapter validates every message, rejects NDJSON frames above 2 MiB before JSON decoding, retains at most 64 KiB of server stderr, caps agent-to-client concurrency at 32, and keeps no provider parser. It never logs raw frames. Structured logs use only run id, configured server id, lifecycle category, and bounded non-sensitive error classification.

### Autonomous permission and filesystem policy

The generic connection registers client handlers before initialization:

- `fs/read_text_file`: bound path, validate one-based positive-safe `line`/`limit`, clamp `limit` to 10,000 lines, resolve the existing target inside the canonical root, and reject (not truncate) output over 1 MiB UTF-8 bytes.
- `fs/write_text_file`: require `workspace-write` and ≤1 MiB valid UTF-8. Existing targets must be non-symlinks inside the project. Missing targets require a real existing in-project parent; no directories are created, and temp+rename stays in that parent.
- `session/request_permission`: validate session/tool call and current verified policy. Offered rejection may continue. `allow_once` is available only under verified `workspace-write`. With no safe option, return ACP `cancelled`, cancel the prompt, and claim pending `failed(permission_policy_incompatible)`; never treat cancellation as continuation.
- elicitation/auth methods not implemented by Goblin return a typed unsupported error rather than opening Telegram UI.

Configured ordinary select values are applied first; the security profile is applied last and its resulting mode/config state is verified before prompting. During a turn, mode/config updates are checked against expected state. Drift invalidates permissions, cancels the prompt, and claims `failed(profile_drift)`. Built-in mode semantics are code-owned; custom mode semantics are trusted operator assertions under decision 0012. `allow_once` is never proof of generic sandboxing. Goblin is the operator, not a human relay.

### Virtual PTY terminal host

`src/external-agents/acp-terminal.ts` implements the ACP terminal capability with `@lydell/node-pty`. The ACP server itself remains on clean stdio pipes; only commands requested through `terminal/create` receive a pseudo-terminal. Mixing the ACP transport with a PTY would corrupt newline-delimited JSON with terminal control behavior.

Each `AcpTerminalHost` belongs to one run and holds:

```ts
interface HostedTerminal {
  id: string;
  process: IPty;
  output: BoundedUtf8Tail;
  truncated: boolean;
  exit: Promise<ProcessExit>;
}
```

`terminal/create` checks session/policy, rejects request environment/NULs, bounds command to 4,096 characters and arguments to 128 × 4,096, and caps the registry at eight unreleased entries; exited/killed entries count until release. It defaults cwd to project, bounds/resolves it with `realpath`, and rejects escape. `outputByteLimit` defaults to 2 MiB, rejects non-safe/non-positive numbers, and clamps larger safe integers. It starts command/args without shell interpolation under `prepareEnv()`; random ids resolve only inside that run host.

Output is retained as a bounded UTF-8 tail so long-running commands cannot grow memory without limit. When dropping bytes from the front, the buffer advances to the next valid code-point boundary and may therefore retain slightly less than the byte limit. `terminal/output` returns current output, explicit truncation, and exit status when known. `wait_for_exit` supports request cancellation without killing the command. `kill` terminates but retains final output; `release` kills if needed and removes the entry. `dispose()` kills and removes every entry and is called for completion, failure, cancel, timeout, disconnect, detach, and startup failure.

The host provides TTY semantics, not interactive stdin. ACP v1 defines no terminal-input method, so no keystroke or Telegram relay is added. Read-only sessions receive a typed rejection rather than an unsandboxed read-only imitation. This implements `ACP terminal methods use bounded run-scoped virtual PTYs` under decision 0012's stated same-user residual risk.

### Persisted ACP checkpoint

`ExternalAgentRunRecord` replaces the closed backend union with a validated external-agent id and changes new records to `adapterKind: "acp"`. It adds optional migration-safe fields:

```ts
interface ExternalAgentRunRecord {
  // existing fields
  backend: string; // configured ACP server id; field name retained for migration
  adapterKind: "native" | "pty" | "acp";
  acpSessionId?: string;
  acpResumeSupported?: boolean;
  acpResumeEligible?: boolean;
  acpServerFingerprint?: string;
  deadlineAt?: string;
  recoveryReadyAt?: string;
  continuedFromRunId?: string;
  hostBootId?: string;
  pendingTerminalStatus?: "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
}
```

The old `native` and `pty` adapter kinds remain loadable. Terminal legacy records stay readable in their original format indefinitely; they are not rewritten with fake ACP fields. Non-terminal native records become `interrupted`. Non-terminal PTY records become `interrupted` only after migration-only, exactly owner-scoped daemon cleanup succeeds. New starts always write `acp`.

`deadlineAt` is assigned once per run and never reset by recovery. A follow-up child gets its own deadline and `continuedFromRunId`. Initial metadata stores Linux `/proc/sys/kernel/random/boot_id`. Session id, advertised resume support, code-owned resume eligibility, fingerprint, and deadline precede prompt delivery. `stopping` records persist `pendingTerminalStatus`; the terminal status replaces it only after child exit confirms. Startup resumability requires a complete checkpoint plus `recoveryReadyAt`. The marker is absent while local work may be alive.

Task text remains only in the in-memory start input and in the external agent's own session store. Goblin's recovery prompt is a constant similar to:

> Goblin restarted while your previous turn was active. Continue the same task. First inspect this session and the current project state; do not repeat work that is already complete. Finish the task and report the result.

This implements `external run records are bounded and persisted` and `resumable ACP runs continue through a fresh server process` without adding task persistence.

### Startup recovery

`ExternalAgentRunner.init()` remains the startup gate before Telegram polling and new starts:

1. Load records and clean expired terminal directories.
2. Leave terminal legacy records unchanged. Mark non-terminal `native` records `interrupted` without task replay.
3. For each non-terminal legacy `pty` record, invoke only bounded `kill-owner` using its exact persisted owner. Mark it `interrupted` after success. On unverifiable cleanup, fail initialization and leave it non-terminal; never inspect, type into, or adopt it.
4. For each non-terminal ACP record, compare `hostBootId`. If clean-detach proof is absent but boot id changed, atomically mark `interrupted`: prior-boot processes cannot survive. If proof is absent on the same boot, fail initialization and leave it non-terminal/`stopping`.
5. For clean records, validate checkpoint/deadline/fingerprint. An already expired record claims pending `timed_out` and needs no process cleanup because clean detach proved no local child.
6. Restore the slot and arm `deadlineAt` before spawn. Restored activity may exceed a lowered maximum and blocks acquisition.
7. Clear `recoveryReadyAt`; on write failure release the slot without spawn.
8. Spawn/initialize with each task operation bounded by `min(protocolTimeout, deadlineAt-now)` and require current resume capability.
9. Call `session/resume`, apply ordinary select values, enforce security profile last, verify state, and never call `session/load`.
10. Observe and send continuation under the remaining task deadline.
11. On any terminal claim, enter `stopping`, prohibit further task work, and use a separate fixed 10-second cleanup grace. Persist/expose the target and release the slot only after child exit. Grace expiry leaves `stopping` and blocks starts.
12. Log aggregate counts (`resumed`, `expired`, `interrupted`, `failed`, `blocked`, `legacyCleaned`) and configured server ids, never session ids/output.

The limiter changes from an available-token counter to explicit active/max accounting or gains a tested `restore(count)` operation. Restored active work may exceed a newly lowered maximum; valid runs continue and new acquisition stays blocked until active count drops below the configured maximum.

Recovery is a new turn after clean detach, not survival of the old request. A same-boot hard crash never auto-resumes; after reboot, Goblin interrupts rather than resumes the record because old OS children are provably gone. Existing file changes remain real, and exactly-once side effects are not promised.

### Detach, cancellation, and shutdown

`ExternalAgentHandle` gains an explicit `detach()` operation. As in the useful part of the superseded PTY design, detach and cancel remain separate verbs:

- `detach()` closes observation, kills terminals, closes transport, terminates the server, and resolves only after all known local children report exit; it sends no `session/cancel`/`session/close` and makes no terminal transition.
- `cancel()` claims a pending outcome, sends `session/cancel`, calls `session/close` when appropriate, disposes terminals, and terminates the server under a fixed 10-second cleanup grace.
- successful `end_turn` claims pending `completed` and disposes local resources without `session/close`, preserving the provider session for immutable follow-up. It becomes `completed` only after child exit.

`ExternalAgentRunner.shutdown()` rejects starts. It detaches resumable runs, then writes `recoveryReadyAt` only after confirmed exit. Non-resumable runs claim pending `interrupted` and enter `stopping` until destructive cleanup confirms. A detach flag prevents close from becoming failure. Explicit cancellation supersedes recovery, clears/prevents readiness, and shared cleanup settles once. Cleanup failure leaves `stopping` and blocks starts. A same-boot hard crash cannot write proof, so `init()` blocks; a changed boot id proves old processes gone and reconciles the record to `interrupted`.

`cancelBySession()` never calls detach. This keeps process lifecycle distinct from Goblin session lifecycle and implements the modified orchestration requirement.

### Preflight

`runExternalAgentsPreflight()` receives the resolved server catalog. For each enabled definition, it starts the server with the sanitized environment, connects through the same ACP transport helper, sends only `initialize`, validates the protocol version/capabilities, records resume support for a non-sensitive startup summary, and closes the process. It does not create a probe session or modify provider state.

Claude/Codex must advertise resume and pass exact-version fresh-process smoke gates before their definitions can ship `resumeEligible: true`; failure blocks cutover. Devin/custom definitions remain false regardless of advertised capability, which is reported only diagnostically. Missing, malformed, oversized, or incompatible ACP is fatal before polling. Runtime package download is forbidden; production installation gets pinned bridges through `bun install --frozen-lockfile`.

## Decisions

### D1: ACP is the only protocol for new external-agent runs

**Chosen:** Replace provider-native JSON adapters and PTY fallback with one ACP client.

**Why:** ACP already standardizes prompts, updates, permissions, filesystem requests, terminal hosting, and session resume. A single protocol removes duplicate parsers and makes custom ACP agents possible without adding one adapter per provider.

**Constraint:** Enabled agents must expose ACP directly or through an installed bridge. Native JSON modes are removed rather than retained as a fallback stack.

### D2: Goblin is the autonomous ACP operator

**Chosen:** Permission and client-method requests are answered from Goblin's configured policy; no Telegram approval relay is added.

**Why:** The main Goblin model delegated the task and remains responsible for driving it. Telegram is Goblin's UI, not the external agent's UI.

**Constraint:** Every prompt applies ordinary options first, enforces the code-owned built-in or trusted custom security policy last, verifies it, and monitors drift. `workspace-write` can grant `allow_once`; `read-only` denies escalation. ACP policy is defense in depth under decision 0012, not a custom-server sandbox. There is no human override.

### D3: One ACP server process per run

**Chosen:** Do not copy Zed's shared multi-session server connection.

**Why:** Per-run processes fit the existing runner seam and make timeout, cancellation, stderr, terminal ownership, and tests isolated. The configured concurrency limit already bounds process count.

**Constraint:** Concurrent runs for the same provider start multiple bridge processes; the configured limit bounds that cost.

### D4: Resume the conversation, then prompt continuation

**Chosen:** Persist the ACP session id and use `session/resume`, followed by one code-owned continuation prompt, only after graceful shutdown proves local child exit through `recoveryReadyAt`.

**Why:** ACP resume restores agent context but does not promise that an in-flight prompt continues executing after its server process dies. Sending the original task again would be a replay; a continuation prompt instead tells the agent to inspect its own session and filesystem state.

**Constraint:** This is not uninterrupted or exactly-once. A continuation may repeat side effects. Hard-crash records without clean-detach proof block startup rather than resume. Tool/status text must not imply process durability.

### D5: Use `session/resume`, not `session/load`, during recovery

**Chosen:** Recovery does not request history replay.

**Why:** Goblin already persisted bounded updates accepted before shutdown. `session/load` replays conversation history and would require message/chunk checkpoints and deduplication. `session/resume` restores context without replay.

**Constraint:** Output emitted by the old server but not persisted before failure may be absent from Goblin's event log. The resumed agent's later result is authoritative for the continued run.

### D6: Host actual PTYs only for ACP terminal methods

**Chosen:** Keep ACP transport on pipes and allocate `@lydell/node-pty` terminals only for `terminal/create` under `workspace-write`.

**Why:** Some commands require TTY semantics, while ACP itself requires clean structured stdio. A local terminal host is much smaller than a durable daemon and follows Zed's client-side terminal model.

**Constraint:** Terminals are run-local and non-durable; read-only terminal creation and request-provided environment entries are rejected; ACP v1 provides no terminal stdin forwarding.

### D7: Built-ins are pinned; custom servers are local trusted config

**Chosen:** Install exact Claude/Codex bridge dependencies and let operators register bounded local command/args definitions. Do not implement the ACP Registry.

**Why:** This provides the Zed-like extension seam without runtime downloads, registry cache/update policy, or a remote supply-chain boundary. The `external_agent` model can choose only enabled ids, never command material.

**Constraint:** Operators install custom servers, map both permission profiles to server-defined modes, use string select options only, and bump `resumeEpoch` for incompatible same-path replacements. Auth uses user-scoped credential stores because environment overrides remain forbidden.

### D8: Resume capability is capability-driven

**Chosen:** Exact Claude/Codex definitions require advertised resume plus a passing authenticated fresh-process smoke test and persist `resumeEligible: true`. Devin/custom definitions persist false in this change regardless of advertised support.

**Why:** ACP resume is optional in v1. Rejecting every non-resume server would undermine the generic adapter, while pretending it is durable would be dishonest.

**Constraint:** Automatic resume and immutable follow-up require both advertised support and code-owned eligibility. Ineligible runs are interrupted on graceful shutdown after confirmed cleanup; support diagnostics do not upgrade eligibility.

### D9: Detach remains distinct from cancel

**Chosen:** Add explicit handle/runner shutdown operations rather than overloading cancellation with a preserve flag.

**Why:** Disconnecting a resumable transport preserves task intent; cancellation terminates the run and active session. Separate verbs keep destructive session-lifecycle call sites sharp.

**Constraint:** `recoveryReadyAt` is written only after confirmed local child exit and cleared before recovery spawn. Missing same-boot proof blocks startup; a changed Linux boot id safely reconciles to `interrupted`. Shutdown/startup races require targeted tests and exactly-once release.

### D10: Terminal claims wait for process cleanup

**Chosen:** Add non-terminal `stopping` plus `pendingTerminalStatus`. Task timeout and cancellation claim an outcome immediately, but Goblin exposes it as terminal only after known local children confirm exit. Cleanup gets a fixed 10-second grace separate from the task deadline.

**Why:** Reporting `completed`, `cancelled`, or `timed_out` while same-user work may still mutate the project is dishonest. A separate cleanup grace stops task execution on time without making cleanup impossible at zero remaining task time.

**Constraint:** Cleanup failure blocks new starts and remains inspectable as `stopping`; it never silently releases concurrency. A host reboot proves prior-boot processes are gone and allows atomic interruption.

### D11: Record the new boundary as a decision

**Chosen:** Add decision 0030 for ACP server/session separation, autonomous policy, clean-detach continuation, stopping/cleanup semantics, and legacy PTY migration; abandon decision 0019 and amend decision 0011's process-shutdown cancellation clause. Decision 0030 narrows decision 0013's non-resumability rule only for cleanly detached ACP records while retaining bounded artifacts and safe orphan handling.

**Why:** These are standing architectural rules beyond this implementation. Keeping them only in a change design would let later work accidentally reintroduce process adoption claims, human approval relays, or falsely mark legacy PTY work stopped without cleanup.

**Constraint:** Decision 0012 remains authoritative for sanitized environments and same-user residual filesystem risk; 0030 only clarifies that trusted deployment config may name a custom ACP server command while model-facing input may not.

## File Changes

### Dependencies and configuration

- `package.json` — add exact eligible versions of `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, and `@lydell/node-pty`; keep `@agentclientprotocol/sdk` exact. Implements `ACP servers host external-agent runs` and `ACP terminal methods use bounded run-scoped virtual PTYs`.
- `bun.lock` — lock the bridge/PTY dependency graph; no runtime package installation.
- `src/schema.ts` — add exact custom-server command/args/profile-mode/string-select/resume-epoch bounds, remove `ptyFallback`, reject unknown fields/collisions/NULs, and preserve built-in/max/timeout/profile bounds. Implements `external agent configuration is explicit and bounded`.
- `src/config.ts` — freeze nested custom server definitions, args, and config-option maps.
- `src/config.test.ts` — cover custom ids/limits/collisions, removed `ptyFallback`, unknown fields, and deep freezing.

### ACP runtime

- `src/external-agents/servers.ts` — new immutable built-in/custom server catalog, package-bin resolution, enabled-id collection, and canonical fingerprinting.
- `src/external-agents/servers.test.ts` — cover exact built-in commands, custom resolution, deterministic sorted fingerprints, and secret-free definitions.
- `src/external-agents/acp.ts` — new generic ACP connection/session adapter, initialization, new/resume/prompt/cancel/close, session-id routing, update normalization, permissions, and rooted filesystem handlers.
- `src/external-agents/acp.test.ts` — fake-server coverage for frame/stderr bounds, checkpoint-before-prompt, new/resume, all real stop reasons, immutable follow-up, permissions, bounded rooted fs, profile mode/select application after new and resume, malformed protocol, detach, cancel, and races.
- `src/external-agents/acp-terminal.ts` — new run-scoped virtual PTY host implementing the ACP terminal request contract and bounded output.
- `src/external-agents/acp-terminal.test.ts` — fake PTY coverage for create/output/wait/kill/release, UTF-8 bounds, truncation, cwd/session isolation, env rejection, read-only denial, request cancellation, and dispose-all.
- `src/external-agents/types.ts` — add configured ids, `stopping`/pending outcome, ACP checkpoint/boot-id/clean-detach/continuation fields, handle behavior, and terminal seams; remove native retry types.
- `src/external-agents/mod.ts` — export the new public types/runtime and stop exporting native-only types.

### Runner, persistence, and tool

- `src/external-agents/runner.ts` — resolve configured ACP adapters, checkpoint before prompts, chain immutable follow-up runs, remove PTY fallback, restore concurrency/deadline before recovery spawn, require/clear clean-detach proof, distinguish detach from cancel, and preserve owner-scoped lifecycle.
- `src/external-agents/runner.test.ts` — replace native/PTY fallback tests with ACP new/resume, checkpoint failures, legacy migration, deadline recovery, fingerprint drift, continuation, over-limit restore, shutdown/cancel races, and exactly-once cleanup tests.
- `src/external-agents/store.ts` — validate arbitrary bounded agent ids plus optional ACP checkpoint fields while preserving readable terminal legacy records.
- `src/external-agents/store.test.ts` — cover ACP bounds, boot ids, stopping/pending invariants, malformed timestamps/session ids/fingerprints, unchanged terminal legacy records, and legacy reconciliation.
- `src/external-agents/legacy-pty.ts` — retain only bounded, exact-owner `kill-owner` RPC needed to reconcile non-terminal records created by the removed fallback; expose no spawn, attach, output, or input operation.
- `src/external-agents/legacy-pty.test.ts` — cover exact owner derivation, timeout/failure propagation, no task/output access, and startup blocking when cleanup cannot be verified.
- `src/external-agents/tool.ts` — use configured agent ids, update prompt guidance from terminal interaction to Goblin-authored ACP follow-up, and keep command/session/terminal details out of schema/results.
- `src/external-agents/tool.test.ts` — cover custom ids, disabled arbitrary ids, completed-source follow-up child runs, concurrent-session rejection, and owner/project isolation.
- `src/external-agents/preflight.ts` — probe each enabled server with side-effect-free ACP initialize, report resume support, and remove executable-version/agent-pty checks.
- `src/external-agents/preflight.test.ts` — cover valid built-in/custom initialize, malformed/old ACP, timeout, missing command, non-resumable warning, and no session creation.
- `src/external-agents/env.ts` / `src/external-agents/env.test.ts` — retain the exact allowlist and prove both ACP server and terminal paths consume it without request overrides.
- `src/agent/mod.ts` — register the tool when the resolved enabled-id union is non-empty and inject that list instead of only `backends`.

### Removed adapter paths

- `src/external-agents/codex.ts` — delete after Codex runs through the pinned ACP bridge.
- `src/external-agents/claude.ts` — delete after Claude runs through the pinned ACP bridge.
- `src/external-agents/devin.ts` — delete after its handlers move into generic `acp.ts`.
- `src/external-agents/devin.test.ts` — replace backend-specific tests with generic ACP tests.
- `src/external-agents/agent-pty.ts` — delete after moving its narrow `kill-owner` migration behavior to `legacy-pty.ts`; no new run may spawn or attach through `agent-pty`.
- `src/external-agents/agent-pty.test.ts` — replace with `acp-terminal.test.ts`.

### Orchestration and project artifacts

- `src/index.ts` — call `ExternalAgentRunner.shutdown()` in the existing scheduler-first guarded shutdown sequence.
- `src/orchestration/dispatcher.ts` and `src/orchestration/dispatcher.test.ts` — retain destructive `cancelBySession` for session disposal and verify no caller switches to detach.
- `specs/glossary.md` — add `ACP server process`, `ACP external-agent session`, and `ACP continuation`; update `native adapter`/external-agent wording after archive.
- `specs/decisions/0030-acp-external-agent-boundary.md` — record D2/D4/D9 as standing architecture.
- `specs/decisions/0019-pty-run-adoption.md` — mark abandoned in favor of decision 0030.
- `specs/changes/durable-external-agent-runs/proposal.md` — mark superseded by `acp-external-agents`; retain artifacts as historical fallback analysis until the owner archives them.
