# deployment

## ADDED Requirements

### Requirement: Provide a systemd service unit

The system SHALL ship a systemd service unit file that runs Goblin as a single persistent process under a dedicated `goblin` user with `GOBLIN_HOME=/var/lib/goblin`.

#### Scenario: Service unit contents

- **WHEN** `scripts/goblin.service` is inspected
- **THEN** it SHALL declare `Type=simple`, `User=goblin`, `Group=goblin`, `WorkingDirectory=<repo>`, `Environment="GOBLIN_HOME=/var/lib/goblin"`, `ExecStart=bun run src/index.ts`, and `Restart=on-failure`

#### Scenario: Service logs to journal

- **WHEN** the service is running
- **THEN** `log.ts` output SHALL be captured by `systemd-journald` and visible via `journalctl -u goblin`

### Requirement: Install and enable the systemd service

The system SHALL provide `scripts/install-service.sh` that installs the unit file into `/etc/systemd/system/`, reloads systemd, enables the service, and optionally starts it.

#### Scenario: Idempotent install

- **WHEN** `scripts/install-service.sh` is run twice
- **THEN** it SHALL complete without error both times and leave the unit file current

#### Scenario: Requires root

- **WHEN** `scripts/install-service.sh` is run as a non-root user
- **THEN** it SHALL exit with a clear error message indicating root is required

### Requirement: Provide an end-to-end install script

The system SHALL provide `scripts/install.sh` that idempotently prepares a host for production: checks for `bun`, creates the `goblin` user and `/var/lib/goblin`, ensures the repo is present, installs dependencies, runs the onboard wizard if `goblin.json5` is missing, installs the service, and starts it.

#### Scenario: Fresh install on a clean machine

- **WHEN** `scripts/install.sh` is run on a machine with no `goblin` user, no `/var/lib/goblin`, and no existing config
- **THEN** it SHALL create the user, directory, and repo, run `bun install`, run `bun run onboard`, install the service, and start the bot

#### Scenario: Re-run on an already-installed machine

- **WHEN** `scripts/install.sh` is run again after a successful install
- **THEN** it SHALL skip user creation, skip onboarding if `goblin.json5` exists, re-install the service unit, and restart the service only if the code changed

#### Scenario: Run without root

- **WHEN** `scripts/install.sh` is run without root privileges
- **THEN** it SHALL exit early with a clear error message

### Requirement: Provide a backup script

The system SHALL provide `scripts/backup.sh` that creates a timestamped archive of `$GOBLIN_HOME`, excluding directories that do not need to be preserved.

#### Scenario: Backup includes state and workspace, excludes scratch and caches

- **WHEN** `scripts/backup.sh` is run
- **THEN** it SHALL produce a timestamped archive in `$GOBLIN_HOME/backups/` containing `workspace/`, `state/`, and `goblin.json5`
- **AND** it SHALL exclude `scratch/`, `node_modules/`, `.git/` trees, and any `*.tmp` files

#### Scenario: Safe to run while service is active

- **WHEN** `scripts/backup.sh` is run while the goblin service is running
- **THEN** it SHALL complete without corrupting live state because all writes use atomic rename

### Requirement: Provide an update script

The system SHALL provide `scripts/update.sh` that safely updates the running deployment: pulls the latest code, installs dependencies, runs the typecheck, runs the preflight check, and restarts the service.

#### Scenario: Successful update

- **WHEN** `scripts/update.sh` is run and all checks pass
- **THEN** it SHALL restart the systemd service and report success

#### Scenario: Failing check blocks restart

- **WHEN** `scripts/update.sh` is run and the preflight check or typecheck fails
- **THEN** it SHALL exit before restarting the service and leave the currently running instance untouched

#### Scenario: Requires root

- **WHEN** `scripts/update.sh` is run as a non-root user
- **THEN** it SHALL exit with a clear error message indicating root is required

### Requirement: Expose packaging scripts via npm aliases

The system SHALL expose the packaging scripts through `package.json` so they are discoverable without memorizing file paths.

#### Scenario: package.json scripts

- **WHEN** `package.json` is inspected
- **THEN** it SHALL contain `scripts` entries for `validate-config`, `install-service`, and `backup`
