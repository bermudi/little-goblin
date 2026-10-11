# goblin v2

Telegram-native personal AI agent for one operator. Rewrite of
the original v1 (long gone) on the Vercel AI SDK; **this tree is the
one true tree** — `goblin.service` runs from it, and every session
works here. Read `DESIGN.md` plus the `design/` file for the area 
you're touching before any structural work.
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
of it on our non-goals list. Consult their AGENTS.md, docs/ and templates 
before designing; cite what you took in the design docs.

For agent harness inspiration there's nothing better than `~/build/pi-mono/`.
It is an open source harness cloned by Cloudflare, OpenRouter and others and
it can be gold-mine of prover patterns. Compaction, tool calling, etc.

## Live services

- `goblin.service` runs from this working tree — code changes go live
  only on `systemctl --user restart goblin`, which needs bermudi's OK.
- **Prod is g7 — this tree.** `goblin.service` runs from this working
  copy; code changes go live only on `systemctl --user restart goblin`,
  which needs bermudi's OK. lithium ran prod until 2026-10-09 — its
  goblin stack is torn down, its conversations were merged into this
  box's state, and the archives (snapshots, DB bundle, memory dump)
  live in `~/goblin-migration-20261008/`. The only sanctioned prod
  update is `scripts/deploy.sh`: gate (typecheck) →
  conditional `bun install`/`app:build` (marker
  `.git/GOBLIN_DEPLOYED_REV`) → restart → verify. Deployment never
  pushes, fetches, or pulls: `origin/main` stays the baseline for
  `coderabbit review --base origin/main`. Publishing main is separate
  and needs bermudi's OK. Deployment restarts prod and also needs
  bermudi's OK each time, which running the script IS.
  The memory stack is never auto-deployed; `deploy/memory/`
  changes print the manual runbook (see docs/operations.md →
  Deploying).
- Quadlet `HealthCmd` one-liners (`python -c "…"`) break on podman
  5.4: the trailing escaped quote is dropped in CMD-SHELL re-quoting,
  every probe dies `Unterminated quoted string`, and the watch
  restart-loops a healthy API (lithium, 2026-10-08; podman 6.1.3 on
  g7 masks it). Healthcheck commands are mounted scripts with zero
  shell metacharacters — keep them that way.
- **Exception: the built client is live per request.** `app/dist` is
  read from disk per request by the running service; `src/http/app.js`
  is loaded once at module startup and stays boot-pinned. Do not
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

## Comment policy (W6 ruling, 2026-10-08)

Comments carry the **local why**: invariants, non-obvious trade-offs,
sharp edges. They do not retell the design docs (at most one pointer
where a coupling is genuinely subtle), carry incident dates (git and
the hunt docs own history), or narrate what adjacent code obviously
does. `scripts/comment-audit.ts` reports per-file comment ratio — a
reported signal, not a gate; run it when you touch a file.

## Process

The polish backlog (gaps vs openclaw/hermes, audited 2026-10-02) lives in
GitHub issues labeled `polish`, ranked `P1`–`P3`, with `area:*` labels;
#52 is the implemented v1 doctor, not a declined-ideas ledger. Current
scope lives in DESIGN.md and design/, not historical issue labels.

`bun run doctor` is read-only diagnosis, not permission to repair or
restart. It emits one text/JSON report on stdout; diagnostic operational
messages belong on stderr, never mixed into JSON. Shared checks must not
bootstrap state or resolve arbitrary auth refs. Safe config-validation
errors retain their typed HTTP 422 contract; I/O errors remain 500.

No Litespec, no specs tree, no decision records. Small commits, often, on
main or short-lived branches. If a design tension is real enough to argue
about, write the ruling into the design docs (`DESIGN.md` or
`design/<area>.md`) — the docs are the spec.
