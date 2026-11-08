# Memory save failures - diagnostic record (2026-11-07)

Read-only diagnosis of a memory-save failure reported by screenshot. No
fixes, retries, dismissals, config edits, restarts, model calls, or
outbound probes were performed. Prod services were left untouched and
are running.

## What failed

- Local read-only SQLite `memory_outbox` state counts:
  `blocked: 10`, `completed: 68`, `dismissed: 33`, `pending: 0`,
  `submitted: 0`.
- Blocked rows span `2026-11-07T19:23:46.566Z` to `21:01:04.733Z`.
- All ten blocked operation IDs were matched individually against
  `public.async_operations` in the local Hindsight PostgreSQL
  (`BEGIN READ ONLY`): every one is `status = failed` with
  `error_message` containing `APITimeoutError: Request timed out.`.
- Journal for `goblin-memory-api.service` since 19:00 UTC shows
  retain/extraction calls failing after 4 attempts with the chain
  `openai.APITimeoutError -> httpx.ConnectTimeout ->
  httpcore.ConnectTimeout`. (Outbox `attempts` are submit/poll counts,
  not model attempts; no claim of ten model attempts.)
- Non-secret process env: `HINDSIGHT_API_LLM_PROVIDER=openrouter`,
  `HINDSIGHT_API_LLM_MODEL=openai/gpt-6-luna`,
  `HINDSIGHT_API_LLM_BASE_URL=https://openrouter.ai/api/v1`.
- `goblin-memory-api` and its DB are `active (running)`; containers
  healthy. Process health does not prove the model connection.

## Root cause

Proven: the extraction calls to the configured provider (OpenRouter,
`openai/gpt-6-luna`) timed out at connect time. The queued content is
not lost - it remains locally in the ten `blocked` rows.

Unverified: the underlying cause of the connect timeout (DNS, routing,
firewall, provider outage, etc.). No outbound probe was run.

## Observations

- `src/memory/hindsight.ts` keeps only `operation_id`/`status` per
  operation; `src/memory/queue.ts` stores a generic
  `"remote operation failed"` for a failed op, so the remote
  diagnostic detail (`APITimeoutError`) is dropped before it reaches
  the UI.
- The outbox already holds 68 `completed` rows, which contradicts the
  UI phrase "No saves recorded yet" as a global statement - but that
  phrase's scope was not investigated, so no UI bug is asserted.

## Next step (needs operator approval)

A small outbound connectivity probe from inside the memory API
container to `openrouter.ai` to investigate network vs provider
failure before retrying the blocked saves. Provider/model are
operator-pinned and unchanged.

## Evidence reproduction

- `sqlite3 -readonly <state db> "SELECT state, count(*) FROM
  memory_outbox GROUP BY state;"`
- `BEGIN READ ONLY;` then per-op SELECT on
  `public.async_operations` by `operation_id`.
- `systemctl --user show goblin-memory-api.service -p ActiveState`
  (and DB counterpart) - active states only.
- `journalctl --user -u goblin-memory-api.service --since "2026-11-07
  19:00 UTC"` - local source; may contain private content, not reproduced
  here.

## Notes

- GitHub issue not opened: operator no-network rule is in effect.
