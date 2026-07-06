# State File Module

## Motivation

Three session modules each re-implement the same read→parse→ENOENT/Syntax→default→atomicWrite recipe:

- `src/sessions/state.ts` — `load` (`state.ts:11-26`) + `save` (`state.ts:31-33`), ~22 LOC.
- `src/sessions/bindings.ts` — `load` (`bindings.ts:20-35`) + `save` (`bindings.ts:41-43`), ~23 LOC including default.
- `src/sessions/topic-settings.ts` — `load` (`topic-settings.ts:35-46`) + `save` (`topic-settings.ts:51-53`), ~17 LOC of the boilerplate, plus genuine locator-keyed slot logic that earns its keep.

The atomic-write policy is the load-bearing part — and it is triplicated, so a policy change means three edits. The same pattern is also inlined a fourth time in `src/memory/store.ts` (`readRaw`/`write`, `store.ts:323-346`). The architecture review's claim that `store.ts` "does this right" is misleading: it duplicates the recipe too, just privately.

## Scope

Affected capabilities: `sessions` and `memory`.

This change introduces:

- A deep `state-file` module that absorbs the JSON format, atomicity, and error policy behind a two-function interface: `loadJsonFile<T>(path, default)` and `saveJsonFile(path, value)`. The module wraps the existing `atomicWrite` primitive from `src/fs.ts` (already shared by all four callers) and adds the read side — `readFileSync → JSON.parse → ENOENT/SyntaxError → caller-supplied default; everything else propagates per the fail-loud rule`. It does not replace `atomicWrite`.
- Migration of `sessions/state.ts`, `sessions/bindings.ts`, `sessions/topic-settings.ts`, and `memory/store.ts`'s private read/write to consume the new module. Each caller keeps its own default value and its own type; only the recipe is shared.
- The locator-keyed slot logic in `topic-settings.ts` stays in place — that part is genuine and is not duplicated.

## Non-Goals

- No change to file paths, file formats, or on-disk schemas. Each state file keeps its shape; only the read/write recipe is consolidated.
- No change to the atomic-write policy itself (tmp + rename, fail loud on non-ENOENT). The new module encodes the existing policy, it does not redefine it.
- No change to memory's git-backing or quarantine paths.
- No new state files; no migration of existing files.
- Not pulling in `schedules.json` (already covered by its own store), `events.jsonl`, or `transcript.jsonl` — those are JSONL/append-only and out of scope for the JSON-state recipe.
