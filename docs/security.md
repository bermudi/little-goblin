# Security model

Who is trusted, what crosses each boundary, and what the system does when a
check fails. This is the reference for arguing about a change: if a patch
widens trust, moves a boundary, or flips a fail-open to fail-closed, it has
to win against this document first.

It is deliberately not a control checklist and not a pentest. It states the
model the code already implements, with citations, and labels anything that
is a *belief* rather than an *observed fact*.

**The one-line rule:** Goblin is a thinking process wired to the internet and
to a shell, chasing a target that changes after every tool call. It is not a
sandbox, and it must not try to become one. Security here means **bounding
authority** — which secrets exist, what scopes they carry, what can reach the
process, and what happens when a check breaks — never containing the agent
itself.

## 1. Assets

In rough order of blast radius.

| Asset | Where | Why it matters |
|---|---|---|
| Provider keys (`zai`, `openrouter`) | `auth.jsonl` → resolved via `pass-keys` | Metered spend; a leaked key is someone else's bill |
| `telegram` bot token | `auth.jsonl` | Full control of the bot — send as it, read its updates |
| `gmail-send` refresh token | `auth.jsonl` | Sends mail **as bermudi** |
| `gmail-read` / gws read auth | `auth.jsonl` + gws's own auth | Reads the entire mailbox |
| `brave`, `tavily`, `parallel` | `auth.jsonl` | Search-API spend |
| `gmail-client-secret` | `auth.jsonl` | OAuth client secret (not the mailbox itself) |
| Conversation history | `state/goblin.sqlite` | Everything said, in every topic, plus memory |
| Workspace files | `workspace/` | Files, attachments, skills, `SOUL.md`/`AGENTS.md` |
| The operator's machine | same uid, no sandbox | `bash` is a first-class tool; `~/` is one command away |

**Same-uid is not a boundary.** Goblin runs as `daniel` (uid 1000), the same
uid as this shell. File modes on `auth.jsonl` (0600) stop *other* local users
and services, not the agent: a same-uid reader ignores them. `DESIGN.md` says
this outright ("Honest boundary: same uid, full bash — the token's grants are
the real limit"). The real limits are the three below, in this order:

1. **Which secrets exist at all** — a key that isn't in `auth.jsonl` can't leak.
2. **What scopes those secrets carry** — a read-only Gmail token can't send.
3. **What egress is reachable** — see §5.

Mode bits still matter for *other* users and for containerized services on
this box: `state/goblin.sqlite` and `state/goblin.log` are `0644` inside a
`0755` directory, so any other uid that can traverse can read full history and
logs. (Observed 2026-09-30.)

## 2. Trust classes

Everything Goblin reads is one of five things, and only two of them are
allowed to act.

| Class | Examples | May it steer? |
|---|---|---|
| **Operator** | Telegram messages from an `allowedUsers` id | Yes — but still "ask first" for standing authority |
| **Goblin itself** | its own skills, `SOUL.md`, `AGENTS.md`, memory it wrote | Yes |
| **Untrusted content** | fetched pages, search results, mail bodies, delegated reports, terminal screens | **Never** — data to evaluate |
| **Machine/config** | `goblin.json5`, `auth.jsonl`, program rows | High-integrity, operator-owned |
| **Third-party model** | whatever the configured provider returns | Data, but note it *does* drive tool calls |

The operator's Telegram account is the root of authority. A message from an
`allowedUsers` id is a request from the operator, no matter which topic it
lands in — the gate is per-user, not per-chat
(`src/tg/mod.ts` `allowedUserGate`). This is why topics are not a security
boundary: a group reader who is also an allowed user has full authority, and a
group reader who is not gets nothing.

### The untrusted-content fence

Three *different* mechanisms enforce "content is data, never instructions,"
because the three sources fail differently:

- **Fetched pages, search results, delegated reports, terminal screens** ride
  inside an explicit `<web>` fence with a closing instruction line
  (`src/agent/tools/web.ts` `fenceUntrusted`; used by `fetch.ts`, `search.ts`,
  `delegate.ts`). The fence escapes its own delimiters so a page can't close
  it early.
- **The reviewer's skills staging** refuses any symlink whose resolved target
  leaves the skills tree, so a crafted link can't pull host files into the
  model-readable staging copy (`src/reviewer.ts` staging walk).
- **Inbound mail** is gated at the sender, then *scored* for injection by the
  System One / Jev checker on the read path (`src/injection.ts`,
  `src/mail-watcher.ts`). The mail path is the one place untrusted text is
  fetched and could be read before any human sees it.

The model provider is the weak seam in this table. It is "data" in the sense
that its prose is not authority — but it is the component that *chooses tool
calls*, so anything that can influence its output (an injection that survives
the fence, a poisoned file it reads) is upstream of tool execution. Treat the
provider as semi-trusted: its judgment is the thing you're paying for, and it
is also the thing an injection is trying to reach.

## 3. Entry points into the agent

These are the ways text gets into a turn. Ordered by reach.

1. **Telegram messages** — a human door. `allowedUsers` gates every
   update first thing. Media (photos, documents, voice) is materialized to
   `workspace/attachments/`; Telegram's `file_unique_id` is validated against
   `^[A-Za-z0-9_-]+$` before it is used as a path component
   (`src/tg/media.ts`).
2. **The app channel** — `/api/app/*` (`src/http/app-channel.ts`), the
   second human door. A submitted message takes the same `runtime.submit`
   path a Telegram one does; the `app/`-prefixed conversation id pins the
   conversation to this pool (the chat route's schema rejects
   telegram-shaped ids outright). Auth is `appToken` bearer or trust mode —
   §4. A client-supplied attachment `ref.path` is confined to files this
   process wrote into `workspace/attachments/` (`isStoredAttachmentPath`),
   so a chat body can't name an arbitrary host file to read.
3. **Webhooks** — `POST /hook/<token>` (`src/http/mod.ts` `handleHook`). The
   token is a 32-byte capability; only its sha256 is stored. Unknown and
   disabled read identically (404, no existence oracle); the route re-resolves
   the token after reading the body; a closed runtime answers 503 instead of a
   fake 202. **The token is the whole check** — no initData, no signature.
4. **Mail** — Gmail arrivals matching a program's filter fire a turn.
5. **Program cron** — a 5-field cron fires the program's charter.
6. **Delegated harnesses** — a spawned coding agent can write a report that
   wakes the runtime (`src/delegation-lifecycle.ts`).

Entries 3–6 all convert to the same thing: `runtime.submit` of a user message
into a pinned conversation. None of them grants new authority; what the
resulting turn may do is bounded by its charter and the operator's standing
rules, exactly like a typed message. Entry 2 differs only in who knocks:
in trust mode "the operator" is whoever can reach the door — the check is
reachability, not identity (§4).

**Webhook reachability is the sharpest edge here.** `/hook/` is mounted on the
same server as the mini app, which is bound to `127.0.0.1` and fronted by
whatever `publicUrl` points at. If that front is a reverse proxy that forwards
`/hook/*` **verbatim**, then anyone who can reach the front (the whole tailnet
under `tailscale serve`; the public internet under `funnel`) can POST to a hook
URL they were given, and the token is the only thing protecting it. `DESIGN.md`
says this explicitly ("reachable only through whatever door `publicUrl`
fronts"). Operationally:

- `tailscale serve` keeps it tailnet-only — every device on *your* tailnet can
  reach it. That is not the same set as "you".
- `funnel` makes it public. Do not enable funnel on this port unless you mean it.
- A reverse proxy should strip or refuse `/hook/*` unless a hook must be public.
- `/api/app/*` rides the same front. In bearer mode a funnel front publishes a
  locked door; in trust mode it publishes *the operator* — see the auth
  subsection below.

## 4. Secrets and egress

### Where secrets live

`$GOBLIN_HOME/auth.jsonl` (0600) maps a name to either a literal or a
`!`-command resolved lazily at use. Nothing goes in the process environment —
because `bash` inherits the environment, and an env secret is a secret the
agent can print. Observed record names on this box (2026-09-30):

```
brave  gmail-client-secret  gmail-read  gmail-send  openrouter
parallel  tavily  telegram  zai
```

Goblin reaches Proton Pass only through its own audited agent token
(`pass-cli.env`, 0600), with a `goblin-dev` profile granting keys item by
item. The token can read its grants; anything Goblin sees still goes to its
model provider. **Grant narrowly** — that is the whole control
(`DESIGN.md` → Auth → Proton Pass).

One sharp rule from that section, repeated because it is load-bearing: a
`!`-command that invokes `pass-cli` directly is *poisoned at load* and refuses
to resolve — Goblin's keys must come through `pass-keys`, so its audit trail
is its own. `install.sh` refuses such records.

### Where secrets go — egress

- **Model providers** receive the prompt (your messages, workspace files it
  reads, recalled memory) and tool results. Whatever a provider sees, that
  provider has. This is the single largest egress and it is structural.
- **Search/fetch providers** (`brave`, `tavily`, `parallel`, …) receive your
  query text.
- **Gmail** receives sent mail; **Hindsight** receives retained exchanges
  (**unverified**: whether the memory service holds its own credentials or
  reaches PostgreSQL with a shared one — not probed).
- **Delegated harnesses** run with no-approval flags (e.g. `claude
  --dangerously-skip-permissions`, `opencode --auto`), per the harness config,
  and can touch the workspace. They are operator-chosen tools running with the
  same uid as Goblin.

Nothing in the process assumes a public IP; the box is reached through
Tailscale. Listeners observed 2026-09-30 include `0.0.0.0:22` (ssh) and
`0.0.0.0:8096` (media server), plus tailnet-IP listeners on 443/8788. **The
active firewalld zone per interface was not queried** (it needs a polkit
prompt); the default zone is `public` (only `dhcpv6-client`), and the `home`
zone adds `ssh`, `samba`, `kdeconnect`, `mosh`, `RustDesk` — so the exposure of
`:22` and `:8096` depends on which zone the active interface is in.
**Unverified — probe with `sudo firewall-cmd --get-active-zones` if it matters.**

### The mini app's auth

Two different checks, deliberately:

- **API routes** (`/api/*`) require Telegram WebApp `initData`: HMAC-SHA256
  keyed by the bot token, timing-safe compare, `auth_date` freshness (24h, 5m
  future skew), and a user-id allowlist (`src/http/auth.ts`). Observed: 401
  without `initData`, loopback and tailnet alike.
- **`/api/check-injection`** requires only that the `Host` header is loopback
  (`src/http/check.ts` `isLoopbackHost`) — because its only caller is the
  local `goblin-mail` wrapper, same trust class as the model calling `gws` on
  the same box. Observed 2026-09-30: through `tailscale serve` it returns
  **403**, because Tailscale rewrites `Host` to `127.0.0.1:8788`; from the
  loopback with a spoofed tailnet `Host` it is **403** too. So this check
  fails *closed* under the proxy — a proxy that preserved `Host` would make it
  publicly callable, which is the failure mode to watch for.

### The app channel's auth

Same server, different check — no Telegram `initData` exists outside
Telegram. The mode resolves once at boot (`src/http/app-channel.ts`
`resolveAppAuth`), so a mid-run flip applies only after restart:

- **`appToken` set** — every `/api/app/*` request needs
  `Authorization: Bearer <value>` where the value is whatever the named
  `auth.jsonl` record resolves to (`!`-commands included). Compare is
  sha256-digest equality, so a wrong token's length leaks nothing. Wrong or
  missing → **401**; an unresolvable record → **503**; both logged. Rotating
  the record needs a restart (`loadAuth` is a boot snapshot, `resolve`
  memoizes) — the client re-prompts on 401 and keeps the token only in
  localStorage.
- **`appToken` unset** — trust mode: no credential exists, so whoever can
  reach the front *is* the operator. Defensible only because the intended
  front is `tailscale serve` — device-level trust on the tailnet (the collie
  precedent), not person-level. Boot warns
  `app channel trust mode must never sit behind a public URL (funnel)` —
  that line is the guardrail. **If `publicUrl` is a funnel address,
  `appToken` is mandatory.** The consequence is total: `/api/app/*` exposes
  chat history, config writes, file upload, and turns that run tools — trust
  mode + funnel is remote code execution as the operator, for anyone.
- **Trust mode's browser-origin line (#75, 2026-10-08)** — reachability
  proves the device, not the page: a site the operator's browser visits
  could fire no-cors POSTs (`text/plain` bodies, no preflight, response
  never read) at `/api/app/*` and spend operator authority. Mutations that
  carry a browser origin are refused (403) unless it is the request's own
  Host (either scheme) or the configured `publicUrl` origin — `tailscale
  serve` rewrites Host to the local upstream, so the publicUrl match is
  what survives the proxy. A `Sec-Fetch-Site` other than `same-origin`/
  `none` refuses too. Non-browser clients send neither header and pass —
  reachability stays their whole check, the model unchanged. Bearer mode
  skips the gate (the token is the check); JSON-body routes require
  `content-type: application/json` in both modes. Ruling in
  `design/app.md` → App channel → Auth.

## 5. Failure policy — fail open vs fail closed

This is the part a change is most likely to break, so it is stated per
boundary.

| Check | On failure | Why that direction |
|---|---|---|
| `allowedUsers` gate | **closed** — reject the update | Auth must never fail open |
| `initData` validation | **closed** — 401 | Same |
| `appToken` bearer (when set) | **closed** — 401; 503 if the record can't resolve | Same. When unset the check doesn't exist by design — trust mode is "no check," not fail-open |
| Browser-origin gate (trust mode, mutations) | **closed** — 403 | A page riding the device is not the operator (#75); non-browser clients keep reachability as the whole check |
| JSON content-type on `/api/app/*` mutations | **closed** — 415 | `application/json` is a claim a cross-origin page cannot make without a preflight |
| `/api/check-injection` host check | **closed** — 403 | Only reachable on-loopback anyway |
| Webhook token | **closed** — 404/405/503 | Unknown == disabled, no oracle |
| Injection scoring (Jev) | **open** — "unavailable", read proceeds | A checker outage must not block mail; the hard limit is read-only Gmail scopes |
| Reviewer gate (skill review) | **open** → fall back to "≥8 tool calls" | Review is an experiment; a gate outage must not drop reviews silently — it logs the fallback and the streak |
| Memory recall | **open** — continue without prior context | Turns must not wait on memory |
| Model provider error | surfaced, not swallowed | A failed call must look failed |
| Log file sink | degraded, retried (transient); dead after one warn (permanent) | A full disk is exactly when the durable log matters |

The injection checker is the interesting one: it fails **open** on purpose. Its
whole job is to *advise*, and the thing it protects is a mailbox Goblin can
read with a read-only token. Turning a checker outage into a read outage would
trade a rare risk for a certain one. If the read credential's scope ever widens
from read-only, revisit this line — the fail-open is only defensible while the
worst case is "Goblin read a scary email."

## 6. Out of scope / accepted risks

- **Lateral movement on the host.** Goblin can read `~/`, run `ssh`, and touch
  every file the operator can. Containing it is not a goal; running it on a box
  whose other contents you'd expose to a helpful-but-gullible assistant is the
  risk you accepted when you gave it `bash`.
- **A compromised model provider.** If a provider returns malicious tool calls,
  Goblin will run them subject to the authority rule and the operator's
  standing rules. No defense is attempted beyond the fence and the authority
  check.
- **Malicious skills.** Skills are agent-authored and read into the prompt.
  The reviewer validates and gates them, but the reviewer is itself a model
  call (fail-open, §5).
- **Physical/account compromise of the operator.** The Telegram account is the
  root of authority. Whoever holds it is the operator.
- **Denial of service on this box.** A runaway tool call is capped (timeouts,
  output ceilings) but the machine is shared with everything else here.

## 7. Verifying this doc

Facts here are date-stamped. To re-check the live ones (all read-only):

```sh
# what serves what
ss -tulpn                                   # listeners ONLY — never add -K, it kills them
tailscale serve status                      # what the tailnet door fronts (funnel: same command)

# the loopback-only check, through the real door and locally
curl -s -o /dev/null -w '%{http_code}\n' https://<publicUrl>/api/check-injection   # expect 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/config        # expect 401

# the app channel's auth mode, through the front it actually uses
curl -s -o /dev/null -w '%{http_code}\n' https://<publicUrl>/api/app/conversations # 401 = bearer enforced; 200 = trust mode — funnel + 200 means stop and set appToken
grep 'app channel' ~/goblin/state/goblin.log | tail -3                             # the boot-mode lines

# secrets that exist (structure only — never print values)
jq -r '.name' ~/goblin/auth.jsonl

# firewall (needs sudo; run ONE command, not a loop — each extra call pops a polkit prompt)
sudo firewall-cmd --get-active-zones && sudo firewall-cmd --list-all
```

Anything in this document marked **unverified** is a belief, not an observed
fact, and moves to a fact only when a probe above (or a new one) is run and its
output recorded here with a date.

## 8. Change discipline

A change is a security decision — worth writing down here — if it does any of:

- adds a secret, or widens a scope on an existing one;
- adds an entry point (§3) or makes an existing one reachable by a wider set;
- treats a new source of text as trusted (or stops fencing one that was);
- flips a fail-open to closed or the reverse;
- puts a secret somewhere `bash` can read it (env, a file in `workspace/`, a
  log line).

When a boundary is genuinely argued about and the argument is settled, the
ruling goes in `DESIGN.md` and the *model* goes here. `DESIGN.md` owns why;
this owns who and what.