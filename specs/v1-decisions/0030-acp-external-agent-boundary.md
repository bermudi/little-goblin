# ACP External-Agent Boundary

## Status

proposed

## Context

The original external-agent runner uses provider-native structured protocols for Codex and Claude, ACP for Devin, and a PTY fallback when a backend demands interaction. A proposed durability change would preserve only PTY-backed processes through a separately supervised daemon. That leaves ordinary structured runs non-durable and introduces process adoption, output replay, and cross-service versioning.

ACP provides a narrower durable identity: an agent-owned logical session. Claude and Codex ACP bridges advertise `session/resume`, and Devin already communicates over ACP. A new Goblin process can start a fresh ACP server and resume that session without adopting an OS process. ACP also makes the client responsible for permission, filesystem, and terminal requests, so the design must state whether Goblin or the Telegram user acts as operator.

## Decision

All new external-agent runs SHALL use ACP directly or through a configured local bridge. Goblin SHALL be the autonomous ACP client: it applies ordinary options then security policy last, verifies/monitors resulting state, answers permissions only while verified, and provides bounded filesystem/terminal methods. Built-ins MUST NOT select bypass/full-access behavior; custom mode semantics are trusted operator assertions. Drift SHALL cancel/fail the prompt. If a permission request offers no safe outcome, ACP `cancelled` terminates the prompt; it is not denial-with-continuation. Policy remains defense in depth under decision 0012, not a generic custom-server sandbox. External agents have no Telegram access or approval relay.

An ACP server process SHALL be treated as disposable transport, distinct from its agent-owned ACP session. A resumable run SHALL persist session id, fingerprint, advertised resume support, separate code-owned resume eligibility, and absolute deadline before the first task prompt. This change grants eligibility only to exact pinned Claude/Codex definitions after fresh-process smoke gates; Devin/custom definitions remain ineligible regardless of advertised support. Graceful shutdown MAY preserve the non-terminal run only after terminating and confirming exit of all known local server/terminal children and atomically persisting clean-detach proof. Startup SHALL restore concurrency and deadline enforcement, clear proof, start the same server, resume, re-enforce policy, and send continuation. Task operations stop at the absolute deadline; local cleanup gets a separate fixed grace that cannot execute more task work.

ACP continuation is not process adoption, uninterrupted execution, original-task replay, or exactly-once execution. A same-boot hard crash cannot produce clean-detach proof and SHALL block startup rather than race unknown children. Every active record stores Linux host boot id; after reboot, a changed id proves prior processes cannot survive, so startup SHALL mark the unclean record `interrupted` without resume. Goblin SHALL NOT claim work continued offline or use `session/load` for output replay.

Custom ACP server commands, profile-mode mappings, string select options, and resume epoch MAY be selected only through exactly bounded trusted deployment configuration. Operators SHALL bump the epoch for incompatible same-path replacements. Model-facing input MUST NOT provide or override executable, arguments, cwd, environment, permission profile, ACP session id, mode/options, epoch, or terminal primitives. All ACP server and terminal children SHALL retain decision 0012's sanitized environment and same-user residual-risk boundary.

Process shutdown detachment SHALL remain distinct from cancellation. Runs SHALL use non-terminal `stopping` with a pending terminal outcome while cleanup is unconfirmed. Explicit cancel, timeout, completion, failure, and session disposal expose terminal status only after known local children exit; cleanup failure blocks new starts and MUST NOT be reported stopped. Graceful shutdown preserves only valid checkpoints with clean-detach proof. Completed turns remain immutable; follow-up creates a child run.

This decision supersedes proposed decision 0019 and narrows decision 0013's blanket non-resumability rule only for ACP records with valid resume checkpoints. Decision 0013's bounded artifact rules continue to apply. Its safe orphan-cleanup rule also continues to govern legacy records: terminal native/PTY records remain readable in their original format; non-terminal native records become `interrupted`; and non-terminal PTY records become `interrupted` only after bounded, exactly owner-scoped daemon cleanup succeeds. If that cleanup cannot be verified, startup SHALL fail before polling or new external starts and SHALL leave the record non-terminal. Migration cleanup MUST NOT inspect, adopt, or send input to a legacy PTY process.

## Consequences

- Easier: Codex, Claude, Devin, and configured custom agents share one protocol adapter and permission boundary.
- Easier: verified ACP sessions can continue across clean Goblin restart without a durable PTY daemon or OS-process adoption.
- Easier: Goblin, not the Telegram user, remains responsible for delegated-agent interaction.
- Harder: recovery starts a new prompt and can repeat non-idempotent side effects; exactly-once execution is not promised.
- Harder: agents without verified resume remain non-resumable; same-boot hard-crash/cleanup-failed records block starts until cleanup succeeds or a host reboot proves old processes gone.
- Constraint: local ACP terminal children are bounded, run-scoped, and non-durable.
- Constraint: `agent-pty` remains reachable only through migration cleanup for old non-terminal PTY records; it is not a runtime adapter or resumable transport.
- Constraint: operators install and authenticate custom ACP servers; Goblin does not fetch the ACP Registry or forward provider API-key environment variables.
