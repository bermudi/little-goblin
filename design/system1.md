# System One — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## What this is

System One — Kahneman's fast, automatic judgment — is how we think about
this class of AI: models that answer calibrated yes-probability questions
(`noul`) about state instead of generating text, cheap and fast enough to
ride every turn. The textbook name for the class is *discriminative
model* — it models P(label|input) directly, no generation; "System One"
is the working name for the same idea as an agent-cognition layer. Which
name catches on is open; this doc records both.

**Naming rule:** identifiers that name the client, the gate or the
concept use `system1`; only model-id literals and model-choice tables
say `jev` — the model id names the model, not the system.

## The shared client

One `System1Client` (`src/system1.ts`; named `jev.ts`/`JevClient` before
the 2026-10-12 rename) is built at boot and shared by every consumer.

- **Models.** Built-in default and backup: `typesafe/jev-1.13`
  (operator ruling, 2026-10-05); the operator's configured primary is
  `inception/mercury-decide:free`.
- **Retry.** A failed primary call retries the identical state/questions
  once against the backup model on the same endpoint — never on auth
  failures or HTTP 401/403 (the same credential cannot fix those). No
  duplicate attempt when primary and backup are the same model; no retry
  of a valid low-probability answer. The primary gets half the call's
  time budget to reserve room for the backup; both attempts share the
  original total deadline — 30 s by default, 3 s for Rolling DM's
  follow-up check.
- **Logging.** Every request, fallback, decision and failure logs under
  one request id: selected model, fallback flag, question ids, an input
  hash, probabilities, usage (input tokens, cost), latency, and a
  sanitized failure kind/status. Never state text, credentials, response
  bodies, or endpoint URLs.

## Wire protocol

`POST {baseUrl}/api/alpha/decisions` (default base
`https://openrouter.ai`) with `{model, state, questions}`. Each `noul`
answer is a yes-probability in [0,1]; `usage` carries input tokens and
cost. A `noul` question must carry both true and false criteria — the
transport rejects a one-sided question. The wire shape is pinned by a
boundary test on a recorded response (`src/system1.test.ts`).

## Consumers

Four consumers ride the one client. Each keeps its own call site, budget
and failure semantics — the table is the single source of truth for who
they are:

| Consumer | Call site | Ruling doc | Budget | Failure behavior |
| --- | --- | --- | --- | --- |
| Skill-review gate | `src/reviewer.ts`, on every completed turn | `design/skills.md` → Skill reviewer | 30 s client default | Gate failure → deterministic fallback trigger (≥ 8 tool calls, trigger: procedure), fallback streak logged |
| Injection checker | `src/injection.ts` `checkInjection` — direct for watcher fires (`scoredMailEvent`, `src/scheduler.ts`); the loopback endpoint for wrapper reads | `design/mail.md` | 30 s client default | `System1Error` only → "unavailable" verdict, the read proceeds; anything else propagates loud |
| Rolling DM follow-up check | `src/rolling.ts`, resolved via `followUpGate` | `design/telegram.md` → Rolling DM | 3 s total | No client, `System1Error` or deadline → follow-up (continue), warn-logged |
| Loop watchdog | `src/loop-watchdog.ts` via `runtime.setLoopWatchdog` | `design/model.md` → No step budget | 30 s client default | Unavailable system1 → warn and skip; the deterministic detector still stands |

The checker scores text through two `noul` questions (`injection`,
`severity`): head-cut at 8 000 chars, `malicious` ≥ 0.7, `suspicious`
≥ 0.3, else `clean`; the verdict line (`[injection check: clean p=…
sev=…]`, or `[injection check unavailable]`) rides with the text.

## The loopback endpoint

`POST /api/check-injection` serves the checker to same-box callers (the
`goblin-mail` wrapper): a loopback Host allowlist **is** the auth — the
server binds loopback, and only loopback names may reach the check. 64
KiB body cap; `{text}` of 1–64 000 chars; responds with the verdict
fields (`status`, `injection`, `severity`, `verdict`). Absent client →
503; the check itself is fail-open on `System1Error`, so only unexpected
bugs reach the 500 — the text is never logged.

## Config

The optional hand-edited `system1` block — `{auth, model?, baseUrl?}` —
tunes the shared client. `auth` names the `auth.jsonl` record and
resolves live per call, falling back to `reviewer.auth`; `model` is a
bare decision-model id like `typesafe/jev-1.13`, never a
`<provider>/<model>` chat ref (deliberately outside provider
validation); `model`/`baseUrl` are boot-captured — a hand edit applies
on restart.

**Observed coupling, not a ruling:** today the `reviewer` block's mere
existence is the client's on/off switch — a `system1` block alone
constructs nothing. With no `reviewer` there is no client at all: the
skill-review gate is off, the loopback endpoint 503s, watcher events
fire unscored, and the follow-up check and loop watchdog sleep. Whether
`system1` should be its own switch is an open decision; until a ruling
lands, the coupling above is what the code does.

## Provenance

Born as the skill reviewer's private gate (2026-09), then grew consumer
by consumer: the mail injection checker, Rolling DM's follow-up check,
the loop watchdog. Git owns the sequence; this doc is the shared gate's
one home.
