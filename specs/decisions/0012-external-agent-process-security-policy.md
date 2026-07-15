# External Agent Process Security Policy

## Status

proposed

## Context

External coding agents are spawned as child processes with filesystem access and environment visibility. If they inherited Goblin's `process.env`, they would gain access to Telegram tokens, model provider API keys, and `GOBLIN_HOME` paths that are not part of the user's local CLI authentication. A malicious or mis-instructed coding agent could exfiltrate those secrets or edit files outside the intended project scope. The tool must therefore not expose model-controlled paths, executables, arguments, or environment overrides.

## Decision

External-agent child processes SHALL receive a code-owned, allowlisted environment map rather than `process.env`. The map SHALL contain only the following exact execution variables: `HOME`, `PATH`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_NUMERIC`, `LC_TIME`, `LC_COLLATE`, `LC_MONETARY`, `LC_MESSAGES`, `LC_PAPER`, `LC_NAME`, `LC_ADDRESS`, `LC_TELEPHONE`, `LC_MEASUREMENT`, `LC_IDENTIFICATION`, `TMPDIR`, `TERM`, `COLORTERM`, `SSL_CERT_FILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`. Any variable not in this exact list, including `GOBLIN_HOME`, Telegram tokens, Goblin provider keys, generic `*_API_KEY` variables, and `SSH_AUTH_SOCK`, SHALL be excluded.

The `external_agent` tool SHALL NOT accept a `cwd`, `executable`, CLI arguments, environment overrides, permission mode, `ownerSessionId`, `timeout`, or PTY actions. The current session's `projectDir` SHALL be the only working directory, supplied by the tool factory and required before `start` succeeds.

External-agent permission profiles SHALL be code-owned and limited to `read-only` and `workspace-write`. Each adapter SHALL map the profile to its backend-specific non-bypass arguments. There SHALL be no `dangerous` or approval-bypass profile.

`agent-pty` owner metadata is a namespacing field for Goblin lifecycle isolation, not authentication. The daemon SHALL continue to rely on Unix-socket access control: the socket and its parent directory SHALL be owned by the same OS user that runs the daemon and SHALL have restrictive permissions (for example, directory mode `0700` and socket mode `0600`) so only that user can connect. Environment-only API-key authentication for external CLIs is not supported; operators authenticate each CLI through its existing user-scoped credential stores.

### Same-user filesystem access

The external-agent child process runs as the same OS user that runs Goblin. The environment allowlist and `projectDir` binding prevent the model from directly requesting access to Goblin state or credential files, but they do not provide OS-level filesystem isolation: the child process can traverse the filesystem and read or write any file accessible to that user, including `$GOBLIN_HOME/state/`, `$GOBLIN_HOME/scratch/`, and CLI credential stores outside `projectDir`.

This is a stated residual risk, not a silent gap. Operators who require stronger isolation SHALL run Goblin and external-agent children under an OS-level sandbox (e.g. a separate user, container, or sandbox runtime that restricts traversal and absolute-path access to a `projectDir`-bounded subtree). The adapter-level `projectDir` confinement and permission profiles are defense-in-depth within the same-user trust boundary, not a substitute for OS-level isolation. A future change may add an optional sandbox-execution profile that enforces filesystem boundaries at the OS level; until then, the security guarantee is explicitly narrowed to "the model cannot request arbitrary paths or environments, and the child cannot read Goblin's process environment, but same-user filesystem access beyond `projectDir` is not restricted by Goblin itself."

## Consequences

- Easier: external agents cannot accidentally read Goblin's secrets from the parent environment.
- Easier: the model cannot request an arbitrary `cwd`, `executable`, or `env`, so the attack surface is bounded by the adapter implementations.
- Harder: operators must authenticate Codex, Claude, Devin, and other CLIs for the same OS user that runs Goblin.
- Harder: adapters must maintain a per-backend mapping from the two safe profiles to the correct CLI flags.
- Stated risk: same-user filesystem access beyond `projectDir` is not restricted by Goblin; operators requiring isolation must deploy an OS-level sandbox.
- Must change: every native adapter and the `AgentPtyAdapter` pass the exact sanitized environment map to the child process.
