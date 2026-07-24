# ACP External Agents

## Motivation

`ExternalAgentRunner` currently integrates three coding agents through three different process protocols: Codex JSON events, Claude stream JSON, and Devin ACP. A fourth `AgentPtyAdapter` restarts an agent in terminal mode when the structured path reports that interaction is required. This split creates backend-specific parsing, a destructive structured-to-PTY restart, and a durability plan aimed only at the uncommon PTY fallback path.

ACP already defines the boundary Goblin needs. An ACP client can create and resume agent-owned sessions, send prompts, receive normalized updates, answer permission requests, provide filesystem operations, and host bounded terminal commands. Claude and Codex have maintained ACP adapters with `session/resume`; Devin already speaks ACP in the current implementation. Goblin can therefore act as the autonomous ACP client — prompting, granting or denying permissions from code-owned policy, and supplying terminal services — rather than relaying an external agent's UI to the Telegram user.

This change replaces provider-specific adapters and PTY fallback with one capability-driven ACP runtime. It makes exact pinned, fresh-process-verified Codex and Claude sessions continuable after a clean Goblin restart. Devin and custom servers run through ACP but remain explicitly non-resume-eligible in this change, even if they advertise resume. It supersedes `durable-external-agent-runs`: Goblin no longer preserves or adopts an `agent-pty` process, because a fresh ACP server process can resume an agent-owned session after clean local teardown.

## Scope

### ACP external-agent runtime

- Replace `CodexAdapter`, `ClaudeAdapter`, `DevinAdapter`, and `AgentPtyAdapter` execution with one generic ACP adapter over newline-delimited JSON on child-process stdio.
- Run one ACP server process per external-agent run. Initialize it as client `goblin`, validate its advertised capabilities, create or resume one ACP session rooted at the run's canonical project directory, send Goblin-authored prompts, and normalize ACP session updates into the runner's existing bounded event model.
- Ship pinned Claude and Codex ACP adapter packages as application dependencies and retain Devin's installed ACP command as a built-in server. Do not download package code at run time.
- Keep the existing built-in allowlist for `codex`, `claude`, and `devin`, and add trusted operator configuration for additional local ACP server commands. Custom server ids become valid `external_agent.agent` values only when configured; command, arguments, working directory, and environment remain unavailable to model-facing tool input.
- Map the global permission profile to code-owned policies for built-ins (`codex`: `read-only`/`agent`; `claude`: `plan`/`acceptEdits`; Devin keeps code-owned profile arguments). Require custom servers to map both profiles to trusted ACP mode ids. Apply ordinary select options first, security mode last, verify resulting state after new/resume, and fail/cancel on later mode or configured-option drift.
- Let custom configuration set exactly bounded string-valued ACP select options plus a resume-compatibility epoch. Unsupported values fail before prompting; boolean/numeric values are rejected.
- Replace executable-version preflight with bounded ACP initialize for every enabled server. Persist advertised resume support separately from code-owned eligibility: exact smoke-verified Claude/Codex definitions are eligible; Devin/custom definitions are not in this change.

### Goblin-owned interaction and virtual terminals

- Goblin is the ACP client and autonomous operator. The Telegram user does not answer external-agent permission prompts or type into an external-agent terminal.
- Answer `session/request_permission` only while profile state is verified. Offered rejection may continue; `workspace-write` may select only `allow_once`. If no safe response is offered, return ACP `cancelled` and fail the prompt with a policy-incompatibility reason—never pretend cancellation is denial-with-continuation.
- Continue to serve bounded ACP filesystem methods only inside the canonical project directory. Writes require `workspace-write`. Profile modes are the primary backend policy; permission responses and cwd checks are defense in depth, not an OS sandbox. Custom mode mappings are trusted operator assertions under decision 0012's same-user residual-risk boundary.
- Advertise ACP terminal capability and implement `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release` with run-scoped virtual PTYs. Terminal requests are denied under `read-only`; under `workspace-write`, commands run in the bound project directory with the same sanitized environment policy as the ACP server.
- Bound each terminal's retained UTF-8 output and report protocol truncation explicitly. Terminal ids are opaque, scoped to one ACP session, and released or killed on run cancellation, timeout, ACP disconnect, or terminal release.
- Preserve the `external_agent message` action without inventing an ACP `input_required` stop reason. After a run completes with real ACP `end_turn`, `message` creates a new immutable child run that starts a fresh server, resumes the same ACP session, and sends Goblin's follow-up. The completed source run is never reopened, and concurrent continuations of one ACP session are rejected.

### Resumable run lifecycle

- Preserve start ordering: reserve a slot, persist initial metadata (configured server id in `backend`, Linux host boot id, absolute deadline), then start the server. After `session/new`, checkpoint ACP session id, fingerprint, and resume capability before task delivery. Do not persist task text.
- Split process shutdown from run cancellation. Graceful Goblin shutdown disconnects resumable ACP runs without calling `session/cancel` or `session/close`, confirms that their local server and terminal children exited, then atomically marks them recovery-ready while leaving them non-terminal. Explicit cancel, timeout, and Goblin session disposal remain destructive.
- Do not auto-resume a same-boot record left active by SIGKILL, crash, or failed cleanup. Without recovery-ready proof, startup blocks rather than risk concurrent project work. After a host reboot, a changed persisted boot id proves prior OS children cannot remain, so startup atomically marks the unclean record `interrupted` without resume and continues.
- At startup, mark legacy native records and ACP records without usable resume capability `interrupted`. Mark legacy PTY records `interrupted` only after exactly owner-scoped migration cleanup succeeds; otherwise fail startup and leave them non-terminal. For each cleanly detached resumable ACP record, restore concurrency accounting and arm its original absolute deadline before starting the same server; initialize, verify resume capability, call `session/resume`, re-enforce the profile policy/options, and send a code-owned continuation prompt.
- Treat ACP resume as conversation continuation, not process adoption or exactly-once execution. Initialize/resume/continuation are bounded by the remaining task deadline. A claimed terminal outcome enters non-terminal `stopping`; task work ceases and local teardown gets a separate fixed 10-second grace. The terminal status and slot release occur only after child exit confirms; cleanup failure remains `stopping` and blocks starts.
- Do not attempt complete output replay across the disconnect. Goblin keeps events already persisted before shutdown; `session/resume` deliberately does not replay history. Subsequent agent output continues the same bounded result stream.

### Orchestration and cleanup

- Add a detach-aware external-runner shutdown path to the scheduler-first sequence. Resumable records become recovery-ready only after confirmed clean detach; non-resumable runs claim pending `interrupted` and become terminal only after destructive cleanup confirms exit.
- Keep `cancelBySession()` destructive so `/cancel`, `/new`, `/resume`, `/archive`, and `/project` continue to terminate external work owned by the disposed Goblin session.
- Remove `ptyFallback` configuration, PTY fallback transitions, and normal runtime dependence on the `agent-pty` executable. Startup retains only a bounded migration cleanup for non-terminal legacy PTY records: kill their exactly owner-scoped daemon sessions before marking them `interrupted`, and fail startup without changing the record if safe cleanup cannot be verified. Terminal legacy records remain readable in their original format.
- Abandon decision 0019. A new ACP-session decision supersedes decision 0013's blanket non-resumability rule for resumable ACP records while retaining its bounded persistence rules and safe legacy-process cleanup requirement.

## Non-Goals

- No guarantee that in-flight work continues offline. Automatic continuation requires clean-detach proof; same-boot crash records block, while rebooted-host records become `interrupted` rather than resumed.
- No exactly-once guarantee for repository or external side effects around a crash. The continuation prompt instructs the agent to inspect session and filesystem state before acting, but agents and tools may still repeat non-idempotent work.
- No ACP Registry client, remote registry fetch, automatic package installation, or runtime `npx` download. Built-in adapters are pinned dependencies; operators install custom ACP servers themselves.
- No Telegram approval UI, unsolicited completion message, or direct Telegram access for external agents. Goblin remains the only ACP operator and learns results through the existing external-agent tool lifecycle.
- No raw command, terminal id, keystroke, cwd, environment, ACP session id, mode, or config option is exposed through the model-facing tool. ACP v1 terminal hosting does not add arbitrary terminal-input forwarding.
- No arbitrary environment overrides for custom ACP servers. All server and terminal children receive the existing sanitized environment; agent authentication remains in user-scoped credential stores.
- No preservation or adoption of ACP-hosted terminal children across Goblin restart. Active terminals are local resources and are killed when their ACP run disconnects. Legacy `agent-pty` access exists only to clean exactly owner-scoped records created by the old implementation; it cannot start, inspect, or adopt work.
- No replacement or generalization of `SubagentRunner`, and no recursive external-agent tool for pi subagents.
- No worktree creation, merge, commit, push, pull-request, provider account, or model-selection policy beyond ACP modes/config options explicitly trusted in deployment configuration.
