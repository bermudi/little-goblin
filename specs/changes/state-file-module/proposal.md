# State File Module

## Motivation

Three session modules each re-implement the same read→parse→ENOENT/Syntax→default→atomicWrite recipe:

- `src/sessions/state.ts` — `loadState` (`state.ts:11-26`) + `saveState` (`state.ts:31-33`).
- `src/sessions/bindings.ts` — `loadBindings` (`bindings.ts:20-35`) + `saveBindings` (`bindings.ts:41-43`).
- `src/sessions/topic-settings.ts` — `loadTopicSettings` (`topic-settings.ts:35-46`) + `saveTopicSettings` (`topic-settings.ts:51-53`), plus genuine locator-keyed slot logic that earns its keep.

The atomic-write policy is the load-bearing part — and it is triplicated, so a policy change means three edits.

Note: `src/memory/store.ts` was identified in the architecture review as a fourth duplicate, but verification shows it does not share this recipe — it reads/writes Markdown (`memory.md` with frontmatter), not JSON, so its `readRaw` (`store.ts:323-331`) does `readFileSync → ENOENT → ""` without `JSON.parse`. It shares the `atomicWrite` primitive on the write side (as all four already do via `src/fs.ts`), but it is not a JSON-state consumer and is out of scope for the JSON state-file module.

## Scope

Affected capabilities: `sessions` and `memory`.

This change introduces:

- A deep `state-file` module that absorbs the JSON format, atomicity, and error policy behind a two-function interface: `loadJsonFile<T>(path, default)` and `saveJsonFile(path, value)`. The module wraps the existing `atomicWrite` primitive from `src/fs.ts` (already shared by all three callers) and adds the read side — `readFileSync → JSON.parse → ENOENT/SyntaxError → caller-supplied default; everything else propagates per the fail-loud rule`. It does not replace `atomicWrite`.
- Migration of `sessions/state.ts`, `sessions/bindings.ts`, and `sessions/topic-settings.ts` to consume the new module. Each caller keeps its own default value and its own type; only the recipe is shared.
- The locator-keyed slot logic in `topic-settings.ts` stays in place — that part is genuine and is not duplicated.

## Non-Goals

- No change to file paths, file formats, or on-disk schemas. Each state file keeps its shape; only the read/write recipe is consolidated.
- No change to the atomic-write policy itself (tmp + rename, fail loud on non-ENOENT). The new module encodes the existing policy, it does not redefine it.
- No change to memory's git-backing, quarantine paths, or `memory/store.ts`. The memory store reads/writes Markdown, not JSON, and is not a consumer of `loadJsonFile`. (It does share the `atomicWrite` primitive, as everything else does via `src/fs.ts` — that is unchanged.)
- No new state files; no migration of existing files.
- Not pulling in `schedules.json` (already covered by its own store), `events.jsonl`, or `transcript.jsonl` — those are JSONL/append-only and out of scope for the JSON-state recipe.
