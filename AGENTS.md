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
- **No `console.log`.** Use `log` from `src/log.ts` — JSONL on stdout and
  appended to `$GOBLIN_HOME/state/goblin.log`. The bar: a screenshot of
  weird behavior plus the log file must fully reconstruct what the process
  did. Every external boundary emits a line with the fields to explain it
  — intake (update → conversation address), delivery (send →
  chat/thread), model calls, tool calls — plus critical state mutations
  and error paths. If explaining a symptom needs a REPL or a guess, the
  logging is insufficient: add the line.
- **One module, one job.** Flat modules, colocated tests (`foo.ts` /
  `foo.test.ts`). `bun test` to run, `tsc --noEmit` before committing.
- **Only `src/tg/` knows grammy.** Domain modules never see a Telegram
  context object.

## Scope discipline

The non-goals list in `DESIGN.md` is load-bearing. Do not add subagents,
skills, MCP, projects, or inner-life machinery without an explicit ask —
"it would be nice" is how v1 happened. When a dropped capability returns, it
gets designed into `DESIGN.md` first.

## Design inspiration

When designing workspace layout, identity/memory files, prompt assembly, or
scheduled work: two mature agents live locally and already paid for these
lessons — `~/build/testing/openclaw/` (TypeScript, multi-channel) and
`~/build/testing/hermes-agent/` (Python, Nous Research). Borrow their
*mechanisms*, never their scope: both carry 10x goblin's feature list, most
of it on our non-goals list. Worth stealing outright: openclaw's bootstrap
file protocol (trigger→file memory rules, supersede-in-place directives) and
its HEARTBEAT.md post-mortem (a scheduled job's instructions are the job's
state in the DB, never a shared workspace file); hermes' cache discipline
("per-conversation prompt caching is sacred" — both projects converged on
this independently, treat it as settled). Consult their AGENTS.md, docs/
and templates before designing; cite what you took in `DESIGN.md`.

## Tests

Tests guard boundaries and invariants, not implementations. Fake the model
provider and the Telegram API at the edge; don't mock module internals. The
suite stays smaller than `src/`.

## Process

No Litespec, no specs tree, no decision records. Small commits, often, on
main or short-lived branches. If a design tension is real enough to argue
about, write the ruling into `DESIGN.md` — the doc is the spec.
