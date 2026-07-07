# State File Module Design

## Architecture

Three session modules each inline the same recipe:

```
╭────────────╮ readFileSync → JSON.parse    ╭────────────╮ readFileSync → JSON.parse
│ state.ts   │ ENOENT/Syntax → null default │ bindings.ts│ ENOENT/Syntax → structuredClone(DEFAULT)
╰────────────╯ atomicWrite(path, json)      ╰────────────╯ atomicWrite(path, json)

╭──────────────────╮ readFileSync → JSON.parse
│ topic-settings.ts│ ENOENT/Syntax → structuredClone(DEFAULT) + slot logic (genuine)
╰──────────────────╯ atomicWrite(path, json)
```

After this change one module owns the recipe; each caller supplies its default and type:

```
╭────────────╮                ╭─────────────────╮                ╭────────────╮
│ state.ts   │─ loadJsonFile ▶│ state-file.ts   │◀ saveJsonFile ─│ bindings.ts│
│            │  (null def)    │  generic <T>    │  (DEFAULT)     ╰────────────╯
╰────────────╯                │  ENOENT→def     │                ╭──────────────────╮
                              │  Syntax→def+log │◀ saveJsonFile ─│ topic-settings.ts│
                              │  else→throw     │  (DEFAULT)     │  + slot logic    │
                              │  save→atomicWrite╰────────────────╯ ╰──────────────────╯
```

### Why `memory/store.ts` is NOT a consumer

Verification (this change's proposal was corrected during planning): `memory/store.ts`'s `readRaw` (`store.ts:323-331`) reads `memory.md` as Markdown — it does `readFileSync → ENOENT → ""` and never calls `JSON.parse`. Its `write` (`store.ts:344-346`) uses `atomicWrite` directly on a Markdown string. Including it as a `loadJsonFile` consumer would be wrong: it is not JSON. It shares the `atomicWrite` primitive (as all file writers in the codebase do via `src/fs.ts`) but not the JSON recipe. It is out of scope.

## Decisions

### D1. Module at `src/sessions/state-file.ts`

**Chosen:** a dedicated module under `src/sessions/` (where all three consumers already live).

**Why:** all three callers are in `src/sessions/`; the module is a sessions-layer concern. A higher-level `src/fs/` or `src/state/` location would over-promote a two-function helper and create a longer import path for no benefit.

**Rejected:** putting it in `src/fs.ts` alongside `atomicWrite`. That file is a low-level fs primitive; the read recipe (with the JSON.parse + default policy) is a higher-level concern and does not belong next to bare `atomicWrite`.

Specs: `JSON state files load and save through one module`.

### D2. Generic interface with caller-supplied default

**Chosen:**
```ts
function loadJsonFile<T>(path: string, defaultValue: T): T
function saveJsonFile(path: string, value: unknown): void
```

**Why:** the three callers have different result types (`SessionState | null`, `BindingsFile`, `TopicSettingsFile`) and different defaults (`null`, `structuredClone(DEFAULT_BINDINGS)`, `structuredClone(DEFAULT_SETTINGS)`). The module must not hardcode any of these; each caller supplies its own.

**Constraint:** `loadJsonFile` returns `T`, so a caller wanting `SessionState | null` calls `loadJsonFile<SessionState | null>(path, null)`. The generic does not force a non-null type.

Specs: `JSON state files load and save through one module` (the "SHALL NOT hardcode defaults" clause).

### D3. Error policy: ENOENT and Syntax → default + log; everything else throws

**Chosen:** match the `state.ts`/`bindings.ts` policy. `ENOENT` → default silently (expected — file not created yet). `SyntaxError` → log a warning with path + error, return default (recover gracefully from corruption). All other errors propagate (fail loud).

**Why:** this is what `state.ts` and `bindings.ts` do today, and it matches the fail-loud rule in `AGENTS.md`. `topic-settings.ts` is the outlier: its current `catch (e)` at `topic-settings.ts:35-46` does **not** discriminate `SyntaxError` and swallows all errors (disk, permission, anything) into the default. The new module rethrows non-`ENOENT`/non-`SyntaxError` errors, so `topic-settings.ts` will start propagating where it currently swallows. This is a deliberate alignment, not an accidental regression — see the Non-Goals in `proposal.md` where it is called out.

**Note:** `state.ts` logs `"malformed session state, treating as missing"`, `bindings.ts` logs `"malformed bindings.json, returning default"`, `topic-settings.ts` logs `"malformed topic-settings.json, returning default"`. The module uses a single generic message (e.g. `"malformed JSON state file, returning default"`); the per-file specificity is lost but the path is included, which is the load-bearing diagnostic.

Specs: `Load returns default on ENOENT`, `Load returns default on malformed JSON and logs`, `Load propagates non-ENOENT, non-Syntax errors`.

### D4. Save serializes as `JSON.stringify(value, null, 2) + "\n"`

**Chosen:** match the existing serialization all three callers use.

**Why:** `state.ts:32`, `bindings.ts:42`, and `topic-settings.ts:52` all call `atomicWrite(path, JSON.stringify(value, null, 2) + "\n")`. Centralizing must not change the on-disk format.

Specs: `Save writes atomically`.

## File Changes

### `src/sessions/state-file.ts` (new)

The deep module. Exports `loadJsonFile<T>(path, defaultValue)` and `saveJsonFile(path, value)`. Wraps `atomicWrite` from `src/fs.ts` on the write side; implements the read recipe on the read side.

Covers `JSON state files load and save through one module`.

### `src/sessions/state-file.test.ts` (new)

Tests: load returns parsed JSON when file exists; load returns default on ENOENT; load returns default and logs on SyntaxError; non-ENOENT/non-Syntax errors propagate; save writes via `atomicWrite` and produces `JSON.stringify(v, null, 2) + "\n"`.

Covers all five scenarios under `JSON state files load and save through one module`.

### `src/sessions/state.ts` (modified)

`loadState` becomes `return loadJsonFile<SessionState | null>(statePath(home, id), null);` — the try/catch recipe is deleted. `saveState` becomes `saveJsonFile(statePath(home, state.id), state);`.

Covers modified `Persist session state atomically`.

### `src/sessions/bindings.ts` (modified)

`loadBindings` becomes `return loadJsonFile(pathFor(home), structuredClone(DEFAULT_BINDINGS));` — the try/catch recipe is deleted. `saveBindings` becomes `saveJsonFile(pathFor(home), bindings);`.

Covers modified `Persist bindings atomically`.

### `src/sessions/topic-settings.ts` (modified)

`loadTopicSettings` becomes `return loadJsonFile(topicSettingsPath(home), structuredClone(DEFAULT_SETTINGS));` — the try/catch recipe is deleted. `saveTopicSettings` becomes `saveJsonFile(topicSettingsPath(home), settings);`. The locator-keyed slot logic (`getProjectDir`, slot read/write) stays unchanged.

**Behavior change:** the current `loadTopicSettings` catches all errors and returns the default. After migration, non-`ENOENT`/non-`SyntaxError` errors propagate (fail loud), matching `state.ts`/`bindings.ts`. Called out in proposal Non-Goals and D3.

Covers modified `Topic settings file`.
