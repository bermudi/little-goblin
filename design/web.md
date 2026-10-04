# Web access — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Web access (search, fetch, browser)

Returned on demand (2026-09-24): scheduled jobs answering "brief me on X"
need the outside world. Classification: `search` and `fetch` are
chat-native — a personal assistant that can't look things up is a gap
against this doc. The browser returns as a skill over a CLI, not a native
tool. MCP stays out, with its return conditions on record (below).

- **`search` is one tool with a provider behind it** — the model-provider
  pattern. OpenClaw, which also has MCP, still ships a generic `web_search`
  with vendors plugged in behind it (plus a dozen per-vendor tools); hermes
  kept one `web_search` with eleven backends. One tool it is: provider
  switch = config edit, and the tool's name, schema, and result shape never
  move — request bytes and the model's habits stay stable. Swapping
  providers via MCP would swap tool names and schemas in front of the
  model; the flexibility argument inverts.
- **Config**: optional `search` block (absent or `""` → tool absent):
  `{kind, auth?}` with kinds
  `brave|exa|jina|tavily|firecrawl|parallel|ddg`, or an ordered list of
  such entries — the fallback chain. `auth` is an auth.jsonl ref,
  required for every kind but jina (keyless tolerated, rate-limited) and
  ddg (keyless — the unofficial html endpoint; it can rate-limit or
  break, it's the no-key default, not a promise). Enabling/disabling the
  block is a deploy-time cache boundary, logged.
- **Fallback chains are explicit config, never implicit.** A list entry
  order is the walk order: first is primary, the rest are fallbacks.
  Transport, HTTP, and auth failures advance to the next entry; an EMPTY
  result set (or a structured refusal on the fetch side) is an answer
  from that provider and stops the walk — "no results" must never
  silently mean "results from whoever has any". Every failed attempt
  logs its own line; when the answer comes from a non-primary provider,
  the result says so (`(via ddg — brave: HTTP 402 …)` — hermes'
  `served_by`, adopted) so the model can tell the operator and the
  operator can fix the primary. Borrowed from hermes'
  `search_with_failover`; NOT borrowed: its round-robin ring, seeded
  cursor, and fleet-spreading — one operator gets deterministic config
  order, and no vendor is ever injected that the operator didn't write.
  No health checks, no cooldowns, no pinning: try-next-on-error is the
  whole mechanism.
- **Wire formats** follow hermes' plugins/web (brave and tavily verbatim)
  and the vendors' own SDK wire paths, checked against the SDK sources:
  exa `POST api.exa.ai/search` (`x-api-key`), parallel
  `POST api.parallel.ai/v1/search` + `/v1/extract` (Bearer), firecrawl
  `POST api.firecrawl.dev/v2/search` + `/v2/scrape` (Bearer), jina
  `s.jina.ai` / `r.jina.ai` (Bearer, keyless tolerated).
- **Input**: `{query, count?}` zod-validated, count default 5 cap 10. No
  provider-knob mirroring (freshness, topic, domain filters): recency is
  expressible in the query, and knobs are how fifteen search tools happen.
- **Output is deterministic text**: numbered `title — URL — snippet` lines.
  Provider answer-fields and full-content payloads are dropped at the
  boundary; snippets bounded by the read/bash truncation discipline
  (complete lines, byte ceiling, recovery named: re-query narrower or
  `fetch` a result URL). Every result carries its URL — fetch is the named
  next step.
- **Search results and fetched page text ride fenced** like mail and
  event content (`web.ts`'s `fenceUntrusted`, tag `<web>`): provider
  words are untrusted data to evaluate, never instructions. The page
  title is the site's words too — it rides inside the fence, clamped
  like search titles. Only fetch's `Source:` line, search's fallback
  note, and the `[TRUNCATED …]` recovery footer stay outside it (the
  recovery instruction is trusted text), and the footer marks the
  saved overflow file untrusted too.
- **`fetch` is always in the set** — default `local`, no config, no key:
  direct HTTP (20s timeout, 8 MiB cap) + in-process readability
  extraction (`@mozilla/readability` over `linkedom` — pure JS, the
  industry path). An optional `fetch` block selects a server-side
  extractor instead: `{kind: "jina"|"tavily"|"firecrawl"|"parallel",
  auth?}` — or an ordered chain of such entries plus `local`, the same
  list rule as search (`[{kind: "parallel", auth: "parallel"},
  {kind: "local"}]` is the resilient default shape: paid extraction
  with a free direct fallback). The per-capability split hermes ships:
  search and fetch providers are chosen independently (brave for search,
  parallel for extract, say). Both paths share one output discipline. Input `{url,
  maxChars?}`; local does content-type dispatch — HTML → readability,
  text-ish (text, markdown, json, csv, xml) → raw, PDF → native handoff
  (below), anything else → structured refusal naming recovery (`bash` +
  file tools, or `send_file` to put it in the operator's hands).
- **PDFs ride as documents, not text** (the reason goblin moved to the
  AI SDK, landed 2026-09-28): a fetched PDF is saved to
  `state/webcache/<sha>.pdf` under the durable write — content-addressed
  (URL + bytes), because the ref is replayed into every later request:
  a refetch that brought new bytes writes a new file and old tool
  results keep reading the old bytes; URL-keying would silently rewrite
  history's request bytes (the text-overflow cache is URL-keyed only
  because its tool result is the window string — the file is a recovery
  aid, never replayed). The
  tool result stores only a small ref — path, url, size, never the payload.
  At request time the tool's `toModelOutput` decides per turn: a native
  `file` part inside the tool result when this turn's model takes PDFs
  (catalog) *and* the provider pipe can carry them (`carriesMedia`, see
  Capabilities), a trusted-framing path reference otherwise — the
  bash/`send_file` recovery, with the file already on disk. Same
  discipline as attachments: the decision is a pure function of the
  ref + bytes + this turn's model, so the same history renders to
  identical request bytes under the same model (cache-stable), and a
  model switch recomputes once. The wire path is probe-verified
  (2026-09-27, glm-5.3-flash read a marker PDF through every position):
  z.ai's OpenAI Responses endpoint (`/api/v1`) parses `input_file`
  inside `function_call_output` — the chat-family door that carries
  tool-result documents (OpenRouter's normalizer maps them too;
  openai-compatible stringifies tool-result content and codex filters
  it to text, so `carriesMedia` is position-aware) — which is why the
  `zai` provider is the `responses` kind. Chat-completions and
  Anthropic endpoints carry
  user-message documents fine. The framing text around the bytes marks
  them untrusted — the fence discipline's binary twin; nothing inside
  a PDF can displace it.
- **Overflow goes to disk, recovery named** (hermes' `web_extract` rule,
  adopted): default 15k-char head+tail window (~75/25, cut on line
  boundaries) with a `[TRUNCATED n chars]` footer; the full extracted text
  lands in `$GOBLIN_HOME/state/webcache/<sha>.txt` and the footer names the
  absolute path plus the exact `read_file` call to page through the middle.
  Near-empty extraction from a JS shell says so and names the browser as
  the recovery path — never a silent empty result.
- **No SSRF policy — recorded as a ruling.** `bash` already has full
  network access, so pretending `fetch` is a boundary is security theater;
  the boundary is the tool set, same as `bash`. Loopback/LAN fetches are
  legal (the local bot-api server is fair game).
- **Auth never enters tool env** (the standing rule): the search key is
  resolved lazily in-process at the point of use, exactly like provider
  keys.
- **Logging**: one line per external call — search logs provider, query,
  count, duration, status; fetch logs url, status, content-type, bytes,
  extraction outcome, truncated flag, duration. Failures surface as tool
  errors, never silent empties.
- **The browser is a skill, not a tool.** goblin authors
  `skills/browser/SKILL.md` over the `agent-browser` CLI: hermes' default
  local browser mode drives that same CLI, and openclaw's nine doc pages
  (dedicated profile, port collisions, orphan sweeps, login management,
  loopback auth) are the price of owning browser lifecycle in-process —
  goblin borrows the capability, not the machinery. The CLI owns headless
  Chrome, accessibility snapshots with `@eN` refs, sessions, and idle
  shutdown; bash is the channel. The SKILL.md is a thin stub pointing at
  `agent-browser skills get core` — the CLI serves version-matched
  instructions, so the stub never rots. The skill ships with the repo
  (`deploy/skills/browser/SKILL.md`, seeded write-if-absent at first
  boot): capability plumbing is not agent memory — a rebuilt box regains
  the skill, and once seeded the workspace copy is goblin's to evolve.
  The dependency + recovery command ride the `compatibility` frontmatter
  line, which the system prompt's catalog renders every turn — a missing
  CLI is never a dead-end invitation, and the operator never has to be
  the one to mention it. Install as config knob stays out for the same
  reason as every other knob. The operator-browser attach mode (pin-tab, never close
  operator tabs, never read credentials) is carried in the skill now, for
  the day a box with a display wants it. If the model fumbles CLI
  ergonomics in practice, a thin native `browser` tool wrapping the same
  CLI arrives — designed then, with evidence. Not now.
- **MCP returns as a skill over goblin's own mcporter** (operator ask,
  2026-09-26; a native in-process client was weighed and rejected).
  The original return conditions, and how this shape meets them:
  (1) stdio servers take secrets via env — the keys ride `pass-keys run
  goblin-mcp-dev` into mcporter's child env only, never goblin's process
  env; (2) dynamic schemas drift the request prefix — goblin's tool set
  doesn't move at all, MCP tools are reached through `bash`; (3) 5–50
  tools per server — discovery is on demand (`list <server> --schema`),
  which is the tool-search both references built, for free.
- **Goblin owns its mcporter; it never rides the host's.** mcporter is
  a pinned goblin dependency (bun.lock → `node_modules/.bin/mcporter`),
  its config is `$GOBLIN_HOME/mcporter.json` (standard `mcpServers`
  shape, env placeholders only, seeded write-if-absent with zero
  servers), its keys are the `goblin-mcp-dev` pass-keys profile (goblin's
  token, see Auth), and the repo ships the one entry point
  (`scripts/mcp`: gate → pass-keys run → pinned mcporter `--config`),
  reachable as `$GOBLIN_HOME/mcp` (a boot-refreshed symlink — the
  workspace can't see the repo; a real file there is never clobbered).
  The skill ships like the browser's
  (`deploy/skills/mcp/SKILL.md`, seeded write-if-absent) and carries
  the two-timeouts rule (mcporter `--timeout` strictly under the bash
  timeout, or the kill is silent). The server set is config, not code.
- **Imports stay off by gate, not by convention.** mcporter 0.13.13's
  switch is `"imports": []` in the config — verified in its sources:
  an omitted key loads every editor default (Cursor, Claude, Codex,
  …), and a non-empty list appends the omitted defaults after it, so
  either silently widens goblin's tool surface to the operator's
  editors. The seed carries `[]`, and `scripts/mcp` runs
  `scripts/check-mcp-config.ts` before every call — anything but `[]`
  fails loud, and a missing config fails with its recovery instead of
  falling back onto host state (an explicit `--config` never merges).
- **No daemon, by mechanism.** `scripts/mcp` exports
  `MCPORTER_DISABLE_KEEPALIVE=*` — every server is ephemeral, so the
  keep-alive daemon is never contacted and per-call spawn is the
  accepted cost. `MCPORTER_DAEMON_DIR` under
  `$GOBLIN_HOME/state/mcporter` backstops it (even an explicit
  `daemon` command through the shim lands there, never the host
  singleton), and `XDG_DATA_HOME`/`XDG_CACHE_HOME` under the same root
  keep OAuth tokens and schema caches out of `~/.mcporter`, where
  same-named host servers would collide. The skill forbids
  `daemon`/`serve` outright.
- **The `goblin-mcp-dev` profile starts empty and stays warm.**
  Refs-mode, goblin's token, session shared with the `goblin-dev` profile
  (one agent-lane lock serializes both), own tmpfs cache — empty until
  the first MCP server needs a key, grown with `pass-keys add
  goblin-mcp-dev` (owner action, like every grant). pass-keys warms an
  explicitly empty refs profile vacuously and `run` execs with no
  added env (2026-09-26); the key warmer covers both profiles, so the
  first MCP call after boot is a tmpfs read like every other resolve.
- **Known limits, accepted**: MCP 2.0 elicitation (a server pausing a
  call to ask) is declined from a non-TTY; sampling and server
  notifications aren't bridged; stdio servers pay a spawn per call
  without the daemon. A native client returns only when one of these
  bites with evidence — mcporter.json carries over unchanged.

