# System One — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## What this is

System One is the working name for a _discriminative model_: one that
answers calibrated yes-probability (`noul`) questions about state instead
of generating text, cheap enough to ride every turn. The textbook name and
this working name are both recorded; which catches on is open.

**Naming rule:** identifiers that name the client, the gate or the concept
say `system1`; only model-id literals and model-choice tables say `jev` —
the model id names the model, not the system.

## The shared client

One `System1Client` is built at boot and shared by every consumer.
- **Models.** Default and backup are both `typesafe/jev-1.13` (operator
  ruling, 2026-10-05); the configured primary is
  `inception/mercury-decide:free`.
- **Logging.** Never state text, credentials, response bodies, or endpoint
  URLs.

## Wire protocol

A `noul` question must carry both true and false criteria — the transport
rejects a one-sided question.

## Consumers

Four consumers ride the one client; each keeps its own call site, budget
and failure semantics — this list is the single source of truth for who
they are:
- **Skill-review gate** — runs on every completed turn; fail-open: a gate
  outage falls back to the deterministic tool-count trigger (streak
  logged). `design/skills.md` → Skill reviewer.
- **Injection checker** — fail-open on `System1Error` only: an outage
  yields an "unavailable" verdict and the mail read proceeds; anything
  else propagates loud. `design/mail.md`.
- **Rolling DM follow-up check** — no client, `System1Error` or deadline
  → follow-up (continue), warn-logged. `design/telegram.md` → Rolling DM.
- **Loop watchdog** — unavailable → warn and skip; the deterministic
  detector still stands. `design/model.md` → No step budget.

## The loopback endpoint

`POST /api/check-injection` serves the checker to same-box callers (the
`goblin-mail` wrapper): a loopback Host allowlist **is** the auth — the
server binds loopback, and only loopback names may reach the check. Absent
client → 503; only unexpected bugs reach the 500 — the text is never
logged.

## Config

The optional bootstrap-only `system1` block is the shared client's own switch
(ruling 2026-10-12): set, the client exists and its non-reviewer consumers
attach, `reviewer` block or not (the skill-review gate itself still needs
`reviewer`); `reviewer` also implies the client, behaving identically.
`auth` names the `auth.jsonl` record, resolved live per call, falling back
to `reviewer.auth`; `model` is a bare decision-model id, never a
`<provider>/<model>` chat ref (deliberately outside provider validation);
`model`/`baseUrl` are boot-captured, so changes require an approved restart.
This block has no Settings controls yet; file edits follow the bootstrap and
recovery validation policy in `DESIGN.md` → Config.

With neither block there is no client: the layer is off.

## Provenance

Git owns the sequence; this doc is the shared gate's one home.
