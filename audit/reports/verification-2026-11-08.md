# Bug-hunt 2026-10-23 — verification record (2026-11-08)

Every finding of the 21 hunt reports was re-verified against **HEAD `9f294218`**
(2026-11-08; the tree had moved 7 commits past `8f75262c` during the day) by 21
independent read-only verifiers, one per report — none of them the original authors.
Method: read the finding, open today's code, decide; rg/relocation for moved code;
`git log`/`-S` to find fixing commits. No tests, no typecheck, no bun, no network,
no live services.

**Totals: 183 findings verified — 138 still-there, 37 fixed, 7 partial, 1 gone-unclear;
46 items stayed leads** (unverifiable offline by design, or resolved without a defect).

- Still-there **counted** findings and the partial remainders were filed as issues
  **#245–#335** (91 issues; 89 `bug`, 2 `refactor`; 2 P2, 89 P3). Two known
  re-finds were not re-filed: hunt-08's restoreNoteVersion = #232, hunt-20 F6 = #237
  (and S4 = #241).
- Still-there **smell/simplification** items (S-ids below) were filed 2026-11-08 as
  `refactor`/P3 issues **#336–#385** (50), in ledger order per report: hunt-01
  #336–#341 · hunt-02 #342–#346 · hunt-08 #347–#352 · hunt-10 #353–#360 · hunt-15
  #381–#385 · hunt-16 #361–#364 · hunt-17 #365–#370 · hunt-20 #371–#372 · hunt-21
  #373–#380. (hunt-16 SIMPL-5 was skipped as the same mechanism as bug #311.)
- The 37 fixed findings were fixed almost entirely on 2026-10-23/24, the days right
  after the hunt — commits cited per row.

## hunt-01 telegram

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P1-1 | P1 | FIXED | `0aa12af1` — isPrivateDmAddress gate + reproducible test id |
| P3-1 | P3 | FIXED | doc re-ruled in `5de19d10` (bounded retries now documented) |
| P3-2 | P3 | STILL-THERE | **#245** refusal latch vs "every summons" ruling |
| S4-1 | P3 | STILL-THERE | smell — not filed (duplicated operator re-checks, mod.ts:1131-1222) |
| S4-2 | P3 | STILL-THERE | smell — not filed (per-boot DROP TABLE, guest.ts:22-23) |
| S4-3 | P3 | STILL-THERE | smell — not filed (dead `?? false`, guest.ts:497) |
| S4-4 | P3 | STILL-THERE | smell — not filed (CREATE TABLE in navigation txn, navigation.ts:72-85) |
| S4-5 | P3 | STILL-THERE | smell — not filed (command surface split, commands.ts:540 vs mod.ts:404-425) |
| S4-6 | P3 | STILL-THERE | smell — not filed (repeated literals, delivery.ts:455,475,576/343,373) |

Leads (6): live Bot API shapes; guest_message double-fire; latch intent (→P3-2);
flood-wait (→P3-1); out-of-scope seams; inbound download cap.

## hunt-02 turn engine

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P1 | FIXED | `aac0fffc` — inherited journal ids namespaced by origin run |
| F2 | P2 | FIXED | no fix needed — premise was false: the pinned SDK already emits tool-error chunks (bundle trace) |
| F3 | P3 | STILL-THERE | **#246** runtime.stop() throws on gone row |
| S1 | P3 | STILL-THERE | smell — not filed (skill-view.test.ts name, view.ts:114) |
| S2 | P3 | STILL-THERE | smell — not filed (scriptOutputSchema vs scriptCallsSchema duplication) |
| S3 | P3 | STILL-THERE | smell — not filed (dead lastUserSeq API) |
| S4 | P3 | STILL-THERE | smell — not filed (redundant read-side re-truncation, turn-journal.ts:414) |
| S5 | P3 | STILL-THERE | smell — not filed (passthrough asymmetry, skill-attribution.ts:11) |

Leads (3): provider id-reuse (moot after F1 fix); SDK onError-throw; out-of-scope consumers.

## hunt-03 model layer

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P2-1 | P2 | FIXED | `6a045aa2` — trailing SSE frame flushed at EOF |
| P3-1 | P3 | PARTIAL | **#252** arguments corruption fixed (`55432fd1`); wire events still unvalidated casts |
| P3-2 | P3 | STILL-THERE | **#247** catalog fetch unbounded body |
| P3-3 | P3 | STILL-THERE | **#248** glmVersion misprofiles unversioned ids |
| P3-4 | P3 | STILL-THERE | **#249** 1min exact-id vs prefix rule |
| P3-5 | P3 | STILL-THERE | **#250** title cap counts code points |
| P3-6 | P3 | STILL-THERE | **#251** codex auth merge spreads corrupt tokens |

Leads (6): codex live wire; 1min list; Telegram topic unit; openrouter none-listing; SDK retry filter; prompt byte-identity.

## hunt-04 cache pruning

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P2-1 | P2 | FIXED | `57ea87ca` — contradiction notices keyed by profile hash |
| P3-1 | P3 | STILL-THERE | **#253** dead cacheSourceReportSchema (refactor) |
| P3-2 | P3 | STILL-THERE | **#254** profile.model never consulted |
| P3-3 | P3 | STILL-THERE | **#255** settingsHash unused echo (refactor) |
| P3-4 | P3 | STILL-THERE | **#256** window-capture bare ZodError |

Leads (3): stubBinary depth; serializeToolDefs .then; empty prompt_hashes append.

## hunt-05 voice

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P3 | STILL-THERE | **#257** stripMarkdown idempotency premise false |
| F2 | P3 | STILL-THERE | **#258** onemin STT drops extra entries (was lead-labeled; code-side drop confirmed) |
| F3 | P3 | STILL-THERE | **#259** whistle cache trusted without digest re-check |
| F4 | P3 | STILL-THERE | **#260** onemin poll double-wrap |

Leads (4): null-transcript re-billing; elevenlabs lang regex; recorder await race; media intake scope.

## hunt-06 memory

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P2 | PARTIAL | **#268** 17 errors fixed (`9d95648a`); mypy still unpinned |
| F2 | P2 | FIXED | `9d95648a` — half-install recovery path (complete_half_install) |
| F3 | P3 | STILL-THERE | **#261** quadlet secret mounted twice |
| F4 | P3 | STILL-THERE | **#262** screening swallows short words |
| F5 | P3 | STILL-THERE | **#263** 1 MiB browse cap vs 12.8 MB schema |
| F6 | P3 | STILL-THERE | **#264** recall fallback defaults contradict policy |
| F7 | P3 | STILL-THERE | **#265** secret_lookup comma/newline handling |
| F8 | P3 | STILL-THERE | **#266** parked-row forget guidance unreachable (app door also bypasses now) |
| F9 | P3 | STILL-THERE | **#267** bench/healthcheck outside the mypy gate |

## hunt-07 http

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P1 | FIXED | `7ab1ef06` — part payloads zod-validated before persistence (+ edit surface) |
| F2 | P2 | FIXED | `3ec247d0` — proxy-compatible origin gate restored per ruling |
| F3 | P3 | STILL-THERE | **#269** attachment serving through symlinks |
| F4 | P3 | STILL-THERE | **#270** double terminal SSE error chunk |
| F5 | P3 | STILL-THERE | **#271** svg inline on the app door |
| F6 | P3 | STILL-THERE | **#272** no request-body cap on app JSON routes |
| F7 | P3 | STILL-THERE | **#273** app_push_deliveries grows forever |
| F8 | P3 | STILL-THERE | **#274** non-null assertion over read-back |

## hunt-08 app client

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P1 | P1 | FIXED | `3afd0c2c` — recorder teardown on unmount + grant-after-unmount window |
| P2 | P2 | PARTIAL | **#281** Voice tab fixed (`f522c1a2`); Accounts tab bare-index remains, no error boundary |
| P3 trailing-slash | P3 | STILL-THERE | **#275** (scope widened: project/note paths too) |
| P3 tokengate | P3 | STILL-THERE | **#276** |
| P3 rereads | P3 | STILL-THERE | **#277** |
| P3 restoreNoteVersion | P3 | STILL-THERE | duplicate of open **#232** — not re-filed |
| P3 svg preview | P3 | STILL-THERE | **#278** |
| P3 recording hint | P3 | STILL-THERE | **#279** |
| P3 client mirrors | P3 | STILL-THERE | **#280** |
| S1/S2/S3/S4/S5/S7 | P3 | STILL-THERE | smells — not filed (door-header copies; bytes/fmtBytes; relTime dup; pin glyphs; seg inlining; telegramdoor useState) |
| S6 | P3 | FIXED | `f522c1a2` — dead optional chains moved to the real failure point |

Leads (2): send-failure draft drop; MemoryView poll serialization.

## hunt-09 subagents

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P3-1 | P3 | STILL-THERE | **#282** over-cap disables the stop-runs remediation |
| P3-2 | P3 | STILL-THERE | **#283** TargetGoneError leaks unshaped |
| P3-3 | P3 | STILL-THERE | **#284** halt by message literals |
| P3-4 | P3 | RESOLVED-NO-DEFECT | lead answered: vendored pi-durable names version drift itself (Session.snapshot checkRecordVersion) |
| P3-5 | P3 | STILL-THERE | **#285** exists() folds errors into absence |
| P3-6 | P3 | STILL-THERE | **#286** baseline_seq=0 sentinel |

## hunt-10 agent tools

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P2-1 | P2 | FIXED | `f427be56` — spill footer names bash paging |
| P3-1 | P3 | PARTIAL | **#289** refusal edge fixed (`f427be56`); footer char undercount remains |
| P3-2 | P3 | STILL-THERE | **#287** transcribe scriptable without a ruling |
| P3-3 | P3 | STILL-THERE | **#288** typeless binary → mojibake text |
| P3-4 | P3 | PARTIAL | **#290** recovery consequence fixed; unencoded 2×4MiB=8MiB coincidence remains |
| P3-5 | P3 | RESOLVED-NO-DEFECT | lead answered: UiPart normalizes input on the client; gap cannot occur |
| S4 | P3 | FIXED (misread) | toolNames has a production caller (step.ts:21,132) — the deadness never existed |
| S1/S2/S3/S5/S6/S7/S8/S9 | P3 | STILL-THERE | smells — not filed (capped readers dup; postJson dup; dead baseUrl plumbing; dead rev branch; channelOf×3; invalid-arg ergonomics; truncateTail off-by-ellipsis; throwaway envelope) |

## hunt-11 sandbox/podman

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P2 | FIXED | `e447f896` — gated test aligned with the symlink refusal |
| F2 | P2 | FIXED | `bcc05a80` — desktops busy_timeout |
| F3 | P3 | STILL-THERE | **#291** timeout misreported as shape refusal |
| F4 | P3 | STILL-THERE | **#292** desktops drop deletes the row (needs ruling) |
| F5 | P3 | STILL-THERE | **#293** foreign attachments adopt as network-off |
| F6 | P3 | GONE-UNCLEAR | needs live podman; code-side exposure unchanged (podman.ts:397 colon) |
| F7 | P3 | STILL-THERE | **#294** unbounded candidate loop |

## hunt-12 mail

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P2-1 | P2 | FIXED | `5a0b0e11` — expiry settle failures logged |
| P2-2 | P2 | FIXED | `8d40cb90` — checkpoint held at seen-consistent boundary + design ruling |
| P3-1 | P3 | STILL-THERE | **#295** wall-clock cancel |
| P3-2 | P3 | STILL-THERE | **#296** oauth token cast |
| P3-3 | P3 | STILL-THERE | **#315** empty-string ids (network-failed in part B, refiled) |
| P3-4 | P3 | STILL-THERE | **#297** truncated/outputCapped dropped |
| P3-5 | P3 | STILL-THERE | **#298** apiCode hand-parse |
| P3-6 | P3 | STILL-THERE | **#299** goblin-mail max=0 / extra argv |
| P3-7 | P3 | STILL-THERE | **#300** CRLF at MIME boundary |
| P3-8 | P3 | STILL-THERE | **#301** stale busy snapshot |

## hunt-13 auth/keys

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P1 | P1 | FIXED | `2514b8f1` — gate wired into install with PoisonedAuth mapping |
| P2 | P2 | FIXED | `637189cd` — ENOENT → warn + exit 0 |
| P3 poison lint | P3 | FIXED | `8be66aee` (#131) — normalization catches splicing evasions |
| P3 citation | P3 | STILL-THERE | **#302** runtime strings cite a nonexistent DESIGN.md section |

## hunt-14 health/doctor

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P1 | FIXED | `307be8fb` — polling evidence required only when telegram enabled |
| F2 | P2 | FIXED | `0ab5ffc6` — telegram tables gated on config |
| F3 | P2 | FIXED | `c5e19db2` — doctor log stream on stderr |
| F4 | P3 | STILL-THERE | **#303** ten boot tables uncovered |
| F5 | P3 | STILL-THERE | **#304** >8 profiles = failure |
| F6 | P3 | STILL-THERE | **#305** skip reason without blocker |
| F7 | P3 | FIXED | `0a88f136` — dead allowlist entry dropped |
| F8 | P3 | STILL-THERE | **#306** localeCompare id assignment |

## hunt-15 programs/wake

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P2-1 | P2 | FIXED | `876f4d39` — undecodable wake rows skipped loudly |
| P3-2 | P3 | STILL-THERE | **#307** corrupt proposal row fails whole list |
| P3-3 | P3 | STILL-THERE | **#308** null responsibilityId mints dead resp:null rows |
| P3-4 | P3 | STILL-THERE | **#309** markRan/advancePastDue/setHook untransacted |
| S1-S5 | P3 | STILL-THERE | smells — not filed (hookHash dup; failUnlinked inline dup; programAddressTarget dup; wake triplet; fireScheduled double bookkeeping) |

Leads (5): cron DST fuzz; SIGKILL window; single-writer assumption; mail CAS half; out-of-scope seams.

## hunt-16 projects/notes

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P2-1 | P2 | FIXED | `b12efb2f` + `94cc94e2` — fence regex matches only genuine closers |
| P3-1 | P3 | STILL-THERE | **#310** redundant mutations bump rev + misleading logs |
| P3-2 | P3 | STILL-THERE | **#311** slug suffix escapes the cap |
| P3-4 | P3 | STILL-THERE | **#312** projectWorkdir ENOENT-only context |
| P3-5 | P3 | STILL-THERE | **#313** resolveLinkedDir raw throw |
| P3-6 | P3 | STILL-THERE | **#314** restore no-op logs a write |
| SIMPL-1..5 | P3 | STILL-THERE | smells — not filed (flag wrapper triplication; applyPin/applyArchive; version-row mapping; char-vs-byte units; = P3-2) |

Lead (1): isMachineryText prefix match.

## hunt-17 skills

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P3-1 | P3 | STILL-THERE | **#316** brace-name parts inject outside the catalog |
| P3-2 | P3 | STILL-THERE | **#317** cache-hit rewalk omits the dir cap |
| P3-3 | P3 | STILL-THERE | **#318** stranded .fetch-* staging dirs |
| P3-4 | P3 | STILL-THERE | **#319** wire union strips hybrid parts |
| P3-5 | P3 | STILL-THERE | **#320** arrow-marker filenames misread as links |
| P3-6 | P3 | STILL-THERE | **#321** corrupt descriptor = untyped 500 |
| P3-7 | P3 | STILL-THERE | **#322** injected-skill log drifts from design |
| S1-S6 | P3 | STILL-THERE | smells — not filed (dead re-export grew by one site; name rule ×4; ENOENT blocks ×8; no unescape; row literal ×3; gate logs streak 0) |

Leads (6): symlinked cache; manual-only listing; deploy seeds; budget constants; reviewer-stats scope; union strip exec-check.

## hunt-18 system1

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P1-1 | P1 | PARTIAL | **#327** blocked-stint keying fixed (`491164b8`); seq-less reset epoch + done dedupe remain |
| P3-1 | P3 | STILL-THERE | **#323** attach() accepts any target |
| P3-2 | P3 | STILL-THERE | **#324** attachment-detached never recorded |
| P3-3 | P3 | STILL-THERE | **#325** output_tokens dropped, no bounds |
| P3-4 | P3 | STILL-THERE | **#326** three health states, one refusal name |

## hunt-19 boot/config

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P1-1 | P1 | FIXED | `ddfb2db7` — http pinned as boot-bound |
| P3-1 | P3 | STILL-THERE | **#328** resp: prefix returns "" not null |
| P3-2 | P3 | FIXED | `7ba190db` — one owner for the sink route |
| P3-3 | P3 | STILL-THERE | **#329** desktops handle never closed |
| P3-4 | P3 | STILL-THERE | **#330** stale sandboxConfigured comment |

Leads (3): emit() stringify throw; EDQUOT; reader.cancel rejection.

## hunt-20 ops/deploy

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| F1 | P1 | FIXED | deploy.sh retired (`e8b02043`); release.ts builds the client unconditionally per rev — skew unrepresentable |
| F2 | P1 | FIXED | `03ffe927` — replay refuses to run while the service is active |
| F3 | P3 | FIXED | publish-app.sh gone (`e8b02043`); flipLive removes stale tmp links |
| F4 | P3 | FIXED | pipeline gone with deploy.sh; parseUnit fails loud on malformed entries |
| F5 | P3 | STILL-THERE | **#331** backup-state.sh octal keep counts |
| F6 | P3 | STILL-THERE | duplicate of open **#237** — not re-filed |
| S1/S2/S3/S7 | P3 | FIXED | gone with deploy.sh / replaced by release.ts shapes |
| S4 | P3 | STILL-THERE | duplicate of open **#241** — not re-filed |
| S5 | P3 | STILL-THERE | smell — not filed (replay mkdtemp leak) |
| S6 | P3 | STILL-THERE | smell — not filed (comment-audit inline ratio) |

Leads (2): value-import closure (moot under release layout); backup prune mtime ordering.

## hunt-21 testkit

| Id | Sev | Verdict | Note |
|----|-----|---------|------|
| P3-1 | P3 | STILL-THERE | **#332** fake-api edit guard divergence |
| P3-2 | P3 | STILL-THERE | **#333** boundary regex blind forms |
| P3-3 | P3 | STILL-THERE | **#334** crash-child MODE presence-only |
| P3-4 | P3 | STILL-THERE | **#335** unguarded rmSync cleanup loop |
| S1 | P3 | STILL-THERE | smell — not filed (dead messageIdBase trap) |
| S2 | P3 | PARTIAL | smell — not filed (two fake-model families; one member since deleted `f73af580`) |
| S3-S8 | P3 | STILL-THERE | smells — not filed (dead STALE_MS; sleep dup; dead [::1] branch; misleading headers; boot.ts stderr-as-lines; any-segment exempt dirs + waitLog O(n²)) |

Leads (4): open-stream step semantics; single-process premise; sweep env sensitivity; rmSync-throw portability.
