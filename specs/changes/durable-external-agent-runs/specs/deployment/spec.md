# deployment

## ADDED Requirements

### Requirement: agent-pty daemon is supervised independently of Goblin

Deployments with `externalAgents.ptyFallback: true` SHALL run the `agent-pty` daemon as a systemd service separate from `goblin.service`. The companion service SHALL run as the same dedicated Goblin OS user, execute `agent-pty daemon` in the foreground, restart on failure, and own its own systemd control group. Goblin SHALL order startup after the companion service without making the companion service part of Goblin's lifecycle; restarting or stopping `goblin.service` MUST NOT stop or restart `agent-pty.service`.

The service installer SHALL install and enable the companion unit and a Goblin ordering dependency only when PTY fallback is enabled. Disabled installations SHALL retain the existing single-service deployment and SHALL NOT require an `agent-pty` executable.

#### Scenario: Goblin service restarts without PTY daemon

- **GIVEN** `agent-pty.service` and `goblin.service` are active
- **WHEN** `goblin.service` is restarted
- **THEN** systemd SHALL leave `agent-pty.service` and its PTY children running
- **AND** the new Goblin process MAY adopt matching sessions

#### Scenario: agent-pty failure is supervised

- **WHEN** the `agent-pty` daemon exits unexpectedly
- **THEN** systemd SHALL restart `agent-pty.service` according to its restart policy
- **AND** Goblin SHALL classify runs lost with the old daemon as `interrupted`
- **AND** it MUST NOT claim that those runs survived

#### Scenario: PTY-enabled install creates companion service

- **WHEN** the service installer runs against configuration with `ptyFallback: true`
- **THEN** it SHALL verify that a compatible `agent-pty` executable is installed
- **AND** install and enable `agent-pty.service`
- **AND** install ordering so `goblin.service` starts after the daemon is available

#### Scenario: PTY-disabled install remains unchanged

- **WHEN** the service installer runs against configuration with absent or false `ptyFallback`
- **THEN** it SHALL NOT install a Goblin dependency on `agent-pty.service`
- **AND** Goblin installation SHALL succeed without `agent-pty`

#### Scenario: Service logs are observable

- **WHEN** the companion daemon starts, accepts clients, or fails
- **THEN** its stdout and stderr SHALL be captured by journald
- **AND** operators SHALL be able to inspect it with `journalctl -u agent-pty`
