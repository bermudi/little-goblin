# Operations

Running the bot week to week: the service, the logs, backups, and what to
do when something's off.

## The service

One Bun process, managed as a systemd user unit. It restarts on failure
(5-second delay, never gives up — a phone-only operator can't run
`reset-failed`), starts on boot, and stops gracefully on `SIGTERM`.

```sh
systemctl --user status goblin    # is it alive?
systemctl --user restart goblin   # restart (e.g. after hand-editing config)
journalctl --user -u goblin -f    # live logs
```

After changing `goblin.json5` **by hand**, restart. (Saves from the Telegram
Settings mini app apply immediately — no restart.) Re-running
`scripts/install.sh` after a `git pull` refreshes the unit file with your
current paths.

If the optional memory stack is installed, it takes care of itself: it
starts on boot with goblin, and a 5-minute timer (`goblin-memory-watch.timer`)
restarts the API if its health probe reports the container unhealthy. Stopping
the stack by hand is deliberate — nothing will start it again until you do.
When the retention chain cannot reach the service for a continuous hour,
the bot says so **once** in the affected topic and keeps queueing locally;
nothing is lost while it is down. `/memory status` reports detail on demand.

Shutdown is graceful with a 10-second budget: in-flight replies are cut off
cleanly (the chat shows `⏹ superseded`), buffered-but-unsent messages are
still recorded in history, then the process exits. A crash mid-reply leaves
the same shape minus the flush — your message is in history, so the next
turn just answers it. The bot never auto-retries after a crash: replaying
half-run tool calls would be worse than asking again.

## Deploying to lithium

Prod is lithium — a clone of GitHub `bermudi/little-goblin` at
`~/build/little-goblin`, running the same `goblin.service` plus the
memory stack. g7 is the dev tree; the two talk only through GitHub.
Updating prod is one command from g7:

```sh
scripts/deploy.sh
```

It refuses a dirty tree, runs the gate (`bun run typecheck && bun test`)
on g7, pushes the branch to GitHub, then on lithium: `git pull
--ff-only`, `bun install --frozen-lockfile` when `bun.lock`/
`package.json` moved, `bun run app:build` when `app/` moved (the client
is served from disk — client and backend restart as one rollout), and
`systemctl --user restart goblin`. It verifies the unit came back,
scans the fresh journal for error lines, and prints the old→new hashes
plus a one-line rollback (`git reset --hard <old-hash>` + restart, on
the box). A gate or push failure stops everything before lithium is
touched.

The memory stack is **not** auto-deployed: a `deploy/memory/` change
prints a note instead. Its assets are installed per-box — `python3
deploy/memory/install.py` re-runs the asset refresh (`start.py` /
`healthcheck.py` re-copied; installed quadlets never overwritten —
they're operator-editable). Quadlet changes apply by hand: edit the
installed file in `~/.config/containers/systemd/`, then
`systemctl --user daemon-reload`, `podman rm -f goblin-memory-api`,
`systemctl --user restart goblin-memory-api` — the `podman rm` is what
recreates the container under the new spec.

## Logs

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

## Backups

Everything worth keeping is under `~/goblin/`:

| What | Where | Notes |
|---|---|---|
| Conversations + history | `state/goblin.sqlite` | SQLite, WAL mode — copy it while the bot is stopped, or use `sqlite3 goblin.sqlite ".backup main backup.sqlite"` live |
| Settings | `goblin.json5` | plain text |
| Secrets | `auth.jsonl` | guard this copy like the original |
| Identity, notes, skills, attachments | `workspace/` | plain files |

The checkout itself (`little-goblin/`) holds no state — re-cloneable any time.

Peeking at history directly is fine (read-only!): the `conversations` table
holds one row per topic/chat, `events` holds the messages as JSON. But
treat the database as the bot's memory, not an editing surface — write to
it only while the bot is stopped, if ever.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service crash-loops or won't start | `journalctl --user -u goblin` — startup errors name the file and the problem (missing config/auth, JSON5 typo, unknown provider, bad `auth.jsonl` line) |
| `insecure permissions … chmod 600` | `chmod 600 ~/goblin/auth.jsonl` — group/world-readable secrets are refused, not warned about |
| `no secret named "…"` | `auth.jsonl` needs a record matching every provider `auth` name (and `transcription.auth`) plus `telegram` |
| Secret command fails | If it uses `pass-keys`, check `pass-keys status goblin-dev` and `journalctl --user -u goblin-keys`; fix the profile or item grant, then run `pass-keys warm goblin-dev`. Don't print the secret while debugging. The service `PATH` covers `~/bin` and `~/.local/bin` |
| Bot runs but never answers | your user id in `allowedUsers`? The log shows `rejected user` with the id. DM `@userinfobot` to confirm yours |
| Settings button missing/stale | `publicUrl` in config; mini-app saves apply it without restart, hand-edits need one |
| Mini app won't load / `load failed: 401` | open it from the Telegram menu button (not a bare browser tab); logins older than a day expire — close and reopen |
| `config would remove your own telegram user id` | the save you're attempting drops your id from `allowedUsers` — fix the field, save again |
| Voice notes the model "can't hear" | `transcription` unset, or its provider was down — the log says which; the file itself is still in `attachments/` |
| `/memory` says degraded — blocked retention(s) | a retention failed permanently (e.g. provider credit ran out). `/memory` lists the short doc id + error; `/memory retry` resends with a fresh operation id (replays of the old one are dead server-side), `/memory dismiss` drops it (kept for audit). The mini-app memory tab shows the same status. The affected topic got one notice when it first blocked |
| `/app/` answers 500 / "app client not built" | run `bun run app:build` in the checkout — the client is a build artifact (`app/dist`), absent on a fresh clone and stale after `git pull` |
| `/app/` asks for a token you didn't expect | the server is in bearer mode — `appToken` is set in `goblin.json5`; paste the value of the `auth.jsonl` record it names. Never had a token? `appToken` was probably just added — it's boot-pinned, so a running process ignores the change until restart |
| `/app/` shows "The stored token stopped working" | the `auth.jsonl` record's value rotated (rotation needs a goblin restart to take) — the app's own "Paste a new token" door clears it |
| All speech synthesis suddenly fails | the Edge endpoint is unofficial and drifts — check the log, then update the bot |
| `ffmpeg` warnings at boot | install `ffmpeg` — voice features and large-file transcription need it |
| Thinking levels look wrong for a model | capability catalogs (models.dev, OpenRouter) refresh daily and are cached in `state/` — a failed fetch warns and falls back safely; it heals itself |

Can't pin it down? Grab the last few hundred lines of `~/goblin/state/goblin.log`
around the incident — that's the whole story by design — and paste the
relevant bit to the bot in chat.
