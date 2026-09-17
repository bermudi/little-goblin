# goblin v2

Telegram-native personal AI agent for one operator. Rewrite of
`~/build/little-goblin` on the Vercel AI SDK. Read `DESIGN.md` before any
structural work — it owns the domain model, the authority rule, and the
non-goals list.

## Guardrails

- **Bun + strict TypeScript.** No `any` — `unknown` and narrow. Validate
  external input with zod at boundaries (config, Telegram updates, tool args,
  disk state).
- **Fail loud.** `ENOENT` means null. Everything else propagates with context.
  Never swallow an exception.
- **Durable writes.** Whole-file state: tmp + `fsync` + `renameSync`,
  preserving the existing file's mode. Append-only JSONL: one serialized
  record per write, failures propagate.
- **No `console.log`.** Use `log` from `src/log.ts`. Every external boundary,
  critical state mutation, and error path emits a structured log line.
- **One module, one job.** Flat modules, colocated tests (`foo.ts` /
  `foo.test.ts`). `bun test` to run, `tsc --noEmit` before committing.
- **Only `src/tg/` knows grammy.** Domain modules never see a Telegram
  context object.

## Scope discipline

The non-goals list in `DESIGN.md` is load-bearing. Do not add subagents,
skills, MCP, projects, or inner-life machinery without an explicit ask —
"it would be nice" is how v1 happened. When a dropped capability returns, it
gets designed into `DESIGN.md` first.

## Tests

Tests guard boundaries and invariants, not implementations. Fake the model
provider and the Telegram API at the edge; don't mock module internals. The
suite stays smaller than `src/`.

## Process

No Litespec, no specs tree, no decision records. Small commits, often, on
main or short-lived branches. If a design tension is real enough to argue
about, write the ruling into `DESIGN.md` — the doc is the spec.
