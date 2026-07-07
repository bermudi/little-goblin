# production-packaging

## Motivation

Little Goblin is currently started manually with `bun run src/index.ts` and assumes the operator has already created `goblin.json5`, set up `GOBLIN_HOME`, and verified that the filesystem layout works. For a homelab deployment that should survive reboots and crashes, we need a repeatable, idempotent install path and a systemd-managed daemon with safe update and backup procedures.

## Scope

This change adds production packaging around the existing runtime:

1. **systemd service** — `scripts/goblin.service` and a `scripts/install-service.sh` helper that installs/enables it. The service runs the bot under a dedicated `goblin` system user with `GOBLIN_HOME=/var/lib/goblin`, auto-restarts on failure, and forwards logs to the systemd journal.

2. **install script** — `scripts/install.sh` idempotently prepares a host:
   - ensures `bun` is present,
   - creates the `goblin` user and `/var/lib/goblin`,
   - clones/updates the repo,
   - runs `bun install`,
   - runs `bun run onboard` when no `goblin.json5` exists,
   - installs and starts the systemd service.

3. **startup preflight / persistence check** — `src/preflight.ts` runs before the bot starts and verifies:
   - `goblin.json5` loads and validates,
   - selected model's required API key is resolvable,
   - `workspace/`, `state/`, and `scratch/` are writable,
   - atomic write + rename works in `state/`,
   - Telegram token is reachable via `getMe` (best-effort, does not block offline starts),
   - optional capabilities (Edge TTS, Groq ASR) are reachable when configured.
   Failures fail fast with clear messages before polling begins.

4. **config validation helper** — `bun run validate-config` calls the same preflight logic and prints a go/no-go report without starting the bot. This is useful for CI and post-install checks.

5. **backup script** — `scripts/backup.sh` creates a timestamped archive of `$GOBLIN_HOME`, excluding `scratch/`, `node_modules/`, and `.git` trees. It is safe to run while the service is running because the underlying state files use atomic writes.

6. **update script** — `scripts/update.sh` pulls the latest code, runs `bun install`, runs the typecheck, runs the preflight, and restarts the systemd service. It stops on any failure before replacing the running instance.

7. **package.json scripts** — add `validate-config`, `install-service`, and `backup` npm-style aliases so the scripts are discoverable.

## Non-Goals

- High availability / multi-instance deployment. This remains single-user, single-process, homelab.
- Docker, k8s, or containerized deployment.
- A web admin panel, webhook server, or external monitoring integration.
- Changing how sessions, memory, or state are stored. Packaging uses the existing `GOBLIN_HOME` layout unchanged.
- Migrating logs to a separate file or log-shipping pipeline. Systemd journal is the production log sink.
- Rewriting the interactive `onboard` wizard. It remains the primary first-time config path; the new pieces wrap it.
