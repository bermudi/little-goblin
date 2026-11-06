> Audited 2026-10-23 18:00 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 13 — Auth & keys (src/auth.ts, scripts/{mcp,check-auth.ts,check-mcp-config.ts})

Read-and-report hunt per /tmp/goblin-hunts/hunt-13.txt. Governing spec: design/auth.md.
Tests were NOT run (operator override: full suite already verified green on this
unchanged tree). One scratch verification was executed under /tmp
(/tmp/hunt13-poison-evasion.ts, imports src/auth.ts + two /bin/sh printf probes)
— no live services touched, no secret material read (all fixture values are
synthetic strings from the tests themselves, never real files).

---

## 1. Findings (most severe first)

### P1 — The install-time pass-cli refusal gate is never invoked; the design ruling is unimplemented

- **Where:** `scripts/check-auth.ts` (the whole script) — no caller anywhere.
- **Rule violated:** design/auth.md → "Proton Pass (2026-09-26)" → "Never the
  owner session, by mechanism.": *"A `!` command invoking `pass-cli` directly
  is poisoned at load. Not a boot refusal: a phone-only operator cannot fix a
  crash loop, so the feature needing that key fails loud instead; **install.sh
  refuses such records before enabling the unit**."* check-auth.ts's own header
  repeats it: "Install-time gate … the installer refuses it here instead."
- **Evidence:** repo-wide search including gitignored files
  (`rg --no-ignore "check-auth"` over the whole tree) finds exactly three
  references: the hunt prompt (audit/bug-hunt-prompts.md), a comment in
  src/auth.ts:39, and src/auth.parse.test.ts which spawns it as a subprocess.
  `scripts/install.ts` runs `install-options.ts`, `check-app-assets.ts`, and
  `check-startup.ts` (install.ts:259, 270, 399) — never `check-auth.ts`;
  install.sh execs install.ts; deploy.sh, the systemd units under deploy/, and
  doctor never mention it either. deploy/memory/test_providers.py:149 even
  comments "the installer must not become the bypass" — but there is no
  installer-side gate to be.
- **Triggering path:** fresh install (install.sh's stated purpose — "Fresh
  setup only") with an auth.jsonl containing `{"name":"x","value":"!pass-cli
  item view ..."}`. Expected per design: install refuses (exit 2, names on
  stdout) before the unit is enabled. Actual: install succeeds; the mistake
  surfaces only when the feature first resolves — precisely the phone-only
  failure the install gate was ruled in to preempt.
- **Test that would catch it:** assert `scripts/install.ts` invokes
  `scripts/check-auth.ts` (string presence is enough); or end-to-end: install
  into a fixture home whose auth.jsonl carries a poisoned record and assert
  the install aborts with exit 2 before unit enable.

### P2 — check-auth.ts crashes with a stack trace on a missing auth.jsonl (ENOENT not mapped)

- **Where:** scripts/check-auth.ts:16 — `readFileSync(paths.auth(), "utf8")`
  with no ENOENT handling.
- **Rule violated:** AGENTS.md guardrail "**Fail loud.** `ENOENT` means null.
  Everything else propagates with context" — and the script's own contract
  ("a dedicated code so the caller can tell 'offenders found' apart from the
  check itself failing"): a missing file is neither "offenders" (exit 2) nor a
  clean check failure; it dumps an uncaught exception stack and exits 1. The
  codebase's own pattern for this exact situation is a structured result
  (src/auth.ts:177-180 ENOENT → empty store with a warn;
  scripts/check-mcp-config.ts:48-53 ENOENT → recovery message).
- **Triggering path:** running check-auth.ts with GOBLIN_HOME pointing at a
  home without auth.jsonl — the normal state of the fresh installs the script
  exists to gate (a brand-new operator has config, not keys, on day one).
- **Status:** latent today only because the script is dead (P1); the moment
  P1 is fixed by wiring the gate in, every keys-less fresh install hits it.
- **Test sketch:** `GOBLIN_HOME=$(mktemp -d) bun scripts/check-auth.ts` →
  expect exit 0 (no records → no offenders) or at minimum a one-line
  structured stderr message; currently: stack trace, exit 1.

### P3 — Poison lint evades via shell word-splicing (`p""ass-cli`, `pass-cl''i`, `pa\ss-cli`)

- **Where:** src/auth.ts:73 (`invokesPassCliDirectly`) — the same regex backs
  scripts/check-auth.ts:17 and src/health.ts:404.
- **Rule (literal reading):** design/auth.md → "Never the owner session, by
  mechanism.": *"A `!` command invoking `pass-cli` directly is poisoned at
  load."* — an obfuscated invocation invokes pass-cli directly but is not
  poisoned, and resolveCommand executes it through `/bin/sh -c` as the owner
  session.
- **Verified by scratch run** (/tmp/hunt13-poison-evasion.ts): the lint
  returns false for `p""ass-cli item view --vault-name k --item-title i`,
  `pass-cl''i info`, and `pa\ss-cli item view x` (`pass-cli"" info` is still
  caught — the word stays contiguous). Shell semantics proven harmless-side:
  `sh -c 'p""rintf shell-concat-runs'` prints the string (quote removal
  precedes command lookup), and `sh -c 'pa\ss-cli-does-not-exist'` errors
  "pass-cli-does-not-exist: command not found" — the spliced word is what
  executes.
- **Why only P3:** the lint's own comment frames it as "a lint, not a
  sandbox", the design's honest-boundary ruling makes same-uid full-bash the
  real limit, and the author of auth.jsonl is the operator — nobody
  accidentally types `p""ass-cli`. Invariant hygiene / defense-in-depth gap,
  not a security hole.
- **Fix sketch:** reject any `!` record whose command word contains quote or
  escape characters at all (the recognized-form grammar in parsePassKeysGet
  already does exactly this for the pass-keys lane via NON_LITERAL_EXECUTABLE).

### P3 — Stale citation: error strings point at "DESIGN.md: Proton Pass", which no longer exists

- **Where:** src/auth.ts:209 (log.error) and src/auth.ts:247 (resolve
  rejection) both cite "(DESIGN.md: Proton Pass)". DESIGN.md contains no
  Proton Pass section — the ruling lives in design/auth.md ("Proton Pass
  (2026-09-26)"), which DESIGN.md:241 links as
  `design/auth.md#proton-pass-2026-09-26`.
- **Why it matters:** these strings are the operator's fix instructions on a
  phone-only failure path; the pointer should name the actual spec file.
  Misleading-name hygiene, not behavior.

**Counts: P0 0 · P1 1 · P2 1 · P3 2.**

---

## 2. Checked and found clean (later passes can skip)

- **parseAuthFile loudness:** invalid JSON → line-numbered error with no
  native-parser cause retained (auth.ts:50-53); schema failures → field+code
  only (auth.ts:54-61). Pinned by auth.parse.test.ts: no sentinel retention in
  message/stack/cause/issues/JSON. Unknown-key stripping and duplicate
  last-wins are deliberate and pinned. Blank/whitespace lines skipped.
- **No negative-result memoization:** rejections evict
  (auth.ts:254 `resolved.catch(() => cache.delete(name))`); missing-name
  rejections are never cached (auth.ts:240-242, returned before cache.set);
  successes memoized for process lifetime per design ("Successes are
  memoized…"). `put()` drops the cache entry (auth.ts:228-234). The one
  eviction race (old rejected promise evicting after a put) only forces a
  re-resolve of the new value — never yields a wrong value.
- **resolveCommand error paths:** spawn failure contextualized with the
  secret *name*, never the command text (auth.ts:267-275); stderr excluded
  from errors (auth.ts:288-293, pinned by the hunter2 test); timeout,
  oversize/cut, nonzero exit, and empty output all refuse loud; bounded via
  boundedRun (15 s / 64 KiB, new process group, SIGTERM→SIGKILL, post-exit
  drain cut). The orphaned-`sleep 60 &` and `seq` flood tests pin the
  bounded behavior. Note: `boundedRun` is called without `processGroup`, and
  `killProc`'s default parameter fires on `undefined`, so group-kill is
  correct (checked — easy to misread).
- **Permission discipline:** loadAuthFile refuses group/world bits
  (auth.ts:184-191); appendAuthRecord refuses insecure modes on existing
  files and constructs new files 0600 — the `fchmodSync` at auth.ts:139 is
  NOT redundant (umask can strip owner bits, e.g. 0o777 → 0000). Append-mode
  correctness verified: O_APPEND write + explicit-position last-byte read,
  newline insertion for unterminated final records, empty-file case — all
  pinned by tests.
- **Poison semantics:** last-wins un-poison at load (auth.ts:206-215) and via
  put(); poisoned names stay in has()/names() and reject at resolve without
  spawning (pinned by the marker-file test — the rejection alone can't prove
  the spawn was skipped, and the test knows it).
- **scripts/mcp:** the imports gate runs before every call and exits 1 on a
  widened/missing config; nothing in the shim writes to stdout (fail() and
  the gate use stderr), so stdout belongs solely to the exec'd child per
  design ("Stdout belongs to the child"); env isolation (MCPORTER_*,
  XDG_DATA_HOME, XDG_CACHE_HOME) points at goblin-owned state dirs with
  chmod 700; `exec pass-keys run goblin-mcp-dev --` is direct exec of the
  goblin lane (never the owner session, no shell after pass-keys);
  `GOBLIN_HOME` default ($HOME/goblin) matches paths.goblinHome(); the
  `--config "$goblin_home/mcporter.json"` path matches paths.mcporter() the
  gate checks; all expansions quoted, `"$@"` safe under set -u.
- **check-mcp-config:** non-object/null/array, missing imports, non-array
  imports, non-empty imports, and unparsable text all fail with
  structural-only reasons (pinned, incl. no echo of config content);
  ENOENT → recovery message; silent success; `import.meta.main` guard keeps
  the test import side-effect-free.
- **check-auth output contract (modulo being dead, P1):** bare names on
  stdout, exit 2 vs 0, values never printed — pinned by subprocess tests
  including stderr isolation.
- **log call signatures:** auth.ts's `log.warn(msg, fields)` and
  `log.error(msg, undefined, fields)` match log.ts's overloads.
- **Boot-pinning consistency:** hand-edits mid-run are invisible to the live
  store (process-local map) per design; the sanctioned writer
  (appendAuthRecord then put — index.ts:149-151, operator.ts:199-202) keeps
  file and map consistent in that order, matching the WritableAuthStore
  contract ("Callers write the file FIRST").
- **Consumers of the strict grammar** (health.ts auth probe,
  install-options.ts) fold last-wins consistently with the runtime loader.

---

## 3. Couldn't verify / untraced

- **pass-keys CLI behavior itself** — that `get` is snapshot-only (never
  warms, never network, only the value on stdout, diagnostics on stderr) and
  that `run` puts keys in the child env only and direct-execs: external repo
  (~/build/pass-keys); rules of engagement bar running pass-keys commands.
  scripts/mcp and auth.ts encode the right calls, but pass-keys' side of the
  contract is UNVERIFIED here.
- **mcporter's actual `--config` flag and `imports` merge semantics** (that
  an omitted/non-empty `imports` really merges editor defaults): external
  tool. The gate's invariant is pinned only on goblin's side of the contract.
- **Out-of-repo invocation of check-auth.ts** — no caller exists in the tree
  (searched including ignored files); a human runbook outside the repo could
  still invoke it by hand, which would not satisfy the install.sh ruling
  anyway.
- **json5 error-message leakage** — pinned only for the word "oops"
  (check-mcp-config.test.ts:37-43); I did not exhaustively prove no json5
  parse error can quote longer input fragments. mcporter.json is not a
  designated secrets file (provider auth goes through `get` records), so
  residual risk is low. Unverified beyond the pinned case.
- **No written rule found** requiring direct exec (no `/bin/sh -c`) for
  auth-record `get` commands — design requires direct exec only for the MCP
  `run` lane (scripts/mcp complies). The sh -c wrapper for `!` records is the
  documented general mechanism (auth.ts header); not reported as a finding.

---

## 4. Simplifications & code smells (P3-level, evidence-backed)

1. **Dead gate + stale comment describing it.** scripts/check-auth.ts is
   unreachable code (see P1); src/auth.ts:39's comment ("Shared with
   scripts/check-auth.ts so the install-time poison scan parses exactly like
   the loader") describes a caller that doesn't exist, and
   auth.parse.test.ts:50-102 spawns it in four subprocess tests. Either wire
   the gate into install.ts or delete the script, its comment reference, and
   the install-helper test cases.
2. **Dead defensiveness in parsePassKeysGet** (src/auth.ts:105):
   `match?.[1] === undefined || match[2] === undefined` cannot fire — both
   capture groups in PASS_KEYS_GET (auth.ts:97) are mandatory, so any
   successful match has both. `if (match === null) return null;` is exactly
   equivalent.
3. **Same poison lint, two last-wins semantics, one documented.**
   src/health.ts:399-406 and scripts/install-options.ts:16-21 fold duplicates
   last-wins "like the runtime loader" (both say so in comments);
   scripts/check-auth.ts:15-20 scans raw records and flags offenders even
   when a later clean duplicate overrides them (pinned deliberately by
   auth.parse.test.ts:77 "still refuses … even before a clean duplicate") —
   but check-auth.ts's header never states the stricter choice. The day the
   gate is wired in, a file the doctor calls clean can fail install with no
   comment in the file explaining why.
