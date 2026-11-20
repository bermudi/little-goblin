# Web access — goblin design

## Web access (search, fetch, browser)

Returned on demand (2026-09-24): scheduled jobs need the outside world.
Classification: `search` and `fetch` are chat-native — an assistant that
can't look things up is a gap. The browser returns as a skill over a CLI,
not a native tool. MCP stays out, with its return conditions on record
(below).

- **`search` is one local tool with a provider behind it** — the
  model-provider pattern (OpenClaw and hermes both ship one `web_search`
  over pluggable vendors). Provider switch = config edit; the tool's
  name, schema, and result shape never move — request bytes and the
  model's habits stay stable, where an MCP-provided switch would move
  both in front of the model. The codex-kind exception lives below.
- **Codex conversations use the backend's hosted `web_search` instead of
  the local `search`** (operator ruling 2026-10-29): the adapter's own
  provider tool — mode per codex provider config (`webSearch:
  "off"|"cached"|"live"`, default `live`; `external_web_access` follows
  the mode). Pages are read server-side, so result content bypasses
  Goblin's `<web>` fencing — an accepted trade-off for a first-party
  tool. Citations arrive as source parts (annotations and
  `action.sources`, deduped by url); the call is provider-executed, so
  it never reaches the journal, retry grants, or the loop detector, and
  the checkpoint's copy is skipped silently at resume. Replay: the call
  item rides as `web_search_call` at its position under the usual codex
  scope rule — the paired result part is the item itself, not a
  function_call_output. Live-verified (2026-10-30, gpt-6.1-sol,
  store:false): the replayed item is accepted, but only with its full
  wire `action` — a typeless action 400s the whole request (`Missing
  required parameter: 'input[n].action.type'`), so the tool's input
  schema is loose (the input *is* the action) and a stored action
  without a `type` drops with a warning instead of replaying.
- **Fallback chains are explicit config, never implicit.** List order is
  the walk order: first is primary, the rest are fallbacks. Transport,
  HTTP, and auth failures advance to the next entry; an EMPTY result set
  (or a structured refusal on the fetch side) is an answer from that
  provider and stops the walk — "no results" must never silently mean
  "results from whoever has any". When a non-primary answers, the result
  says so (`(via ddg — brave: HTTP 402 …)` — hermes' `served_by`,
  adopted) so the model can report it and the operator can fix the
  primary. Borrowed from hermes' `search_with_failover`; not its
  round-robin ring, seeded cursor, or fleet-spreading — no vendor the
  operator didn't write, and deterministic config order for one operator.
  No health checks, no cooldowns, no pinning: try-next-on-error is the
  whole mechanism.
- **Fetch fallback:** a local oversized or binary refusal can fall
  through to a configured provider; if none succeeds, the failure remains
  visible. Keyless endpoints can rate-limit or break. Provider-specific
  search knobs remain out.
- **Search results and fetched page text ride fenced** like mail and
  event content (`fenceUntrusted`, tag `<web>`): provider words are
  untrusted data to evaluate, never instructions. The page title is the
  site's words too — it rides inside the fence. Trusted framing stays
  outside it — fetch's `Source:` line, search's fallback note, the
  `[TRUNCATED …]` recovery footer (which marks the saved overflow file
  untrusted too).
- **PDFs ride as a path, never inline** (operator, 2026-11-15; replaces
  the 2026-09-28 native-document rendering): a fetched PDF is saved
  content-addressed (URL + bytes) — a refetch with new bytes writes a new
  file, so a replayed ref never changes meaning. The tool result is the
  source URL plus the saved path; the model reads it with bash
  (`pdftotext`) or hands it over with `send_file`. A file part would ride
  every later request in the history; a tool read takes only what the
  model needs. The rendering no longer depends on the model, so a model
  switch does not change it.
- **No silent dead ends** (hermes' `web_extract`, adopted): an unsupported
  type, an oversized body, or a JS-shell page refuses with its named
  recovery (browser skill for JS shells; bash otherwise); overflow reads
  are footer-named with the exact `read_file` call — never a silent
  empty result.
- **No SSRF policy — recorded as a ruling.** `bash` already has full
  network access, so pretending `fetch` is a boundary is security theater;
  the boundary is the tool set, same as `bash`. Loopback/LAN fetches are
  legal (the local bot-api server is fair game). The ruling covers the
  personal toolset, whose callers have `bash`; sandbox guests get no
  `fetch` at all (`design/telegram.md` → Guest mode) — the premise does
  not extend to them.
- **Auth never enters tool env** (the standing rule): the search/fetch key
  is resolved lazily in-process at the point of use, exactly like provider
  keys.
- **The browser is a skill, not a tool.** goblin authors
  `skills/browser/SKILL.md` over the `agent-browser` CLI: the CLI owns
  the browser lifecycle; bash is the channel. It is the same CLI hermes'
  default local browser mode drives; owning browser lifecycle in-process
  costs openclaw nine doc pages — goblin borrows the capability, not the
  machinery. The operator-browser attach mode (pin-tab, never close
  operator tabs, never read credentials) is carried in the skill. Install
  as a config knob stays out, as everywhere else. If the model fumbles
  CLI ergonomics in practice, a thin native `browser` tool wrapping the
  same CLI arrives — designed then, with evidence. Not now.
- **MCP returns as a skill over goblin's own mcporter** (operator ask,
  2026-09-26; a native in-process client was weighed and rejected). The
  original return conditions, and how this shape meets them: (1) stdio
  secrets via env — the keys ride `pass-keys run goblin-mcp-dev` into
  mcporter's child env only, never goblin's process env; (2) dynamic
  schemas drift the request prefix — goblin's tool set doesn't move at
  all, MCP tools are reached through `bash`; (3) 5–50 tools per server —
  discovery on demand (`list <server> --schema`) is the free tool-search
  both references built.
- **Goblin owns its mcporter; it never rides the host's** — the pinned
  dependency, its own config, its own keys (`goblin-mcp-dev`), and the
  repo's one entry point (`scripts/mcp`: gate → pass-keys run → pinned
  mcporter `--config`). The server set is config, not code.
- **Imports stay off by gate, not by convention.** mcporter merges editor
  imports (Cursor, Claude, Codex, …) unless the config carries
  `"imports": []` — verified in its sources: an omitted key loads every
  editor default, and a non-empty list appends the omitted defaults after
  it — either way the operator's editor servers leak in.
  `scripts/mcp` gates every call — anything but `[]` fails loud; a missing
  config fails with its recovery instead of falling back onto host state
  (an explicit `--config` never merges).
- **No daemon, by mechanism**: every server is ephemeral; per-call spawn
  is the accepted cost, and the skill forbids `daemon`/`serve`.
- **The `goblin-mcp-dev` profile starts empty with its own snapshot** —
  grown only by owner action (`pass-keys add goblin-mcp-dev`).
  `scripts/mcp` reads the local snapshot: no Pass/network fallback;
  missing or locked snapshots fail loud; no auto-unlock assumed for the
  persistent wallet. See [Auth](auth.md#proton-pass-2026-09-26).
- **Known limits, accepted**: MCP 2.0 elicitation (a server pausing a
  call to ask) is declined from a non-TTY; sampling and server
  notifications aren't bridged; a spawn per call without the daemon. A
  native client returns only when one of these bites with evidence —
  mcporter.json carries over unchanged.
