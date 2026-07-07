# production-packaging — Tasks

## Phase 1: Add startup preflight and config validator

- [x] Create `src/preflight.ts` with `runPreflight(cfg)` that:
  - validates `goblin.json5` loaded correctly (already done by `loadConfig`),
  - checks the selected model's required API key is resolvable via `resolveModel()`,
  - verifies `workspace/`, `state/`, and `scratch/` are writable,
  - writes/reads/deletes a probe file via `atomicWrite()` in `state/`,
  - checks Edge TTS availability when `voiceName` is configured (warn only),
  - checks Groq ASR availability when `groqApiKey` is configured (warn only),
  - fails fast with a clear error on critical checks.
- [x] Create `src/validate-config.ts` CLI entry point that loads config and calls `runPreflight()`, then prints go/no-go and exits accordingly.
- [x] Wire `runPreflight(cfg)` into `src/index.ts` after `ensureGoblinHome(cfg)` and before `buildBot(cfg)`.
- [x] Add `validate-config` script to `package.json`.
- [x] Add `src/preflight.test.ts` covering:
  - happy path with writable directories and good atomic write,
  - failure when state directory is read-only,
  - failure when model API key is missing,
  - warning-only when Edge TTS is missing.
- [x] Run `bun run typecheck` and `bun test`.
- [x] Commit: `production-packaging: phase 1 — preflight and validate-config`.

## Phase 2: Add systemd service and installer helper

- [x] Create `scripts/goblin.service` with `User=goblin`, `Group=goblin`, `WorkingDirectory=/opt/little-goblin`, `Environment=GOBLIN_HOME=/var/lib/goblin`, `ExecStart=/usr/local/bin/bun run src/index.ts`, `Restart=on-failure`, `RestartSec=5`, and `StandardOutput=journal`/`StandardError=journal`.
- [x] Create `scripts/install-service.sh` that:
  - requires root,
  - copies `scripts/goblin.service` to `/etc/systemd/system/goblin.service`,
  - runs `systemctl daemon-reload`,
  - enables the service,
  - optionally starts it via `--start` flag.
- [x] Add `install-service` script to `package.json` pointing at `scripts/install-service.sh`.
- [x] Run `bun run typecheck`.
- [x] Commit: `production-packaging: phase 2 — systemd service and installer helper`.

## Phase 3: Add end-to-end install script

- [x] Create `scripts/install.sh` that:
  - requires root and a Linux environment,
  - checks for `bun` and installs it via the official install script if missing,
  - creates the `goblin` system user with disabled login and home `/var/lib/goblin`,
  - ensures `/var/lib/goblin` exists and is owned by `goblin:goblin`,
  - clones or updates the repo at `/opt/little-goblin`,
  - runs `bun install` in `/opt/little-goblin`,
  - runs `bun run onboard` if `/var/lib/goblin/goblin.json5` does not exist,
  - runs `bun run validate-config` to verify the setup,
  - installs and starts the systemd service.
- [x] Add `install` script to `package.json` pointing at `scripts/install.sh` (or leave it as a documented manual step to avoid accidental root invocation from npm).
- [x] Run `bun run typecheck`.
- [x] Commit: `production-packaging: phase 3 — install script`.

## Phase 4: Add backup and update scripts

- [x] Create `scripts/backup.sh` that:
  - requires the `goblin` user or root,
  - creates `$GOBLIN_HOME/backups/` if missing,
  - writes `$GOBLIN_HOME/backups/goblin-home-<timestamp>.tar.gz`,
  - includes `workspace/`, `state/`, and `goblin.json5`,
  - excludes `scratch/`, `node_modules/`, `.git/`, and `*.tmp`.
- [x] Create `scripts/update.sh` that:
  - requires root,
  - pulls the latest code in `/opt/little-goblin`,
  - runs `bun install`,
  - runs `bun run typecheck`,
  - runs `bun run validate-config`,
  - restarts the `goblin` service on success,
  - exits before restart if any check fails.
- [x] Add `backup` script to `package.json`.
- [x] Add `update` script to `package.json` pointing at `scripts/update.sh` (or leave it as a documented manual step).
- [x] Run `bun run typecheck`.
- [x] Commit: `production-packaging: phase 4 — backup and update scripts`.

## Phase 5: Verify and document

- [ ] Run `bun run typecheck` and `bun test` across the whole repo.
- [ ] Run `bun run validate-config` with the current `.env`/config setup and confirm behavior.
- [ ] Inspect generated scripts for shellcheck-level issues (no obvious quoting or permission bugs).
- [ ] Update `README.md` or `AGENTS.md` with a short "Production install" section describing `scripts/install.sh`, `systemctl start goblin`, `journalctl -u goblin`, `scripts/backup.sh`, and `scripts/update.sh`.
- [ ] Commit: `production-packaging: phase 5 — verification and docs`.
