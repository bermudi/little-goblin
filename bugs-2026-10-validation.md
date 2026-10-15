# Bug audit validation — 2026-10-14

Validated against `d4d350e` and fixed on the session branch. The supplied
report's verified scenarios match the code; its suspected durability and
catch-hygiene findings need the distinctions below.

| Finding | Verdict / resolution |
| --- | --- |
| 1.1 Leaf symlink replacement | Confirmed. Both durable text and byte writes now resolve existing leaf links before selecting the tmp directory. Chained relative links preserve the managed target's mode. Dangling/cyclic links fail without replacing the link. |
| 1.2 Unsupported directory fsync | Confirmed observability gap, not an accidental fallback. Keep the explicitly supported portability fallback, but warn once per directory per process that entry durability is not guaranteed. Other errno values still propagate. |
| 1.3 Failure after rename | Real ambiguity in the error message, not evidence that throwing is wrong. A directory-sync failure must still report failure: durability is unknown. The error now explicitly says the file was replaced and retains the underlying cause. No rollback or success return was added. |
| 2.1 Tick after stop | Confirmed latent lifecycle gap. All three handles now permanently fence new scans after stop; async handles still join the existing scan. |
| 2.2 Double delegation start | Confirmed. A second lifecycle ticker over the same store object throws, including while the first owner's stop is draining. Ownership is released only once drain settles. |
| 2.3 Double scheduler start | Confirmed. Duplicate scheduler ownership of a programs store object throws. Stop is idempotent. A subsequent start gets a fresh retry generation; late completions from old sinks retain the stopped generation. |
| 3.1 Grammy type leak | Confirmed. `WakeDeps` now exposes channel-neutral delivery-sink and roll-marker ports. Telegram construction, API types, voice/rich settings, and bell wiring moved to `src/tg/wake.ts`. The composition root wires that adapter. |
| 3.2 Image-open errors | Confirmed. `sniffImage` returns null only for an absent file or a genuine unrecognized format; other open failures propagate with path and cause. |
| 3.3 Empty catches | Mixed, not a class of proven runtime bugs. Failed config-save queue branches now log while leaving the queue usable and the original rejection intact. Pipe cancellation/drain failures emit diagnostics. Codex error-body failures retain HTTP status and cause; Gmail error-body failures log before the HTTP error is thrown. The deliberate fallback/cleanup catches below remain. |

## Intentionally retained behavior

- `stopTicker` stops delegation polling, not the lifecycle's separate
  launch/send/read/stop operations. Existing in-flight scans drain normally;
  stop does not cancel remote work or discard a pending notice.
- Ownership guards apply to **the same in-process store object**, including
  distinct dependency objects around it. They are not cross-process locks
  or a claim of exactly-once delivery across separately opened stores.
- Directory fsync unsupported errors remain a warned portability downgrade.
  EIO remains an error even when rename has already landed. The sandbox
  cannot reproduce unsupported directory-fsync codes or power-loss behavior;
  those branches were validated by inspection, not claimed as reproduced.
- Comment-only catches for optional error-envelope parsing (herdr, gws,
  transcription, provider-error collection), already-closed stream cleanup,
  codex refresh-race fallback, process-kill fallback, and durable tmp cleanup
  preserve a primary error or intentional fallback. Their existence alone
  does not establish a defect. No blanket rethrow was introduced that would
  mask the primary error or break those fallbacks.

## Regression coverage

Added filesystem regressions for text/byte writes through chained relative
symlinks, mode preservation, dangling/cyclic links, and image-open failures.
Added lifecycle regressions for duplicate starts, post-stop ticks, ownership
held through drain, repeated old stops after a new owner starts, and old
schedule completions not reviving retries in a restarted scheduler.

Three delegation tests previously used a stopped ticker as a manual scan
handle or started concurrent owners. They now use a long timer or await the
old owner's stop before starting another. The delegate-tool tests likewise
join the old ticker before wiring a replacement. Installer fixtures now
copy the logger dependency of the process module.

## Verification

- `bun test` — **2618 pass, 36 skip, 0 fail**, 151 files. The skips remain
  external-service/live-gated suites, not newly disabled tests.
- Focused changed-behavior suite — **171 pass, 0 fail** across the durable,
  scheduler, mail watcher, delegation lifecycle, wake, and read-tool suites.
- Final process/installer recheck — **29 pass, 0 fail**.
- `bun run typecheck` — clean (server and app programs).
- `git diff --check` — clean.
- `bun run scripts/comment-audit.ts` — completed (informational report).

No production restart, deployment, live-service probe, commit, or push was
performed. Power-loss and unsupported directory-fsync behavior remain
inspection-only validations, as noted above.
