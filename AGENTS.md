# goblin v2

App-first personal AI agent with an optional Telegram channel, for one operator
on the Vercel AI SDK; `goblin.service` runs from this tree.

## Product Direction

Before product or roadmap work, read [DIRECTION.md](DIRECTION.md) (settled
operator intent) and [ROADMAP.md](ROADMAP.md) (baseline, recommended sequence,
and acceptance targets). Continue from source and recorded evidence, not a
particular chat session. Do not restart settled discovery or mistake proposed
steps for already implemented behavior or blanket execution authorization.

Keep those files current as the operator changes direction or work lands.
Code defines shipped behavior; regression tests pin what must not change.
Use [DESIGN.md](DESIGN.md) as a map to the source and `design/` for rationale,
not as a parallel specification. Surface conflicts with operator intent
rather than silently overriding it. `docs/` is for operating Goblin.

## Guardrails

- **Goblin is a loop with tools and connectors. That's it.** How it solves
  a problem belongs to the operator and skills, not the code. Before adding
  code, check it improves the loop, a tool, or a connector — not task logic.
  DIRECTION.md → Goblin Is A Loop With Tools And Connectors (operator,
  2026-11-21).
- **Bun + strict TypeScript.** No `any` — `unknown` and narrow. Validate
  external input with zod at boundaries (config, Telegram updates, tool args,
  disk state).
- **The app client is the one client, two doors.** `app/` is Vite + React
  + strict TS — `@ai-sdk/react` `useChat` over the UIMessage stream
  endpoints (`src/http/app-chat.ts`), its tsconfig program joining
  `bun run typecheck` with wire types imported from server sources, so
  config schema changes break typecheck, not the page. It gets the
  tree's only build step; `src/http` serves `app/dist` under `/app/`
  (the PWA) and `/t/` (the Telegram mini app — design/telegram.md →
  Mini Apps), fail-loud 500 + log line when the build is missing. Don't
  add a second client or unchecked client `.js`, and keep
  `telegram-webapp.d.ts` out of the server program — its `Window`
  declaration changes how linkedom's `parseHTML` resolves in
  `agent/tools/fetch.ts`.
- **`ui-sdk` skill and interaction rules.** `.agents/skills/ui-sdk` is vendored
  from vercel-labs/ui (`skills-lock.json`; refresh with `bunx skills
  update ui-sdk`, don't hand-edit). Where it disagrees with this repo:
  `bun run typecheck`, not `npx tsc`; skip its agent-ready step and
  agent test until the operator rules on the agent bridge (#621).
  Interaction behavior (focus, keys, ARIA) follows ui-sdk, not hand-made
  interaction rules (operator, 2026-11-16).
- **Fail loud.** `ENOENT` means null. Everything else propagates with context.
  Never swallow an exception.
- **No new prose comments in TypeScript or TSX.** Use names and tests for
  what the code does. Record non-obvious decisions in one design note or
  [ADR](design/decisions/README.md). Keep required directives and legal
  notices. Use the [`delete-comment` skill](.agents/skills/delete-comment/SKILL.md)
  to audit a slice; the CI baseline may only shrink.
- **Cache-busting bugs are P0, always.** A bug that busts the prompt cache —
  moves the request prefix hash outside the sanctioned rewrites (DESIGN.md →
  Cache stability) — is never P1 or P2 (operator, 2026-11-18).
- **Re-check authority at the action.** A read before an asynchronous
  operation does not authorize a later effect. For race regression tests,
  hold the first action while the competing change lands, then prove what
  the first action can still do (operator, 2026-11-18).
- **Prod usage counts are never an argument.** Goblin is barely used yet
  (~16 conversations in 2 months); low counts of folds, calls or any
  feature prove low use overall, not that the feature doesn't matter.
  Never cite them to skip, defer or downgrade work (operator, 2026-11-18).
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
- **Each external contract is known by one adapter.** Only `src/tg/`
  knows grammy; the podman, gws, GitHub, T3 Code, cua-driver and
  Anthropic Agent SDK wire contracts live in
  `src/{podman,mail-gws,github,t3,desktops,agent/claude-code}`. Domain
  modules see the adapter's
  types, never the vendor's — `module-boundaries.test.ts` enforces the
  importable cases.
  (The Vercel AI SDK is the platform, but goblin owns its data shapes and tools —
  `src/message.ts`, `src/tool.ts` — and only an allowlist of files may import it:
  DESIGN.md → Module map, #581/#595/#597.)

## Design inspiration

When designing workspace layout, identity/memory files, prompt assembly, or
scheduled work, borrow *mechanisms* — never scope — from two mature local
agents: `~/build/testing/openclaw/` (TS, multi-channel) and
`~/build/testing/hermes-agent/` (Python, Nous). For harness patterns
(compaction, tool calling): `~/build/pi-mono/`. All three carry feature
lists on our non-goals list. Cite what you took in the design docs.

## Live services

- **Prod is g7 — immutable releases.** `goblin.service` runs from
  `~/goblin-releases/live`, a symlink to one complete release directory
  named by commit (`WorkingDirectory` resolves at process start). Code
  changes go live only through `bun scripts/release.ts` — build-if-missing
  → typecheck gate inside the release → atomic symlink flip → restart →
  startup acceptance — and running it IS bermudi's restart OK. Also
  `--rollback <rev>`, `--status`, `--build-only`, and `--adopt-unit` (the
  one-time per-box cutover). Ruling: `design/deploy.md`. It never pushes,
  fetches, or pulls; publishing main is separate and also needs bermudi's
  OK. The memory stack is never auto-deployed — `deploy/memory/` changes
  print the manual runbook. Lithium cutover archives:
  `~/goblin-migration-20261008/`.
- Quadlet `HealthCmd` takes no shell metacharacters — podman's
  CMD-SHELL re-quoting mangles one-liners into restart-loops (lithium,
  podman 5.4). Healthchecks are mounted scripts; keep them that way.
- **The client ships inside the release.** `bun run app:build` writes
  `app/dist`; in prod that directory lives inside the running release,
  served per request for `/app/` (the PWA) and `/t/` (the Telegram mini
  app). So a client change *is* a release and a release *is* a restart —
  client/backend skew is unrepresentable — except offline, where the
  service worker can serve a cached older shell against a newer backend
  (design/app.md → Offline shell) — and there is no second thing to
  publish. The old `app/dist.a`/`dist.b` slots and
  `scripts/publish-app.sh` are gone: a dev-tree build is just a local
  artifact. `bun run app:dev` remains the HMR loop against the live
  backend.
- Memory embeddings are local: ollama `embeddinggemma` on the system
  `ollama.service`, reached from the API container through
  `goblin-embed-relay` (socat on the tailscale IP — see docs/memory.md →
  Local embeddings). Tailscale down or ollama down = the memory API
  can't embed or boot. Changing the embedding model with a non-empty
  bank is a re-index, not an env edit.
- `delegate` runs named external harnesses on pinned herdr-core
  (`src/hc.ts`) in Goblin's private hc terminals (design/agents.md →
  `delegate`: external harness runs on hc); the operator can inspect them
  through hc or in the app. Handover and responsibility stay on T3 Code
  threads (`src/t3.ts`). Verifying each wire contract is the code's job,
  not an agent's: run the gated drift check
  (`GOBLIN_HC_LIVE=1 bun test src/hc.live.test.ts` after core upgrades —
  it uses a throwaway session, never the operator's;
  `GOBLIN_T3_LIVE=1 bun test src/t3.live.test.ts` after t3 upgrades —
  red means re-pin fixtures in one throwaway-project probe, then fix
  the adapter; its safety rules live in the file header).

## Keys

- `auth.jsonl` command records use `!pass-keys get goblin-dev NAME`.
  `get` reads only the local encrypted profile snapshot in Secret
  Service/KWallet; it never contacts Pass or warms on a miss. Missing
  snapshots/keys or an unavailable, locked wallet fail loud. The
  `goblin-dev` profile in `~/.config/pass-keys/config.json` (dots
  `passkeys` store) uses the dedicated **`goblin-dev`** agent, with
  item-level viewer grants from the Keys vault and ID-addressed refs.
  Its bootstrap PAT lives in the OS store under `goblin-dev`, not
  `~/goblin/pass-cli.env`; `goblin-mcp-dev` shares that agent lane and
  bootstrap identity, but has its own snapshot. Profiles retain their
  names on prod: prod/dev split by bot token and state home, not profile.
- `goblin-keys.service`/`.timer` perform explicit background sync with
  `pass-keys warm` (always refresh, twice daily plus boot/retries).
  Foreground reads never wait for remote warming. A failed sync keeps
  the last-good snapshot usable; snapshot age is reported by `status`,
  not an expiry gate. A persistent wallet preserves snapshots across
  reboot, but must be unlocked — PAM auto-unlock is not established.
- Adding/rotating/retiring a key is operator-owned: `pass-keys add
  goblin-dev NAME Keys/<Item>` or `pass-keys drop goblin-dev NAME`, then
  update the auth record as needed. Check `pass-keys status goblin-dev`
  and `journalctl --user -u goblin-keys` before debugging; never print
  values. Grant narrowly: OS-store encryption is not same-user isolation.
- `scripts/mcp` keeps `pass-keys run goblin-mcp-dev -- …`: local snapshot
  keys enter only the child environment, then direct exec; no Pass
  fallback. Stdout is the child's, diagnostics go to stderr.
- Migrating the bootstrap PAT, profiles, snapshots and live `auth.jsonl`
  is an operator action, separate from these source docs/units. Goblin
  loads auth at boot and memoizes successful resolutions: auth edits or
  key rotation need its approved restart. Unit installation/reload and
  production deployment also require bermudi's OK; see docs/operations.md.

## Tests

Tests guard boundaries and invariants, not implementations. Fake the model
provider and the Telegram API at the edge; don't mock module internals.
New turn tests script the model with `src/testkit/turn-script.ts`
(`sdkScript` / `claudeScript`), not provider stream parts.

Real model requests in tests use one of these three (operator, 2026-11-06):
`gpt-6-luna` on the codex provider, `claude-haiku-5-5` on the Claude provider,
or `minimax/minimax-m3.1-flash` on OpenRouter.
One exception (operator, 2026-11-06): the codex reasoning replay check uses
`gpt-6.1-terra`, because `gpt-6-luna` returned no reasoning item to replay.

Replay tests freeze real model responses so CI can check the code around a tool
call without a model: `src/testkit/model-replay.ts`, first used by
`src/agent/tools/delegate.replay.test.ts`. They say nothing about model
behaviour; only live tests do. A changed prompt or tool description fails them
on purpose, and the error prints the command to re-record. Only a person or
agent re-records; CI never calls a model. Recordings are public: use test
prompts with nothing private.

Live drift checks for unowned boundaries (t3, gws, podman) are
env-gated — `GOBLIN_<NAME>_LIVE=1 bun test
src/<module>.live.test.ts` — and run after any upstream upgrade; red
means the interface moved: re-pin with one probe, fix the adapter.
Each check's store/probe safety rules live in its header and its
design-doc ruling (delegation.md, mail.md, sandbox.md).

A failed matcher on a happy-dom node used to print every object the
node reaches and OOM the run instead of failing (#798).
`app/src/test-dom-print.ts`, a preload that must load before
`src/testkit.ts`, prints nodes as one line of markup. The diff matchers
(`toEqual` & co.) refuse a node: compare identity with `toBe()` or a
property such as `textContent`. A diff matcher on an `expect()` the guard
did not record fails loudly instead of printing.

Fixture hygiene: bun runs all files of one invocation in a single
process and scopes a module-level `afterEach` to the first-importing
file — `bunfig.toml`'s `[test]` preload of `src/testkit.ts`
makes its cleanup hooks global (without
it, full-suite runs leaked ~86k mkdtemp dirs until /tmp hit ENOSPC,
2026-10-22). Run `bun test` from the repo root so the preload loads;
new fixture helpers must not rely on their own module-level hooks.
The preloaded testkit gives each test a temporary `GOBLIN_HOME`, even
when one was inherited. Tests that skipped `useHome()` previously
created hundreds of `rig-*` and `events-*` dirs in the real home.
`testkit.ts` also runs an import-time sweep over a test-owned
namespace: every fixture it hands out lives under a per-process root
`goblin-test-fixtures-<pid>-<random>` in tmpdir, and the sweep removes
only those roots — older than an hour AND with the named owner PID
provably dead (`kill(pid, 0)` → ESRCH; alive, EPERM, symlinks, and
every other name or error preserve). Legacy `goblin-*` dirs and
foreign scratch are never touched. Crash/interrupt leftovers of tracked
fixture roots self-heal on the next run.
Subprocess fixtures publish PID files with temp + rename and validate
positive signed 32-bit PIDs before signalling. Reading a PID file
mid-write led to `kill(0, SIGKILL)`, which killed the test worker (#650).

A [memory runaway](GLOSSARY.md) — a test stuck in synchronous code that
keeps allocating — used to run until the kernel OOM-killed it: exit 137,
no test output, a desktop alert (2026-11-15: an `ai` bump silenced the
loop detector and two full runs crashed g7; 2026-11-20: nine kills in 30
minutes, #798). `afterEach`, timers and test timeouts never run then: the
main thread never yields. The [memory net](GLOSSARY.md)
(`src/test-memory-net.ts`, the first preload, #818) catches it from a
worker thread that reads the process RSS every 100 ms. Past the limit it
writes a `memory runaway:` report to stderr — RSS, limit, the running
test's full name and where it was registered — and SIGKILLs its own
process, seconds before the kernel would. The limit is 75% of the
tightest cgroup `memory.max` (1.5 GiB under the 2 GB cap), at most
3 GiB; `GOBLIN_TEST_RSS_LIMIT_MB` overrides it. A memory runaway is a red
result naming the test running when RSS crossed the limit: start there
(memory kept by earlier tests in the file also counts), don't re-run it. The net learns
test names by wrapping bun:test's `test`/`it`/`describe`, so it stays
first in `bunfig.toml`; a test that bypasses the wrapper fails in
`afterEach`. Design: DESIGN.md → Test posture → Memory net.

Still cap local runs, so a miss can't take the box down:
`systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0
timeout 120 bun test <file> -t <name>`. Full-suite runs go to CI.
Builds, lint and full suites stay on CI, but any agent may run a capped
typecheck before handing off — `systemd-run --user --scope -q -p
MemoryMax=4G -p MemorySwapMax=0 timeout 600 bun run typecheck` — and
must make it pass: skipping it sent four PRs to CI red on type errors
(operator, 2026-11-18). `app/src/App.test.tsx` fits the cap: a passing
run peaks at about 260 MB and takes about 50 s on CI (probe, 2026-11-20).
The earlier "needs more than 2 GB" note was never measured; a failed
assertion printing a mounted DOM (#798) fits that symptom. The heaviest
file is `app/src/tools/parse.test.ts` (1.2 GB on CI, #819).

Test scratch lives in RAM: `src/test-tmpdir.ts`, which preloads first,
points `TMPDIR` at `/dev/shm` unless `TMPDIR` is already set or tmpfs has
less than 2 GB free. g7's `/tmp` is disk-backed since 2026-11-02, and
SQLite fsyncs there took a full run from about 8 to 33 minutes, with
timeouts. A full run peaks around 200 MB. Never hardcode `/tmp/` in an
assertion; compare against `tmpdir()`.

The same preload defaults `GOBLIN_HOME` to a throwaway dir, so a test that
forgets `useHome()` can't write into the real `~/goblin` (it left ~960
empty `projects/rig-N` dirs there, 2026-10-19 → 11-06).

## Process

To run a branch on a throwaway instance and prove a change, use the
`verify-goblin` skill (`.agents/skills/verify-goblin/`): `bun run try <name>`
prints a URL, `bun run try down <name>` stops it.

`bun run doctor` is read-only diagnosis — no repair, no restart
authority. Release verification failures do not authorize an automatic
rollback. See [Operations](docs/operations.md) for the operator procedures.

No specs tree. Use small commits on main or short-lived branches. Keep
non-obvious choices, rejected alternatives and accepted risks in brief
[architecture decision records](design/decisions/README.md) or an existing
design note that already explains the choice. Do not duplicate schemas,
control flow, or test cases there.
