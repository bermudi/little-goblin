## Architecture

A new `src/pi-host.ts` module becomes the single source of truth for constructing pi's infrastructure services and the canonical home for pi-related filesystem paths. Both `AgentRunner` and `SubagentRunner` import from it, eliminating the cross-module import from `subagents/` into `agent/paths.ts`.

```
Before:
  src/agent/paths.ts   ← defines pi paths
  src/agent/mod.ts      ← builds pi services inline, imports paths locally
  src/subagents/mod.ts  ← builds pi services inline, imports paths from ../agent/paths.ts

After:
  src/pi-host.ts        ← defines pi paths + createPiServices()
  src/agent/mod.ts      ← imports createPiServices + paths from ../pi-host.ts
  src/subagents/mod.ts  ← imports createPiServices + paths from ../pi-host.ts
  src/agent/paths.ts    ← deleted (functions moved to pi-host.ts)
```

The module is a thin stateless factory — no caching, no lifecycle, no dependency on agent or subagent modules.

## Decisions

### Pi-host is stateless — no internal caching

`createPiServices(home)` returns new service instances on every call. Caching is the caller's responsibility (SubagentRunner already lazily caches via `getPiServices()`; AgentRunner has no reuse concern since it creates once in `init()`).

**Why:** Stateless factories compose cleanly. If a future caller needs a fresh auth read mid-process, they can call `createPiServices()` without worrying about stale cached state. The existing caching patterns in callers are already correct and don't need to move into the factory.

**Alternative considered:** Make `createPiServices` cache by `home` key. Rejected because callers already manage their own caching appropriately, and adding a module-level cache introduces a hidden global that complicates testing (would need cache invalidation).

### agent/paths.ts is deleted, not preserved as a re-export barrel

Only two production files import from `agent/paths.ts`: `agent/mod.ts` and `subagents/mod.ts`. Both will be updated to import from `pi-host.ts`. One test file (`agent/paths.test.ts`) is moved to `pi-host.test.ts`.

**Why:** A re-export barrel adds indirection without value. The number of importers is small and known. Deleting the old file makes the migration verifiable — any missed importer fails at compile time.

**Alternative considered:** Keep `agent/paths.ts` as a re-export to avoid touching callers. Rejected because it leaves a zombie file that future developers may import from either location.

### SettingsManager stays in-memory with empty defaults

Both callers currently use `SettingsManager.inMemory({})`. This doesn't change. If persistent settings are needed later, the change is a single-site edit in `createPiServices()`.

## File Changes

### Create: `src/pi-host.ts`

New module. Exports:
- `PiServices` — named type for the return value of `createPiServices`
- `createPiServices(home: string): PiServices` — constructs the pi service trio with paths under `$GOBLIN_HOME/pi-agent/`
- `workdirPath(home: string): string` — `join(home, "workdir")` (moved from agent/paths.ts)
- `piAgentDir(home: string): string` — `join(home, "pi-agent")` (moved from agent/paths.ts)
- `agentsMdPath(home: string): string` — `join(home, "AGENTS.md")` (moved from agent/paths.ts; a goblin path colocated in pi-host for convenience — not a pi concern)

Satisfies: "Pi-host module provides shared pi service construction", "Pi-host module exports pi filesystem path helpers"

### Create: `src/pi-host.test.ts`

Moved from `src/agent/paths.test.ts`. Tests the three path helpers. No new tests needed for `createPiServices()` — its correctness is verified by existing AgentRunner and SubagentRunner integration tests that already assert correct service paths.

### Modify: `src/agent/mod.ts`

- Replace `import { agentsMdPath, piAgentDir, workdirPath } from "./paths.ts"` with `import { workdirPath, createPiServices } from "../pi-host.ts"` (only the exports actually needed after removing the dead AGENTS.md read)
- Replace inline AuthStorage + ModelRegistry + SettingsManager construction with:
  ```ts
  const { authStorage, modelRegistry, settingsManager } = createPiServices(home);
  authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);
  ```
- The `setRuntimeApiKey` call stays in AgentRunner (it depends on resolved model, not pi infrastructure).

Satisfies: "Shared services point at $GOBLIN_HOME/pi-agent/" (specs/agent), "cwd is the shared goblin workspace" (specs/agent)

Also: delete the dead `readFileSync(agentsMdPath(...))` call in `init()` and its try/catch. The AGENTS.md read is a pre-existing dead code path (content is read but never passed to pi). Removing it here since the path import is already being touched. If AGENTS.md wiring is desired, it belongs in a separate change.

### Modify: `src/subagents/mod.ts`

- Replace `import { piAgentDir, workdirPath } from "../agent/paths.ts"` with `import { createPiServices, piAgentDir, workdirPath } from "../pi-host.ts"`
- Replace the body of `getPiServices()` to call `createPiServices(this.cfg.goblinHome)` instead of constructing the trio inline.
- Replace the private `SharedServices` interface with `PiServices` imported from `../pi-host.ts` for the `this.services` caching field.
- `setRuntimeApiKey()` stays in `_runAgentInner()` (unchanged — it's already there, called after `resolveModel()`). Only the service *construction* inside `getPiServices()` is replaced with `createPiServices()`.

Satisfies: "SubagentRunner manages subagent lifecycle"

### Delete: `src/agent/paths.ts`

Functions moved to `src/pi-host.ts`. All importers updated.

### Delete: `src/agent/paths.test.ts`

Moved to `src/pi-host.test.ts`.
