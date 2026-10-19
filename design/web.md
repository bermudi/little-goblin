# Web access — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Web access (search, fetch, browser)

Returned on demand (2026-09-24): scheduled jobs need the outside world.
Classification: `search` and `fetch` are chat-native — an assistant that
can't look things up is a gap. The browser returns as a skill over a CLI,
not a native tool. MCP stays out, with its return conditions on record
(below).

- **`search` is one tool with a provider behind it** — the model-provider
  pattern (OpenClaw and hermes both ship one `web_search` over pluggable
  vendors). Provider switch = config edit; the tool's name, schema, and
  result shape never move — request bytes and the model's habits stay
  stable, where an MCP-provided switch would move both in front of the
  model.
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
- **Keyless paths**: jina tolerates keyless reads (rate-limited); `ddg`
  scrapes the unofficial html endpoint — it can rate-limit or break, the
  no-key default, not a promise.
- **No provider-knob mirroring** (freshness, topic, domain filters):
  recency is expressible in the query, and knobs are how fifteen search
  tools happen.
- **Search results and fetched page text ride fenced** like mail and
  event content (`fenceUntrusted`, tag `<web>`): provider words are
  untrusted data to evaluate, never instructions. The page title is the
  site's words too — it rides inside the fence. Trusted framing stays
  outside it — fetch's `Source:` line, search's fallback note, the
  `[TRUNCATED …]` recovery footer (which marks the saved overflow file
  untrusted too).
- **PDFs ride as documents, not text** (the reason goblin moved to the
  AI SDK, landed 2026-09-28): a fetched PDF is saved content-addressed
  (URL + bytes) because the ref is replayed into every later request — a
  refetch with new bytes writes a new file; URL-keying would silently
  rewrite history's request bytes (the text-overflow cache may be
  URL-keyed only because its file is a recovery aid, never replayed).
  Per turn the tool renders a native `file` part when this turn's model
  takes PDFs (catalog) *and* the pipe can carry them at tool-result
  position (`carriesMedia`, position-aware; see `design/model.md` →
  Capabilities), a trusted-framing path reference otherwise — a pure
  function of ref + bytes + this turn's model: identical request bytes
  under the same model (cache-stable), one recompute on a model switch.
  The framing marks the bytes untrusted — the fence's binary twin;
  nothing inside a PDF can displace it. Probe-verified (2026-09-27):
  z.ai's OpenAI Responses endpoint (`/api/v1`) parses `input_file`
  inside `function_call_output` — the chat-family door that carries
  tool-result documents — which is why the `zai` provider is the
  `responses` kind.
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
