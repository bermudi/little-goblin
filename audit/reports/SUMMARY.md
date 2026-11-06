# Bug-hunt 2026-10-23 — consolidated summary

**Tree identity:** audited 2026-10-23, 16:11–17:45 local. Hunts 2–7 ran at
commit `59d3f7d7`; hunts 1, 8–21 ran at `9d4f861e` (HEAD at close). The two
commits differ only in `app/src/WindowView.test.tsx` — every production-code
finding applies to `9d4f861e` exactly. Tracked files were clean throughout;
the only dirt was untracked audit/ notes. Each report carries its own stamp.

21 areas, one read-and-report agent each, partitioned by `audit/bug-hunt-prompts.md`.
Baseline during the hunt (unchanged tree): `bun run typecheck` clean, `bun test`
4686 pass / 0 fail / 86 skip. No code was modified. Findings are agent-reported
with file:line citations; each report's "couldn't verify" section names the
premises that remain unproven (mostly live wire contracts, env-gated by design).

Totals: **0 P0 · 9 P1 · 15 P2 · ~60 P3** + per-area simplification/smell lists.

## P1 — wrong behavior on a plausible path

| # | Area | Finding |
|---|------|---------|
| 1 | Telegram | `src/tg/delivery.ts:230` — rich drafts + salute fire in topic-less groups because `dm:` prefix matches the group standing lane; the pinning test uses a synthetic id no production lane produces |
| 2 | Turn engine | `src/turn-journal.ts:494-523` — tool-call id reused across an inherited journal span makes journal writes silent no-ops (executed tool journaled nowhere) and the retry-grant dispatch throws; proven by scratch repro |
| 7 | HTTP surface | `src/http/app-chat.ts:30-71` — `/api/app/chat` never zod-validates part payloads; one malformed part is persisted and permanently poisons the conversation (probe-verified) |
| 8 | App client | `app/src/ChatView.tsx:1514-1607` — voice recorder has no unmount cleanup; navigating away mid-recording leaves the mic capturing with no stop path |
| 13 | Auth | `scripts/check-auth.ts` — install-time pass-cli refusal gate has no caller anywhere; the design/auth.md rule it implements never runs |
| 14 | Doctor | `scripts/check-startup.ts:266-271` — acceptance unconditionally requires "long polling started", which only fires when telegram is enabled → telegram-disabled installs can never pass startup acceptance (breaks install.ts + every deploy restart) |
| 18 | System1 | `src/responsibility-observer.ts:323` — blocked-stint sourceKey collapses to `blocked:na` when the server omits `state_change_seq`; a second genuine transition is silently deduped (scratch-proven: 2 events → 1) |
| 19 | Boot/config | `src/config-pins.ts:9-31` — `http.port` is boot-bound and Settings-editable but absent from `BootPins`: a save rewrites config, applies nothing, warns nothing |
| 20 | Ops | `scripts/deploy.sh:224` — client-rebuild trigger omits `src/tags.ts` (value-imported into the served bundle) → tags-only deploy serves a stale client |
| 20 | Ops | `scripts/replay-v7-history.ts:13-24` — raw `cpSync` of live `goblin.sqlite`+wal+shm with no stopped-service check; header falsely advertises live-safety |

## P2 — broken edge or error path (selection)

- `src/agent/codex/model.ts:156-189` — SSE parser discards a trailing unterminated frame at EOF; a complete answer dies as "ended before a terminal response" (sibling zai adapter flushes this case).
- `deploy/memory/` — documented mypy --strict gate is red (17 errors, no pin); installer half-install between env write and first `podman secret create` has no recovery path.
- `src/mail-gws.ts:332-372` — poll checkpoint advances past arrivals invisible to the filter's `q` search (index lag), silently and permanently skipping them; `src/mail-approval.ts:216` — expiry sweep discards `allSettled` rejections, no log.
- `src/desktops.ts:159-161` — shared state file opened without `PRAGMA busy_timeout`; first contended write fails outright. Sibling: gated integration test `sandbox.integration.test.ts:106` expects symlink export that `sandboxes.ts` refuses → `GOBLIN_TEST_PODMAN=1` red on a non-drift case.
- `src/wake-store.ts:572` — one undecodable wake row makes `reconcile()` throw whole, wedging ALL wake delivery every pump.
- `src/turn/stream.ts:652-661` — schema-rejected tool calls never reach the repeat detector/watchdog.
- `src/notes.ts:113` — `/<\/note/gi` neutralization mangles any `</note`-prefixed operator text (`</notebook>`) in every model-facing rendering.
- `src/http/app-auth.ts:35-48` — origin gate implements loopback-only Host matching, contradicting design/app.md's proxy-compat ruling ( tightening has no recorded ruling).
- `app/src/SettingsView.tsx:1700-1725` — hardcoded TTS engine options + rollout-skew window → render TypeError, blank tree, no error boundary.
- `src/agent/tools/script.ts:310-325` — >8 MiB spill footer names a `read_file` call that `read_file` refuses (silent dead end).
- `scripts/check-auth.ts:16` — readFileSync without ENOENT→null (latent, dead gate); `src/health.ts:555-557` — telegram tables expected unconditionally on telegram-disabled installs (spurious strict fail); `src/proc.ts:214/222` — worker `log.warn` can corrupt doctor's one-report JSON stdout.
- `src/cache-pruning.ts:72/111/176` — fresh contradiction under a revised profile is log-suppressed forever (dedupe key not profile-sensitive).

## Notable simplifications (full lists in each report)

- Duplicated byte-identical schemas: `scriptOutputSchema` (turn/stream.ts) vs `scriptCallsSchema` (skill-attribution.ts); `hookHash` (program-ops.ts) vs `hookTokenHash` (program-hook.ts) — on a credential path.
- `applyNetwork` fail-closed logic duplicated ~95 lines (sandbox-lifecycle.ts vs desktops.ts) — exactly where a rule divergence silently forked.
- The `</event` untrusted-fence ritual hand-implemented three times (subagent-prompts, delegation-lifecycle, scheduler).
- Dead code: `check-auth.ts` gate + its four tests; `cacheSourceReportSchema` (zero importers, enum already drifted); `Attachment.baseline` (misleading comment, dead field); fake-api `messageIdBase`; `"startup clock unavailable"` allowlist entry; codex `include: ["reasoning.encrypted_content"]` nobody reads.
- Six+ duplicated `parsedJson`/parse-refuse blocks across `src/http/` → one `app-shared.ts` helper; four duplicated operator re-checks in `src/tg/mod.ts` behind an existing `accessGate`.

## Clean areas (checked, nothing above P3)

Subagents/delegation/herdr (9), voice (5), skills (17), projects/notes (16, one P2), testkit (21), programs/wake scheduler core (15, one P2), cache stability core invariants (4).
