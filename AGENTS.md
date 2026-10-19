# goblin v2

Telegram-native personal AI agent for one operator on the Vercel AI SDK;
`goblin.service` runs from this tree, and every session works here. Read
`DESIGN.md` plus the `design/` file for the area you're touching before 
any structural work. `docs/` is operator documentation, not spec.

## Guardrails

- **Bun + strict TypeScript.** No `any` — `unknown` and narrow. Validate
  external input with zod at boundaries (config, Telegram updates, tool args,
  disk state).
- **The app client is the one client, two doors.** `app/` is Vite + React
  + strict TS — `@ai-sdk/react` `useChat` over the UIMessage stream
  endpoints (DESIGN.md → App channel), its tsconfig program joining
  `bun run typecheck` with wire types imported from server sources, so
  config schema changes break typecheck, not the page. It gets the
  tree's only build step; `src/http` serves `app/dist` under `/app/`
  (the PWA) and `/t/` (the Telegram mini app — design/telegram.md →
  Mini Apps), fail-loud 500 + log line when the build is missing. Don't
  add a second client or unchecked client `.js`, and keep
  `telegram-webapp.d.ts` out of the server program — its `Window`
  declaration changes how linkedom's `parseHTML` resolves in
  `agent/tools/fetch.ts`.
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
- **No god-functions.** State clusters by lifetime into units; a
  subsystem returns an interface assembled from those units, never one
  scope of closures. ~300 lines is the smell line —
  `bun scripts/function-size-audit.ts` lists what crosses it (signal,
  not a gate; run it when touching a file). One named exemption:
  `boot()` in `src/index.ts` is the process composition root — its
  bound is structural, not numeric: every line a binding, an ordering
  comment, or a wire call, with zero business-rule closures. Splitting
  the spine into bigger `wireX` bundles just hides the wiring.
- **Only `src/tg/` knows grammy.** Domain modules never see a Telegram
  context object.

## Scope discipline

The non-goals list in `DESIGN.md` is load-bearing. Do not add subagents,
skills, MCP, projects, or inner-life machinery without an explicit ask —
"it would be nice" is how v1 happened. When a dropped capability returns, it
gets designed into the design docs first.

## Design inspiration

When designing workspace layout, identity/memory files, prompt assembly, or
scheduled work, borrow *mechanisms* — never scope — from two mature local
agents: `~/build/testing/openclaw/` (TS, multi-channel) and
`~/build/testing/hermes-agent/` (Python, Nous). For harness patterns
(compaction, tool calling): `~/build/pi-mono/`. All three carry feature
lists on our non-goals list. Cite what you took in the design docs.

## Live services

- **Prod is g7 — this tree.** `goblin.service` runs from this working
  copy; code changes go live only on `systemctl --user restart goblin`,
  which needs bermudi's OK each time. The only sanctioned update is
  `scripts/deploy.sh` (gate → conditional install/build → restart →
  verify; markers and mechanics in docs/operations.md → Deploying) —
  running it IS the restart OK. It never pushes, fetches, or pulls;
  publishing main is separate and also needs bermudi's OK. The memory
  stack is never auto-deployed — `deploy/memory/` changes print the
  manual runbook. Lithium cutover archives: `~/goblin-migration-20261008/`.
- Quadlet `HealthCmd` takes no shell metacharacters — podman's
  CMD-SHELL re-quoting mangles one-liners into restart-loops (lithium,
  podman 5.4). Healthchecks are mounted scripts; keep them that way.
- **Exception: the built client is live per request.** `app/dist` is
  read from disk per request by the running service, and serves both
  doors — `/app/` (the PWA) and `/t/` (the Telegram mini app). Do not
  build into `app/dist` to verify a backend-dependent client change:
  use `bun run vite build app --outDir /tmp/<unique-dir>` instead.
  Publishing the client and restarting the backend are one coordinated
  rollout, requiring bermudi's OK.
- Memory embeddings are local: ollama `embeddinggemma` on the system
  `ollama.service`, reached from the API container through
  `goblin-embed-relay` (socat on the tailscale IP — see docs/memory.md →
  Local embeddings). Tailscale down or ollama down = the memory API
  can't embed or boot. Changing the embedding model with a non-empty
  bank is a re-index, not an env edit.
- `goblin-herdr.service` owns the `goblin` herdr session where delegated
  harnesses run. Verifying the herdr wire contract is the code's job,
  not an agent's: run the gated drift check (`GOBLIN_HERDR_LIVE=1
  bun test src/herdr.live.test.ts`) after herdr upgrades — red means
  re-pin fixtures in one throwaway-session probe, then fix the adapter.
  Any manual probing is authoring-only and goes to a throwaway named
  session (`herdr --session goblin-probe server`), never `default` or
  `goblin`. Panes run bermudi's interactive zsh: aliases (codex, devin)
  already add no-approval flags, and repeating them in harness args is
  fatal.

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
provider and the Telegram API at the edge; don't mock module internals. The
suite stays smaller than `src/`.

Live drift checks for unowned boundaries (herdr, gws, harness-trust,
podman) are env-gated — `GOBLIN_<NAME>_LIVE=1 bun test
src/<module>.live.test.ts` — and run after any upstream upgrade; red
means the interface moved: re-pin with one probe, fix the adapter.
Each check's store/probe safety rules live in its header and its
design-doc ruling (delegation.md, mail.md, sandbox.md).

## Process

`bun run doctor` is read-only diagnosis — no repair, no restart
authority. Its contract (stdout/stderr split, shared-check rules,
422/500 boundaries) lives in `design/doctor.md`.

No specs tree, no decision records. Small commits, often, on main or 
short-lived branches. If a design tension is real enough to argue about,
write the ruling into the design docs (`DESIGN.md` or
`design/<area>.md`) — the docs are the spec.
