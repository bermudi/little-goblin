# goblin v2

Telegram-native personal AI agent for one operator. Rewrite of
`~/build/little-goblin` on the Vercel AI SDK. Read `DESIGN.md` (the
core: domain model, authority rule, cache stability, non-goals) plus the
`design/` file for the area you're touching before any structural work.
`docs/` is operator documentation, not spec.

## Guardrails

- **Bun + strict TypeScript.** No `any` — `unknown` and narrow. Validate
  external input with zod at boundaries (config, Telegram updates, tool args,
  disk state).
- **The mini app client is plain, checked JS.** `src/http/app.js` ships as
  served — no bundler, no framework, no build step (design rule, scoped to
  the mini app by DESIGN.md → App channel, 2026-09-30). It is type-checked
  (`bun run typecheck` runs the tsc programs) with wire types imported from
  `mod.ts`/`config.ts`, so config schema changes break typecheck, not the
  page. Don't add `.js` files without the same treatment, and don't let the
  server program see `telegram-webapp.d.ts` — its `Window` declaration
  changes how linkedom's `parseHTML` resolves in `agent/tools/fetch.ts`
  (that's why tsconfig.json excludes it).
- **The app client is the one built client.** `app/` is Vite + React +
  strict TS — `@ai-sdk/react` `useChat` over the UIMessage stream endpoints
  (DESIGN.md → App channel). It gets a build step because React is the
  price of the SDK's chat pieces; nothing else gets one. Same discipline
  otherwise: no `any`, wire types imported from server sources, its tsconfig
  program joins `bun run typecheck`, and `src/http` serves `app/dist` under
  `/app/` with a fail-loud 500 + log line when the build is missing.
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
  `foo.test.ts`). `bun test` to run, `bun run typecheck` (both tsc
  programs) before committing.
- **Only `src/tg/` knows grammy.** Domain modules never see a Telegram
  context object.

## Scope discipline

The non-goals list in `DESIGN.md` is load-bearing. Do not add subagents,
skills, MCP, projects, or inner-life machinery without an explicit ask —
"it would be nice" is how v1 happened. When a dropped capability returns, it
gets designed into the design docs first.

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
and templates before designing; cite what you took in the design docs.

## Live services

- `goblin.service` runs from this working tree — code changes go live
  only on `systemctl --user restart goblin`, which needs bermudi's OK.
- `goblin-herdr.service` owns the `goblin` herdr session where delegated
  harnesses run. Probe herdr only in a throwaway named session
  (`herdr --session goblin-probe server`), never `default` or `goblin`.
  Panes run bermudi's interactive zsh: aliases (codex, devin) already
  add no-approval flags, and repeating them in harness args is fatal.

## Keys (live since 2026-09-26)

- Every `auth.jsonl` record is `!pass-keys run goblin-dev -- printenv NAME`
  — the `goblin-dev` profile in `~/.config/pass-keys/config.json` (dots
  `passkeys` store), authenticating as the **`goblin-dev`** agent token
  (`~/goblin/pass-cli.env`), each key item-granted from the Keys vault
  and ID-addressed. `goblin-keys.timer` keeps the tmpfs cache warm.
  Profiles are environment-scoped (`goblin-dev`, `goblin-mcp-dev`) because
  the config syncs via dots — a future prod box gets `goblin-prod`, never
  these refs.
- Adding a key: `pass-keys add goblin-dev NAME Keys/<Item>` (or no item
  spec to paste a new key; rerun to rotate; `pass-keys drop goblin-dev
  NAME` to retire) — grants, refs, and warm in one step — then add the
  `auth.jsonl` record. Symptom decoder: a key error at request time → `pass-keys
  status goblin-dev` and `journalctl --user -u goblin-keys` first.
- `pass-keys run`'s stdout is the child's (fixed 2026-09-26 — operational
  lines used to corrupt resolved keys).

## Tests

Tests guard boundaries and invariants, not implementations. Fake the model
provider and the Telegram API at the edge; don't mock module internals. The
suite stays smaller than `src/`.

## Process

The polish backlog (gaps vs openclaw/hermes, audited 2026-10-02) lives in
GitHub issues labeled `polish`, ranked `P1`–`P3`, with `area:*` labels;
#52 records the ideas declined as non-goals — check it before re-proposing.

No Litespec, no specs tree, no decision records. Small commits, often, on
main or short-lived branches. If a design tension is real enough to argue
about, write the ruling into the design docs (`DESIGN.md` or
`design/<area>.md`) — the docs are the spec.
