# Review of 6c48614

Verdict: hold rollout. Two P1 findings and eight P2 findings. The existing checks are green, but targeted probes expose missing coverage. No project files changed, commits made, pushes, service restarts, live asset builds, or live data/secret inspections.

Scope: current origin/main..6c48614, including the parallel-session changes in that range; historical comparison at 4c25b46 for runtime extraction attribution. Three fresh-context read-only reviewers inspected runtime/reviewer, memory/startup, and app/security/delegation/deploy. Their findings were independently checked below. This is not a claim that every line of the 238-file diff was exhaustively audited.

## P1 — Guest sandbox exposes private data through local fetch

Location: src/tg/guest.ts:660–661; src/agent/tools/fetch.ts:229–270; src/http/app-channel.ts:212,506–509,610–623.

The guest tool filter retains the unchanged personal fetch tool. Its default local extractor accepts loopback URLs, follows redirects, and returns JSON as text. App trust mode permits unauthenticated GETs. An admitted third-party guest can ask for the app conversation list and then its histories, bypassing the intended no-operator-data boundary. Browser-origin protection does not apply to server-side GETs. The older no-SSRF rationale depended on callers already having bash; sandbox guests have no bash.

Executed proof: ssrf-chain.ts used the actual guest filter, actual fetch tool, actual trust-mode app handler, and a temporary SQLite database containing only a synthetic marker. The marker was returned to the guest tool. No live app endpoint was read. Exploit requires the guest to be admitted and a reachable private service; the app-specific chain requires trust mode.

Fix: give guests a distinct network-restricted fetch path. Prevent access to loopback/private/link-local destinations, including resolved addresses and redirects; do not merely reject the literal string 127.0.0.1. Disabling guest fetch temporarily is safer than claiming an incomplete sandbox.

## P1 — Failed old-bank forgetting loses its retry state

Location: src/memory-forget.ts:162–170; src/memory-queue.ts:215–220.

The protocol deletes pending/submitted/blocked/dismissed outbox rows before remote document deletion. Those rows also supply the document-to-destination mapping. If an old-bank delete fails, or the process crashes in that window, retry no longer knows that bank holds the document. It can delete only from the current bank and report forgotten while the old copy survives.

Executed proof: forget-probe.ts used the real queue and forget protocol, temporary SQLite, and synthetic destination clients. First old-bank deletion throws; destination count becomes zero; retry returns forgotten without retrying old-bank deletion. Synthetic failure is fault injection, not an observed Hindsight outage.

Fix: persist deletion work per document/destination until all deletes succeed. Suppression must stop ingestion without destroying the information needed for retry.

## P2 — Runtime extraction can orphan an overflow joiner's sink

Location: src/turn/admission.ts:111–116; src/runtime.ts:792,660–666.

Resumed admission claims queued members before reading modelEntries, but the runtime adds those members to its tracked turns only after admission returns. A store read failure removes a joiner from pending without registering it for error completion. Its HTTP stream can hang forever.

Executed proof: runtime-probe.test.ts, REVIEW_ORPHAN. A store-boundary failure after real overflow compaction leaves the joiner's onDone unresolved, with runtimeBusy=false, even after shutdown. Test fails its expected settlement assertion. Historical source at 4c25b46 registered claimed members before the history read: this is an extraction regression.

Fix: register ownership immediately when claiming, or preserve/requeue/settle all claimed members on admission exceptions.

## P2 — Successful attachment steering bypasses a post-await authority check

Location: src/turn/stream.ts:402–403.

When an epoch changes while attachment conversion awaits, the successful path joins/replays the member and returns model input without rechecking authority. Only the conversion failure branch checks the fence.

Executed proof: runtime-probe.test.ts, REVIEW_PROBE. A FIFO parks conversion; bumping the epoch before releasing it produces five replayed chunks and a second provider-edge model call. Both sinks eventually fence, but too late to prevent those side effects.

Attribution: inherited from the pre-extraction runtime, not introduced by W3. It nevertheless invalidates a broad claim that authority safety was proven by preserving check sites.

Fix: check authority after successful conversion, before replay or another model request; preserve honest member settlement/requeue semantics.

## P2 — /off misses summons awaiting their placeholder

Location: src/tg/guest.ts:462–512.

Guest eligibility is checked before the serialization/placeholder await. Closing the chat while Telegram's placeholder response is pending bumps the conversation epoch, but the later submit reads that new epoch and starts a fresh authorized turn. There is no eligibility recheck.

Executed proof: probes.ts holds the synthetic Telegram response, runs the real /off handler, then releases the response. Runtime submit is invoked once with isOpen=false. Source tracing confirms actual runtime admission rereads the conversation epoch. This probe records boundary submission; it does not call a real model or Telegram.

Fix: revalidate chat openness, enabled configuration, and caller class after awaits, before submitting; fence/reject pending admissions as well as active turns.

## P2 — Reload reconciliation misorders history around a live tail

Location: app/src/ChatView.tsx:1013–1015; app/src/ChatView.test.tsx:292–295.

Current [u1,u2,streaming] plus durable [u1,a1,u2] becomes [u1,u2,a1,streaming], placing the previous answer below the next question. The existing test explicitly asserts this wrong order.

Executed proof: client-probe.ts calls the exported mergeTranscript and prints that result.

Fix: preserve the entire durable prefix's interleaving and append only the genuinely local tail; correct the regression expectation.

## P2 — First-send conversation creation drops unfinished uploads

Location: app/src/ChatView.tsx:733–748; app/src/App.tsx:395–397,499–521.

The composer preserves unsent pending/failed chips locally, but creating the first conversation unmounts that composer and mounts a new ChatView. Remaining uploads finish against the discarded component and disappear.

Executed proof: upload-probe.test.tsx mounts the real App in happy-dom with a controlled fetch boundary, stages two files, resolves one, sends, and resolves the second. The pending chip was visible before creation and absent afterwards. Its preservation assertion fails. No browser/server/live assets were touched.

Fix: preserve staged-upload ownership across the empty-state-to-conversation transition, or prevent sending until pending uploads have settled.

## P2 — Missing baseline capture can strand a completed remote delegation

Location: src/delegation-lifecycle.ts:1266–1303,1363–1373.

After a failed post-prompt read, first successful capture may already see done at sequence N. Future polls see completion_seq=N and baseline=N. Machine targets have no local fresh-report escape; timeout handling applies only to idle, not done. The row remains running indefinitely.

Executed proof: delegation-probe.test.ts with the real lifecycle and temporary store, synthetic Herdr boundary reporting done/completion_seq=9 and a prompt over 90 seconds old. Three ticks leave running with zero wakes and baseline 9. Test fails. This is a fixture state trace, not an observed live Herdr incident.

Fix: explicitly handle already-terminal states during baseline recovery, including the documented needs-input fallback when completion attribution is ambiguous.

## P2 — Printed deployment rollback does not roll back assets/dependencies

Location: scripts/deploy.sh:104.

The printed reset+restart leaves ignored app/dist and node_modules unchanged. An asset/dependency-changing deployment rolls back backend sources only, mixing old backend with new client/installed packages.

Validation: source inspection plus git check-ignore confirms both directories are ignored. No deployment/rollback was executed.

Fix: rollback must reinstall dependencies and rebuild the client for the selected revision before restarting, or use revision-bound release directories/artifacts.

## P2 — Dependency-only deployment skips client rebuild

Location: scripts/deploy.sh:71–75.

package.json/bun.lock changes install dependencies, but app:build runs only if an app/ path changed. Updating React or AI SDK packages without editing app sources therefore leaves the browser bundle at the old dependency versions while the backend uses the new versions.

Validation: inspected the script conditions and the client imports; no deployment executed.

Fix: include dependency manifests/lockfile and build configuration in the client build trigger.

## Verified checks and limits

- bun test: 1645 pass / 0 fail, 102 files, 5860 assertions.
- bun run typecheck: all three programs passed.
- bun run format:check: 237 files, clean.
- bun run vite build app --outDir /tmp/goblin-review-rY7giI/app-dist: passed. Nonblocking >500 kB chunk warning. Live app/dist untouched.
- Working tree remains clean at 6c48614.
- git rev-list --count origin/main..HEAD: 102, not approximately 120.
- Targeted failed assertions above are additional review probes, not failures in the unchanged checked-in suite.
- Live DB emptiness, backup existence, lithium compatibility, GitHub issue closure, prior review checkpoints, and historical claims of untouched live state were not independently verified. A dev-state inspection is not a production migration preflight.
- No concrete new W4 late-boot wiring or W5 reviewer instance-state regression was established.
- Probe scripts/logs remain beside this report for reproduction. Temporary fixture databases contain synthetic data only.
