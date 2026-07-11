# production-packaging — Design

## Architecture

The change wraps the existing runtime with host-level packaging. No core runtime behavior is altered; the bot still starts via `src/index.ts` and uses `loadConfig()`, `ensureGoblinHome()`, and the existing `SessionManager`.

```
┌─────────────────────────────────────────┐
│  systemd / systemctl start goblin       │
│  User=goblin, GOBLIN_HOME=/var/lib/goblin│
└─────────────────┬───────────────────────┘
                  │ ExecStart=bun run src/index.ts
                  ▼
┌─────────────────────────────────────────┐
│  src/index.ts                           │
│  loadConfig() → preflight() → buildBot() │
│  ensureGoblinHome()                     │
└─────────────────────────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
validate-config  backup.sh    update.sh
(bun run)       (cron or     (manual)
                 manual)
```

The new pieces are:

- `src/preflight.ts` — a pure startup check module. It is called from `src/index.ts` after `loadConfig()` and `ensureGoblinHome()` but before `buildBot()`.
- `src/validate-config.ts` — a thin CLI entry point that runs `loadConfig()` + `preflight()` and exits with a go/no-go report.
- `scripts/goblin.service` — a systemd unit file committed in the repo.
- `scripts/install-service.sh` — installs the unit file, reloads systemd, enables/starts the service.
- `scripts/install.sh` — full host preparation script.
- `scripts/backup.sh` — archives `$GOBLIN_HOME`.
- `scripts/update.sh` — pull, install, check, restart.
- `package.json` — adds npm aliases for the new scripts.

## Decisions

### Dedicated `goblin` system user with `/var/lib/goblin`

Chosen over a user service because the install script is meant to be a one-command, root-run setup on a homelab server. A dedicated user isolates the bot from the operator's home directory and makes file ownership predictable. The install script creates the user with a disabled password and no shell.

Trade-off: root is required for install and update. This is acceptable for a single-admin homelab.

### Systemd journal as the log sink

`log.ts` already writes newline-delimited JSON to stdout/stderr. Under systemd, these streams are captured by the journal without code changes. The install script will document `journalctl -u goblin -f`.

Trade-off: log retention is governed by journald configuration, not by the application. This matches the homelab simplicity goal.

### Preflight is a startup gate, not a sidecar

`src/preflight.ts` runs synchronously inside the main process before polling starts. If any critical check fails, the process exits with a clear message. This gives fail-fast behavior on bad installs.

The same module is reused by `bun run validate-config` so the operator can check the configuration without starting the bot.

### Persistence check uses the real atomic-write helper

The preflight check calls the existing `atomicWrite()` from `src/fs.ts` to write a probe file under `state/`, then reads it back and deletes it. This proves the same code path used for bindings and session state works.

### Backup excludes scratch and node_modules

`scratch/` is ephemeral by design. `node_modules/` and `.git/` can be rebuilt or recloned. The backup archive includes `workspace/`, `state/`, and `goblin.json5`.

### Update script stops on failure

`scripts/update.sh` performs the typecheck and preflight before restarting the service. If either fails, the currently running instance remains untouched. This prevents a bad deploy from leaving the bot down.

## File Changes

### New files

- `src/preflight.ts` — Implements the startup check. Exports `runPreflight(cfg): void` that validates credentials, filesystem writability, atomic writes, and optional capabilities. Uses `resolveModel()` from `src/agent/models.ts` to map the selected model to its required API key. Uses `atomicWrite()` from `src/fs.ts` for the persistence probe.
- `src/validate-config.ts` — CLI entry point. Loads config, calls `runPreflight()`, and prints a summary. Exits 0 on success, non-zero on failure.
- `scripts/goblin.service` — Systemd unit file. Uses `User=goblin`, `Group=goblin`, `WorkingDirectory=/opt/little-goblin`, `Environment=GOBLIN_HOME=/var/lib/goblin`, `ExecStart=/usr/local/bin/bun run src/index.ts`, `Restart=on-failure`, `RestartSec=5`.
- `scripts/install-service.sh` — Copies `scripts/goblin.service` to `/etc/systemd/system/goblin.service`, runs `systemctl daemon-reload`, enables the service, and starts it if requested.
- `scripts/install.sh` — Idempotent host install script. Checks for root, checks/installs `bun`, creates `goblin` user and `/var/lib/goblin`, clones/updates the repo to `/opt/little-goblin`, runs `bun install`, runs `bun run onboard` if no config exists, runs `bun run validate-config`, installs the service, and starts it.
- `scripts/backup.sh` — Creates `$GOBLIN_HOME/backups/goblin-home-<timestamp>.tar.gz` with `workspace/`, `state/`, and `goblin.json5`, excluding `scratch/`, `node_modules/`, `.git/`, and `*.tmp`.
- `scripts/update.sh` — Pulls code, runs `bun install`, runs `bun run typecheck`, runs `bun run validate-config`, and restarts the `goblin` service. Exits on any failure before the restart.

### Modified files

- `src/index.ts` — After `loadConfig()` and `ensureGoblinHome()`, call `runPreflight(cfg)` before `buildBot()`.
- `package.json` — Add `validate-config`, `install-service`, and `backup` scripts. Update `description` if needed; no dependency changes.

### Unchanged files

- `src/config.ts` — No changes; `loadConfig()` and `ensureGoblinHome()` are reused as-is.
- `src/onboard.ts` — No changes; the install script invokes it.
- `src/log.ts` — No changes; systemd journal captures stdout/stderr.
- `src/fs.ts` — No changes; the persistence check uses `atomicWrite()`.
- `src/agent/poe-validate.ts` — No changes; the preflight may call `validateModelAtStartup` optionally, but the existing startup already does this.

## Integration Points

- `src/preflight.ts` imports `Config` from `src/config.ts`, `resolveModel` from `src/agent/models.ts`, and `atomicWrite` from `src/fs.ts`.
- `src/index.ts` imports `runPreflight` from `src/preflight.ts`.
- `src/validate-config.ts` imports `loadConfig` from `src/config.ts` and `runPreflight` from `src/preflight.ts`.
- The scripts are self-contained bash and do not import TypeScript modules.
