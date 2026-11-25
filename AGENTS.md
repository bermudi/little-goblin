# goblin v2

A personal AI agent for one operator, with one app and an optional Telegram channel.

## What Goblin is for

Goblin is the operator's personal assistant, in one place
([decision](design/decisions/one-assistant.md), operator, 2026-11-24).

- **One chat.** The operator brings everything to the
  [Rolling chat](GLOSSARY.md#rolling-chat): book this, track that, make the
  appointment. Results and questions come back there.
- **Errands and lasting work.** Goblin does errands itself. Work that lasts
  gets its own [bot](GLOSSARY.md#bot) (not built yet).
- **Goblin in the middle.** Goblin messages and reads the bots. They do not
  message or read each other.
- **Ask first.** Goblin asks before it spends money or sends mail.
- **Elsewhere.** Coding stays in T3 Code; Goblin starts and watches threads.
- **Frozen.** Telegram and [delegation](GLOSSARY.md#delegation) get fixes,
  not features.

## Goblin Is A Loop With Tools And Connectors. That's It.

This rule outranks every other doc in this repo (operator, 2026-11-21).
How Goblin solves a problem is up to the operator and skills, not the code.

- **Code owns:** the loop, the tools, the connectors, and what they need to
  run reliably (state, delivery, logging, limits, authority checks).
- **Skills and the operator own:** how a kind of task gets done: the steps,
  the judgment, the workflow, the "when X, do Y".
- **Before you add code, ask:** does it make the loop, a tool, or a
  connector better? Or does it encode how to solve one kind of problem? If
  it is the second, write a skill or leave it to the operator.

## Guardrails

- Use `unknown` and narrow it, not `any`. Validate external input with Zod.
  Keep modules flat and put tests next to the code.
- Propagate errors with context. For file reads, `ENOENT` means null.
  Use [`durable.ts`](src/durable.ts) for whole-file state. For append-only
  JSONL, write one serialized record per write and propagate failures.
- Use [`log`](src/log.ts), not `console.log`. Log external boundaries,
  critical state changes and errors. A screenshot and the log must be
  enough to reconstruct what the process did, without guesses.
- Give each external contract one adapter. Domain code uses the adapter's
  types, not the vendor's. See the [module rules](DESIGN.md#module-map).
- Re-check authority at the point of action. For a race test, hold the
  first action while the competing change lands, then prove what the
  first action can still do. See [authority at action time](DESIGN.md#authority-at-action-time).
- Bugs that change the prompt prefix outside the [allowed rewrites](DESIGN.md#cache-stability)
  are always P0. Never use low production usage to skip, defer or downgrade work.
- No new prose comments in TypeScript or TSX. Keep required directives and
  legal notices. Use the [`delete-comment` skill](.agents/skills/delete-comment/SKILL.md)
  for audits; the CI baseline may only shrink.

## App

- Keep one typechecked client for the web app and the Telegram mini app.
  Import server types for shared request and response shapes. Do not add
  unchecked client JavaScript. Keep `telegram-webapp.d.ts` out of the
  server typecheck: its `Window` declaration changes how linkedom's
  `parseHTML` resolves.
- Use the [`ui-sdk` skill](.agents/skills/ui-sdk/SKILL.md) for focus, keys
  and ARIA. Refresh it with `bunx skills update ui-sdk`; do not hand-edit
  it. Use `bun run typecheck`. Skip the agent-ready step and agent test
  until the operator rules on #621.
- For changes to serving or packaging the client, read the relevant sections of the
  [app design](design/app.md) and [deployment design](design/deploy.md).

## Design inspiration

For workspace layout, identity and memory files, prompts, or scheduled work,
look at `~/build/testing/openclaw/` and `~/build/testing/hermes-agent/`.
For compaction and tool calling, look at `~/build/pi-mono/`. Borrow mechanisms,
not scope.

## Live services

- Production runs complete releases, not this checkout. The client ships
  with the server. Deploying, restarting, rolling back, installing or
  reloading units, and publishing `main` each need operator approval.
  Read the [rollout runbook](docs/operations.md#deploying) before any of them.
- `bun run doctor` diagnoses only. A failed rollout check does not
  authorize repair, restart or automatic rollback.
- Key provisioning, rotation, retirement and migration are operator-owned.
  Foreground key reads use local snapshots only: no network fallback or
  sync on a miss. Before debugging auth, read the
  [key runbook](docs/operations.md#key-snapshots).
- The memory stack does not deploy with the app. Before changing its units
  or embedding model, read the [memory design](design/memory.md) and
  [embedding runbook](docs/memory.md#local-embeddings-applied-2026-10-09). Keep Quadlet
  health checks in mounted scripts; no shell metacharacters in `HealthCmd`.

## Tests

- Test behavior at boundaries, not module internals. Fake the model provider
  and Telegram API at their edges. Script model turns with
  [`turn-script.ts`](src/testkit/turn-script.ts), not raw provider stream parts.
- For real model tests, use `gpt-6-luna` on Codex, `claude-haiku-5-5` on Claude,
  or `minimax/minimax-m3.1-flash` on OpenRouter. Only the Codex reasoning
  replay check uses `gpt-6.1-terra`; `gpt-6-luna` returned no reasoning item.
  Record only public test prompts. Replay proves code behavior, not model
  behavior; CI never calls a real model or records a new replay.
- After an upstream upgrade, run the matching gated `*.live.test.ts`.
  Read its header for the command and safety rules first. If the interface
  moved, use one isolated probe to update the fixtures, then fix the adapter.
- Run from the repo root and keep the preload order in
  [`bunfig.toml`](bunfig.toml). Use the shared test fixture helpers; do not
  depend on module-level fixture cleanup hooks. Compare scratch paths with
  `tmpdir()`, not `/tmp/`. Publish fixture PID files atomically and validate
  positive signed 32-bit PIDs before signalling.
- Compare DOM nodes by identity or selected properties, not deep equality.
  If a run stops on its memory limit, inspect the named test before rerunning.

Run only targeted tests locally, under the cap. Typecheck and run the
comment audit before pushing: CI's `check` job refuses a new prose comment.
Builds, lint and full test suites stay in CI.

```sh
systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 \
  timeout 120 bun test <file> -t <name>
systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 \
  timeout 600 bun run typecheck
bun scripts/comment-audit.ts --check --base origin/main
```

## Process

- Use the [`verify-goblin` skill](.agents/skills/verify-goblin/SKILL.md) to
  prove app changes on an isolated instance, never on the live service.
- Code defines shipped behavior. Before changing a design, check the
  relevant ruling in [DESIGN.md](DESIGN.md) or `design/`. Keep decisions,
  rejected alternatives and accepted risks in one design note or
  [architecture decision record](design/decisions/README.md). Do not add
  a specs tree or duplicate schemas, control flow or test cases.
- Use small commits on `main` or short-lived branches.
