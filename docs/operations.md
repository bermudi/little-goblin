# Operations

Running the bot week to week: the service, the logs, backups, and what to
do when something's off.

## The service

One Bun process, managed as a systemd user unit. It restarts on failure
(5-second delay, never gives up — a phone-only operator can't run
`reset-failed`), starts on boot, and stops gracefully on `SIGTERM`.

```sh
systemctl --user status goblin    # is it alive?
systemctl --user restart goblin   # approved restart only; see Deploying
journalctl --user -u goblin -f    # live logs
```

On prod, restarting/deploying Goblin, installing/reloading units, or
publishing `app/dist` requires bermudi's OK. The commands here are an
operator runbook, not permission to run them during source verification.
`app/dist` is a symlink to the last published slot, resolved from disk on
every request. `bun run app:build` only stages `app/dist.next` and changes
nothing served; publishing is `scripts/publish-app.sh`'s atomic symlink
flip, which the approved rollout runs. Client publication and backend
restart are one coordinated approved rollout;
the plain Settings client is instead loaded once at backend startup.

Use Settings for routine configuration. Direct `goblin.json5` edits are for
bootstrap/recovery and advanced blocks without UI controls; validate them
with [Doctor](#diagnostics-and-first-start-acceptance) from the intended
checkout before an approved restart. Settings saves apply live where
supported; boot-pinned settings (such as
`telegram.apiRoot` and `appToken`) still need a restart. A save validates the
result through the config schema, then rewrites the file as one canonical
JSON5 object with defaults materialized: comments and key order do not
survive, and a config with unknown keys (or malformed JSON5) is refused
rather than overwritten. The mini app sends the version it loaded
(`If-Match`); a stale page's save is refused, never merged over newer bytes.
Before deploying a revision with stricter validation, run Doctor from that
revision against the existing home: unknown fields must be corrected
explicitly, not dropped during a save. Reopen Settings after any file edit.

`scripts/install.sh` is **fresh-only**, not an update or repair command. It
must refuse any existing installed Goblin target, even a stopped one, before
dependency sync or other mutations. Existing-target reinstall/repair and unit
refresh are separate, explicitly authorized operator actions. Source changes
do not refresh installed units. Prod updates use [Deploying](#deploying).

If the optional memory stack is installed, it takes care of itself: it
starts on boot with goblin, and a 5-minute timer (`goblin-memory-watch.timer`)
restarts the API if its health probe reports the container unhealthy. Stopping
the stack by hand is deliberate — nothing will start it again until you do.
With local embeddings opted in, `goblin-embed-relay` and
`goblin-embed-pin.timer` are part of the stack — `systemctl --user status
goblin-embed-pin` is the embed-path health check.
When the retention chain cannot reach the service for a continuous hour,
the bot says so **once** in the affected topic and keeps queueing locally;
nothing is lost while it is down. `/memory status` reports detail on demand.

Shutdown is graceful with a 10-second budget: in-flight replies are cut off
cleanly (the chat shows `⏹ superseded`), buffered-but-unsent messages are
still recorded in history, then the process exits. A crash mid-reply leaves
the same shape minus the flush — your message is in history, so the next
turn just answers it. The bot never auto-retries after a crash: replaying
half-run tool calls would be worse than asking again.

## Interrupted turns

A crash mid-turn leaves the run `interrupted` in the turn journal. Boot
sends one notice per interrupted run; `/resume` in the conversation lists
them (the app's interrupted-turns panel shows the same rows where they
died). Nothing replays or re-runs on its own — every step below is an
explicit operator decision.

`/resume` prints each run's **ambiguous** calls numbered — a `dispatched`
call means the side effect may or may not have landed — then its **known**
calls (completed/failed/recorded outcomes) under `known:`:

- **Ambiguous calls** decide by ordinal or id:
  `/decide <run> <n|callId> record-result|authorize-retry|skip [note]`.
  `record-result` asserts an outcome you already know happened;
  `authorize-retry` permits one more execution on resume; `skip` declines
  it — a re-ask reads your refusal, never the effect. Resume stays locked
  until every dispatched call has a decision.
- **Known calls** never hold ordinals — the `known:` lines print the
  ready-made `/decide <run> <callId-prefix> authorize-retry` command that
  grants one deliberate re-run. The recorded outcome stays visible as
  evidence; granting a known call cannot shift the ambiguous numbering,
  while a call that was decided while ambiguous keeps the ordinal it
  already had.
- **A grant is one-shot.** The next matching call consumes it durably — a
  second identical call meets a labeled `[turn-journal conflict]`, and a
  new execution needs a new `/decide`. If a granted re-execution crashes
  mid-flight it lands as a fresh ambiguous dispatch on the successor —
  the new dispatch, not the old grant, owns the next decision.
- **A labeled conflict is the safe default.** On a resumed or continued
  turn, any call colliding with a recorded execution is refused with the
  historical call ids — the old result is evidence, never the answer.
  Safe reads (`read_file`, `history_search`, `memory_search`) observe
  fresh state and run again on their own; a `skip` never expires.
- **Grants are preauthorization, not a retry button.** The fence has no
  in-band override — to re-run an effect deliberately, decide the
  historical call id *before* the resume that will consume it
  (`/decide <run> <id> authorize-retry`, then `/resume <run>`). The
  alternative is a fresh turn: an ordinary turn carries no recovery
  guard, so asking for the action again just runs it.
- **Legacy migrated grants are inert.** Rows that predate the grant
  tracking columns read consumed and fail closed — they can neither
  execute nor take a new decision. Decide the call fresh on the
  interrupted run, or re-ask in a new turn.

## Diagnostics and first-start acceptance

**Source integration:** shared Doctor checks/CLI, safe CONFIG/AUTH parser fixes,
threshold-independent lifecycle logging and launcher bootstrap are integrated
on the feature branch.
None of this installs/restarts production; older running code/logs may still
contain parser fragments. Keep raw logs private and use safe Doctor reports.

Run Doctor from the intended checkout with the explicit target
`GOBLIN_HOME` and the **service's PATH**, not an assumed login-shell PATH:

```sh
# From the chosen checkout; set PATH to the target service PATH first.
GOBLIN_HOME="$HOME/goblin" bun --no-install run src/doctor.ts --phase installed
# Add --json for a structured report; installed is the default phase.
```

Do not dump a service environment to discover the home or credentials. Confirm
checkout/home identity explicitly: a feature checkout without dependencies or
assets is not proof prod is broken. Bootstrap creates the home `doctor`
symlink pointing to checkout `scripts/doctor`, delegating to Doctor with default phase
installed. Existing installations receive that bootstrap change only on an
approved backend rollout, not by running diagnosis.

Doctor is detection, not repair: safe metadata, findings and manual remedies.
It does not resolve arbitrary credential commands, provision, warm/unlock,
build assets, download ASR artifacts, start units, launch agents, or make a
paid generation test. Local reference presence does not prove provider access.
Read-only DB inspection must not migrate/checkpoint or change main/WAL data;
SQLite may still create an incidental SHM coordination file.
Configured synthetic embedding probes can load/cache the configured model
and affect ordinary runtime counters; they retain no facts in a memory bank.

Fresh install follows this order, not an update sequence:

1. Cheap prerequisites/input checks and existing-target refusal.
2. Frozen dependencies, then confirm explicit provisioning is already complete.
3. `bun --no-install run src/doctor.ts --phase preflight [--json]` from the checkout with
   target home/service PATH. Preflight skips boot-created paths/DB, units and
   not-yet-built assets; it does not call an untouched checkout healthy.
4. App build, then dedicated `scripts/check-app-assets.ts`, invoking shared
   `checkAppAssets(checkout)`, before unit validation/install/enable.
5. After the approved start, bounded `scripts/check-startup.ts` acceptance:
   current-invocation boot-complete (`goblin up`) **and** `long polling started`
   evidence, plus actual loopback `/app/` HTML and referenced local assets.
   An old ready line, active status, timeout, restart or missing evidence
   cannot pass. Only safe event metadata/failure categories are reported,
   never raw journal bodies. The coordinator's two lifecycle events must
   remain observable even at warn/error; ordinary logs retain their threshold.
6. Installed Doctor checks, then the operator's explicit Telegram reply and
   app-conversation handshake. Public HTTPS and configured optional features
   need their own acceptance; local startup checks do not prove them.

See [Setup](setup.md) for provisioning, capability dependencies and the full
fresh-install runbook. No failure grants permission to auto-repair/restart or
to re-run the installer over an existing target.
SIGINT/SIGTERM stop installer-owned subprocess groups and later phases, not
already accepted systemd jobs/services. No automatic rollback is authorized.

## Key snapshots

Provider auth command records use `!pass-keys get goblin-dev NAME`.
`get` is a pure local read from an encrypted Secret Service/KWallet
snapshot: no Pass/network fallback, login or foreground warm. MCP keeps
`scripts/mcp` → `pass-keys run goblin-mcp-dev -- …`, injecting its separate
local snapshot into the child environment and directly execing (no output
proxy). Both profiles share the dedicated `goblin-dev` agent, narrow
item-level viewer grants and OS-store bootstrap PAT named `goblin-dev`;
no `~/goblin/pass-cli.env` is needed in the target setup.

```sh
pass-keys status goblin-dev       # local age/availability; no values
pass-keys status goblin-mcp-dev
journalctl --user -u goblin-keys
```

`goblin-keys.service` runs explicit `pass-keys warm` sync sequentially
for both profiles at boot, retrying failures every 60 s; its persistent
timer runs at 06:30 and 18:30 and catches missed runs. `warm` always
refreshes from Pass, even with an existing snapshot. Goblin retains
`Wants=goblin-keys.service` but does not order startup after it, so remote
sync is not on the foreground path. Initial snapshots (including an empty
MCP profile) must be provisioned before relying on offline startup.

A failed sync keeps the last-good snapshot usable. Age is information,
not expiry: use `status` and the journal to notice stale data. Missing or
invalid snapshots/keys or a locked/unavailable wallet fail loud instead
of fetching remotely. Persistent wallet snapshots survive reboot if
unlocked; a user service's linger setting does not unlock the wallet.
**PAM auto-unlock is unverified**, so do not promise unattended cold-boot
access until the wallet's actual unlock path has been checked.

An operator may run `pass-keys warm goblin-dev` (and `goblin-mcp-dev` as
needed) after fixing bootstrap/profile/grant issues. Never print a value
to debug, fall back to the owner session, or remove a last-good snapshot
just because sync failed. A rotation can leave old local keys until a
successful sync; upstream rotation/revocation is what invalidates access.

Migration of the bootstrap PAT, live profiles and `auth.jsonl` is a
separate process-only operator action, not performed by source edits or
Goblin deployment. Existing Goblin loads auth at boot and memoizes
successful values: changing command refs or rotating a resolved key
requires its approved restart, even after sync succeeds. The changed
unit sources must also be installed/reloaded separately with approval;
editing `deploy/` alone does not alter installed units. The pass-cli task
skill is seeded write-if-absent, so an existing workspace copy needs a
separately reviewed operator update; it is not overwritten by deployment.

## Deploying

Skill seeds vs. live skills: `deploy/skills/<name>/SKILL.md` is the
source of truth for the seeded copy; `ensureHomeLayout` installs it on
first boot. A skill that *advertises a backend tool* (e.g. herdr v2.2,
which assumes the `herdr` tool exists) must NOT be synced into the live
workspace ahead of the backend deploy that ships the tool. After the
approved `scripts/deploy.sh` rollout verifies the new backend, explicitly
sync the changed seed to its installed workspace copy as part of that
rollout. The script does not update existing installed skills.

Prod is this tree on g7 — `goblin.service` runs from the working copy,
plus the local memory stack (Podman). With bermudi's OK, one command:

```sh
scripts/deploy.sh
```

Deployment is local: it never pushes, fetches, or pulls Git refs.
Publishing to GitHub is a separate, explicitly approved action. This keeps
`origin/main` as a review baseline for local changes:

```sh
coderabbit review --base origin/main
```

Each deploy annotates `goblin.log` itself — `deploy restarting goblin`
just before the restart, `deploy restart accepted — goblin live at
deployed rev` once startup acceptance passes — so a deploy-initiated
restart is distinguishable from a spontaneous one in the operational log.

It refuses modified **tracked** files — the server runs in place, so the
process must match HEAD or the marker and its rollback would lie.
Untracked files are in no commit; it names them and deploys HEAD anyway.
It runs the gate (`bun run typecheck`; the full
suite gates merges via `.github/workflows/ci.yml`, not deploys),
then refreshes what the gate can't cover: `bun install --frozen-lockfile`
when the dependency manifests moved and `bun run app:build` when `app/`
or the manifests moved — the bundle inlines dependency code, so a React
or AI-SDK bump alone must rebuild it, and the client is served from
disk, so client and backend restart as one rollout. A marker in
`.git/GOBLIN_DEPLOYED_REV` tracks the last deployed revision (first run
refreshes unconditionally). A second marker,
`.git/GOBLIN_DEPLOY_INCOMPLETE`, is published before any mutation and
removed only after the restart verifies — a leftover means the last
deploy died mid-refresh, so the next run reinstalls dependencies and
rebuilds the client regardless of the source diff. It then restarts
the unit and gates on 75 s
startup acceptance (`scripts/check-startup.ts --watch`, the installer's
grammar): both lifecycle events in the new invocation's journal, `/app/`
HTML and its local assets served on loopback, and no crash-restart
within the budget — a bare is-active poll closes before slow boot
failures (e.g. a timed-out provider handshake) show. It then scans the
fresh journal for error lines, and prints the old→new
hashes plus a one-line rollback (`git reset --hard <old>`, then
`bun install`, `bun run app:build` and `scripts/publish-app.sh` — the
client slots and node_modules are gitignored, so the old revision needs
its own deps and client — then restart, and reset the marker). A gate
failure stops everything
before the service is touched.

After a state-viewer rollout, verify data access in the authenticated PWA:
open `/app/skills`, `/app/files`, and `/app/log`; click an installed or
proposed skill's `SKILL.md` and an extra file, and preview/download an
attachment. Check successful responses for all six API tails (`skills`,
`skills/file`, `attachments`, `attachments/file`, `identity`, `log`) under
`/api/app/`. Page-shell loading alone does not prove the API works.
An unauthenticated 401 in bearer mode proves only the auth gate:
authentication runs before routing, so nonexistent tails return 401 too.
Use the existing authenticated browser session; never paste bearer
tokens or raw private state into an agent transcript.

**Skill-provenance backfill (one-time, 2026-10-16).** The
`skill_sources` table ships empty; skills proposed before the deploy
predate it. After the rollout, run once:

```sh
bun scripts/backfill-skill-sources.ts
```

It parses `goblin.log`'s `reviewer review done` lines (7 records at
the time of writing) into the table, idempotently. `--dry` prints
what would be recorded. Then verify the thread panel on a known
generating conversation (e.g. the `open-source-check` spin-off):
header action → sheet lists the skill with the right state.

lithium ran prod until 2026-10-09; its goblin stack is torn down and its
state was merged here. Archives: `~/goblin-migration-20261008/`
(snapshots, DB bundle, memory dump).

The final memory probe distinguishes missing Podman or an absent container
from a failed probe. An installed API must report `healthy`; Podman,
inspection, and unhealthy-status failures retain diagnostics and fail the
deployment command rather than reporting success.

The memory stack is **not** auto-deployed: a `deploy/memory/` change
prints a note instead. Its assets are installed per-box — `python3
deploy/memory/install.py` re-runs the asset refresh (`start.py` /
`healthcheck.py` re-copied; installed quadlets never overwritten —
they're operator-editable). Quadlet changes apply by hand: edit the
installed file in `~/.config/containers/systemd/`, then
`systemctl --user daemon-reload`, `podman rm -f goblin-memory-api`,
`systemctl --user restart goblin-memory-api` — the `podman rm` is what
recreates the container under the new spec.

## Program proposals

Programs are standing authority, so goblin never activates one on its own
say-so. Grant-shaped tool calls — `create`, any charter text change, a new
trigger kind (a cron where none existed, a new or changed mail filter, a
hook where none existed) — write a durable `program_proposals` row and post
an approval card to the requesting chat. The card carries the *complete*
candidate — for a create, the whole draft; for an update, the resulting
configuration merged onto the live row — chunked but never truncated, with
the buttons on the last chunk: **you approve exactly what you saw**. Direct
edits stay direct: rescheduling an existing cron, renaming, lateness,
toggling, deleting, removing a trigger (the last one still refuses),
rotating an existing hook.

Tapping **Approve** is one SQLite transaction: the proposal re-validates
against the live program's immutable base fingerprint (id, address,
charter, triggers, enabled — *not* run or mail-cursor accounting, so a
landed fire never stales a proposal), activates through the store's own
create/update, and stamps the decision. A tap on a stale, superseded,
deleted-target or already-decided proposal refuses with the reason and
changes nothing; a repeated tap can never activate twice. **Reject** stamps
the proposal dead — proposal history is append-only and never deleted.

Failure modes are deliberately loud, never silently retried:

- **The card couldn't post** (Telegram down): the proposal stays pending
  and the bot reports it — ask goblin to *review* the proposal (or say
  "re-send the approval") and the same proposal id re-posts.
- **`publicUrl` unset on a hook request**: the approve tap refuses and the
  proposal stays pending — set `publicUrl` in the mini app, tap again.
- **Hook URL DM fails after approval**: the grant already landed — the card
  says so; ask goblin to rotate the hook to resend the URL.
- **The program changed mid-review**: the tap refuses "changed since this
  proposal" — reject it and ask again so the new card shows the real base.
- **A newer proposal exists**: the older pending proposal for the same
  program reads superseded; only the newest can activate.

Programs that predate proposals are grandfathered: they activate nothing,
ask nothing, and need no reauthorization — a health check counts
`program_proposals` among expected boot tables, and the table appearing is
the only upgrade artifact. Inspect pending state straight in SQLite:
`sqlite3 ~/goblin/state/goblin.sqlite "select id, kind, state, created_at
from program_proposals where state = 'pending'"`.

## Logs

Keep raw logs private. Prefer safe Doctor findings when sharing diagnostics;
do not paste arbitrary incident excerpts into agent context. Shared CONFIG/AUTH
source fixes construct safe parser errors, but do not sanitize old logs or
arbitrary external errors. Startup acceptance consumes only allowlisted
event metadata, not a raw log dump.

Every line is JSON, on stdout (→ the journal) and appended to
`~/goblin/state/goblin.log` (the durable copy — same content, survives
journal rotation). The log level comes from config (`debug` | `info` |
`warn` | `error`).

The rule the codebase holds itself to: a screenshot of weird behavior plus
the log file must fully reconstruct what the process did. Every arrival,
every send, every model and tool call, every settings change and error path
emits a line. If you're puzzled and the log doesn't explain it, that's a
logging bug — say so in chat and the bot can add the line (it owns this
codebase too).

Useful patterns:

```sh
# everything for one conversation
grep '"conversation":"topic:<chat>:<thread>"' ~/goblin/state/goblin.log
# errors only
grep '"level":"error"' ~/goblin/state/goblin.log
```

## Cache telemetry

Every physical model call is correlated: `model call` opens a fresh
`callId` (with the route key and truncated head/request/settings
hashes), and `model call usage` — or `model call failed` — closes it
with the usage split (`inputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `outputTokens`) plus `idleMs` and `prefixRelation`
carried over from the start observation. The same rows persist in
`state/goblin.sqlite` `model_cache_calls`. `rewrite` means the prompt
lineage changed (a compaction, a settings or tool-surface change — or
drift worth a look); `first`/`same`/`append` are structural facts like
it, not proof of cache warmth, expiry or a provider bug. Expiry-based
pruning exists but is opt-in and gated on this telemetry — see
`cachePruning` below.

```sh
# aggregate usage receipts from a log file (the optional count selects
# the most recent parseable usage receipts, not lines)
bun scripts/cache-report.ts ~/goblin/state/goblin.log 200
# settled calls for one conversation
sqlite3 ~/goblin/state/goblin.sqlite \
  "SELECT started_ms, status, idle_ms, prefix_relation, shared_messages, cache_read, input_tokens FROM model_cache_calls WHERE conversation_id = 'app/example' ORDER BY started_ms DESC LIMIT 200;"
```

Doctor's `cache.contracts` finding maps the configured models to their
reviewed contract metadata and warns when a duration is unpublished or
unknown, or when the review metadata is overdue. The bounded re-check
of the public contract sources is manual and network-only — public
docs over https, no credentials:

```sh
bun scripts/check-cache-contracts.ts    # one JSON report on stdout; exit 1 on changed/unavailable/overdue
```

It fetches each pinned source URL (15 s per source including redirects,
≤1 MiB, Accept: text/markdown, at most five https hops) and reports
`unchanged`/`changed`/`unavailable` per source — `unknown` where no
fragments are pinned. `changed` means a pinned fragment drifted:
review `src/agent/cache-contracts.ts` and have the contract owner
re-pin it; the script never edits policy. Its limit matters: fragment
matching detects a pinned clause disappearing, not every semantic
addition or rewording elsewhere on the page — an `unchanged` verdict is
not proof the contract still reads the same.

### `cachePruning` — persisted tool-result pruning (opt-in)

Hand-edited only. When the block exists, goblin replaces old large
textual tool outputs **in the model-facing view** with a stored marker
(`event_projections` rows); the `events` rows keep the original bytes
forever, and the marker prints a `history_search` context address
(`toolCallId` + `offset`) that pages the original back in 8000-char
slices. A committed marker replays byte-identically on every later read
and restart — deleting the config never restores or rewrites a committed
row, it only stops new pruning. New batches commit only between turns.

```json5
cachePruning: {
  minimumInputTokens: 40000,   // last completed call on this route must report at least this
  keepRecentExchanges: 4,      // user exchanges counted from the tail that stay verbatim (min 2)
  minimumResultChars: 20000,   // a textual tool result must be at least this large to be replaced
  retainHeadChars: 400,        // leading code points kept inside the marker
  retainTailChars: 400,        // trailing code points kept; head+tail must be < minimumResultChars
  profiles: [
    {
      model: "z.ai/glm-5.3",   // the ref this profile was reviewed for (label; matching is on hashes)
      routeKey: "<64-hex>",    // sha256 of the JSON route identity — copy from the log's routeKey
      settingsHash: "<64-hex>",// sha256 of the call settings surface — copy from the log
      idleAfterMs: 3600000,    // presumed cache expiry: prune only when idle this long
      reviewedAt: "2026-10-15T00:00:00.000Z",
      validUntil: "2026-11-15T00:00:00.000Z",  // must follow reviewedAt
      evidence: "empirical",   // or "documented-expiry" — only where the contract registry supports it
    },
  ],
}
```

The `routeKey`/`settingsHash` values come from the `model call` log lines
(full 64-hex digests are stored on `model_cache_calls` rows). A profile
matches only the exact route+settings pair it was measured on; changing
thinking level or providers silently selects no profile and disables
pruning. Findings that suspend new batches — committed rows always keep
replaying — are logged once each: `cache pruning profile expired`,
`documented cache expiry unsupported for this route`, and `cache policy
contradicted — pruning suspended` (an unchanged-prefix call inside the
assumed window reported zero cache reads — the presumed expiry is wrong;
lower `idleAfterMs` or drop the profile).

The review loop for keeping profiles honest:

```sh
bun scripts/cache-report.ts ~/goblin/state/goblin.log 200   # observed idle/cache_read receipts
bun scripts/check-cache-contracts.ts                      # public contract sources still read the same
```

Re-run `check-cache-contracts` before extending a `documented-expiry`
profile's `validUntil`; `empirical` profiles are re-derived from
`cache-report` output, never treated as provider guarantees.

Committed markers inspect like any other table:

```sh
# what is projected in one conversation, and under which policy stamps
sqlite3 ~/goblin/state/goblin.sqlite \
  "SELECT seq, tool_call_id, substr(route_key,1,12), substr(settings_hash,1,12), created_at FROM event_projections WHERE conversation_id = 'app/example' ORDER BY seq;"
```

## Desktop image

The `desktop`/`computer`-subagent pool (design/subagents.md) runs
`goblin-desk-*` containers from `localhost/goblin-desktop:1`. Goblin
never builds or pulls images — a missing image errors with the build
line. Build from the repo root:

```sh
podman build -t localhost/goblin-desktop:1 deploy/desktop
```

The image pins the cua-driver release by sha256; bump `CUA_VERSION`
and `CUA_SHA256` in the Containerfile together.

Desktop containers carry one capability the sandboxes do not:
`CAP_SYS_CHROOT` on top of the five wall caps, so Chromium can run
its own layer-1 sandbox as the `desk` user (operator ruling —
sandboxes keep exactly the five). The live drift check
(`GOBLIN_DESKTOP_LIVE=1`) verifies both halves: `CapEff 0x400cb`
inside the desktop and `chrome://sandbox`'s real status read back
from the page, with the screenshot and tree dump preserved under
`/tmp/goblin-desktop-evidence/`.

## Subagent drift checks

Three env-gated checks cover the subagent stack (design/subagents.md):

```sh
# real harness + local fake model in a real cached-alpine sandbox —
# local only, no external calls:
GOBLIN_SUBAGENTS_PODMAN_LIVE=1 bun test src/subagents/podman.test.ts

# real harness + real z.ai (worker glm-5.3, computer glm-5.3-flash):
GOBLIN_SUBAGENTS_LIVE=1 GOBLIN_SUBAGENTS_AUTH_FILE=<path-to-auth.jsonl> \
  bun test src/subagents/live.test.ts
```

The live check resolves the `zai` credential through the auth file —
the only secret-adjacent environment value is its path; never put a
key in the environment. Every probe container and network carries a
per-run token, is preflighted before creation, and only resources it
created are removed. Logs, screenshots and a REPORT.md are preserved
under `/tmp/goblin-subdrift-<token>/`; the podman gate writes
`/tmp/goblin-subenv-evidence-<token>/`. `src/subagents/crash.test.ts`
needs no gate — it runs in `bun test` and proves the crash-approval
path: a SIGKILL mid-dispatch of a side-effecting call parks the run
`needs_input` on reopen, and each `decide` verdict (authorize-retry,
record-result, abandon) plus the kill-while-parked and
result-committed windows behave as designed.

## Backups

Goblin's own state is under `~/goblin/`:

| What | Where | Notes |
|---|---|---|
| Conversations + history | `state/goblin.sqlite` | SQLite, WAL mode — snapshot with `scripts/backup-state.sh` (see below) |
| Settings | `goblin.json5` | plain text — the backup script copies it beside each DB snapshot |
| Secrets | `auth.jsonl` | guard this copy like the original — plain `cp` while readable |
| Identity, notes, skills, attachments | `workspace/` | plain files |

The state database snapshot is manual, not scheduled:

```sh
scripts/backup-state.sh        # snapshot + keep the newest 10
scripts/backup-state.sh 30     # snapshot + keep the newest 30
```

It runs sqlite3's `.backup` — the online-safe copy that reads the live
WAL consistently without checkpointing or mutating the source —
`quick_check`s the result, names it `state/backups/goblin-<UTC>.sqlite`,
copies `goblin.json5` beside it, and prunes only its own stamp-shaped
files to the newest *keep* (hand-named backups are never touched). Run
it before risky operations and as often as feels useful; the DB is a few
megabytes, so a snapshot is instant.

Never `cp` `goblin.sqlite` or its `-wal`/`-shm` sidecars while the bot
runs — a raw copy can split a WAL commit mid-flight and restore nothing.
A `.backup` file is a complete standalone database: no sidecars needed.
WAL checkpointing is left to SQLite's autocheckpoint; a manual
`PRAGMA wal_checkpoint(TRUNCATE)` or `VACUUM` rewrites state and belongs
only to a stopped service — neither is routine maintenance.

To restore: stop the service, move the live `goblin.sqlite*` files aside,
copy the chosen backup to `state/goblin.sqlite` (make sure no stale
`-wal`/`-shm` sidecars remain), restore `goblin.json5` alongside it if
needed, start, and watch the boot log.

Strays observed in `state/` (audit, 2026-10-12): `goblin.db` (0 bytes, an
earlier database name) and `goblin.sqlite.pre-requeue.bak` (a one-off
manual snapshot), plus the dated `pre-legacy-purge` set already under
`state/backups/`. None are live; archive or delete them by hand if you
want them gone — nothing removes them automatically.

Pass-keys bootstrap credentials and encrypted profile snapshots live in
the persistent OS wallet, outside `~/goblin/`. Include the wallet's
supported encrypted backup/recovery path in the operator plan; do not
export plaintext secrets into workspace files or logs. Offline recovery
needs an available, unlocked snapshot; remote re-sync also needs the
scoped agent/bootstrap to remain valid.

Optional long-term memory lives in Hindsight/PostgreSQL, separately from
Goblin's SQLite conversation state; include the separate
[memory backup/recovery plan](memory.md) when enabled.

The checkout itself (`little-goblin/`) holds no conversation state — it is
re-cloneable, but installed units and home shims still refer to its path, and
`app/dist` must be rebuilt and published through an approved rollout.

Peeking at history directly is fine (read-only!): the `conversations` table
holds one row per topic/chat, `events` holds the messages as JSON. But
treat the database as the bot's memory, not an editing surface — write to
it only while the bot is stopped, if ever.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service crash-loops or won't start | Run installed Doctor with the intended checkout/home/service PATH; inspect journal privately if needed. Older deployed code/logs can still contain parser fragments — do not share raw errors |
| `insecure permissions … chmod 600` | `chmod 600 ~/goblin/auth.jsonl` — group/world-readable secrets are refused, not warned about |
| `no secret named "…"` | `auth.jsonl` needs `telegram`, every configured provider `auth` name (Codex uses its own OAuth file), configured optional auth refs, and every search/fetch step's name (blank = the kind's own record — see `authDefaults` in `src/config.ts`); create/edit privately with mode 0600 |
| Secret command fails | For `pass-keys`, check `status goblin-dev` and `journalctl --user -u goblin-keys`; check wallet unlock/availability and snapshot/key presence first. Fix bootstrap/profile/item grants and explicitly `pass-keys warm goblin-dev` as needed. `get` never fetches remotely on a miss. Don't print values. Auth edits/rotated resolved keys need an approved Goblin restart; service `PATH` covers `~/bin` and `~/.local/bin` |
| Key sync fails but the bot still works | Last-good snapshots remain usable; `pass-keys status` reports age/availability. Repair the background sync without deleting snapshots or bypassing the scoped agent |
| Keys unavailable after reboot | Persistent snapshots need an available, unlocked wallet. Linger is not wallet unlock; PAM auto-unlock is unverified. Foreground reads fail loud rather than waiting for Pass |
| Bot runs but never answers | your user id in `operators`? The log names refusals and drops with the id. DM `@userinfobot` to confirm yours |
| Settings button missing/stale | Set `publicUrl` in Settings; saves apply it without restart. Bootstrap/recovery file edits need validation and an approved restart |
| Mini app won't load / `load failed: 401` | open it from the Telegram menu button (not a bare browser tab); logins older than a day expire — close and reopen |
| `config would remove your own telegram user id` | the save you're attempting drops your id from `operators` — fix the field, save again |
| Voice notes the model "can't hear" | `transcription` unset, or its provider was down — the log says which; the file itself is still in `attachments/` |
| `/memory` says degraded — blocked retention(s) | a retention failed permanently (e.g. provider credit ran out). `/memory` lists the short doc id + error; `/memory retry` resends with a fresh operation id (replays of the old one are dead server-side), `/memory dismiss` drops it (kept for audit). The mini-app memory tab shows the same status. The affected topic got one notice when it first blocked |
| `/app/` answers 500 / "app client not built" | The client is a build artifact, absent on a fresh clone and potentially stale after source updates. `app:build` + `publish-app.sh`, then check assets before first start; on an existing/prod target use the approved coordinated rollout, never an unapproved publish |
| `/app/` asks for a token you didn't expect | the server is in bearer mode — `appToken` is set in `goblin.json5`; paste the value of the `auth.jsonl` record it names. Never had a token? `appToken` was probably just added — it's boot-pinned, so a running process ignores the change until restart |
| `/app/` shows "The stored token stopped working" | the `auth.jsonl` record's value rotated (rotation needs a goblin restart to take) — the app's own "Paste a new token" door clears it |
| All speech synthesis suddenly fails | the Edge endpoint is unofficial and drifts — check the log, then update the bot |
| `ffmpeg` warnings at boot | install `ffmpeg` — voice features and large-file transcription need it |
| Thinking levels look wrong for a model | capability catalogs (models.dev, OpenRouter) refresh daily and are cached in `state/` — a failed fetch warns and falls back safely; it heals itself |
| `sandbox disabled with N tracked container(s) still standing` | the `sandbox` block was removed/emptied — the tool is off, so no call ever runs the idle sweep and the containers keep running. Remove them by hand: `podman rm -f <names>` (the warning lists them; `podman ps -a --filter label=goblin.sandbox=1` catches any row-less strays too). Stale rows left behind are inert while the block stays absent — if you'd rather they not seed a recreate on re-enable, `DELETE FROM sandboxes` on the stopped service clears them |

Can't pin it down? Share safe Doctor findings once integrated. If an incident
needs logs, inspect the relevant `state/goblin.log` excerpt privately and review
it for credentials before sharing; never paste auth/config values, parser
fragments or an unreviewed raw log dump.
