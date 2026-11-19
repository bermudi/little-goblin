# Delegation on Herdr

## Sub-features

`delegate start` launches the named harness in a pane on a throwaway
Herdr server, the watcher polls the pane until the row settles, and a
notice lands in the conversation. Handover/responsibility stays on T3
Code — it is not exercised here (it needs a real T3 project).

## How to get to it (user POV)

Launch with `GOBLIN_VERIFY_DELEGATION=1 bun run try <name>` — instance.ts
then spawns its own `herdr --session verify-<name> server` under a
scratch `XDG_CONFIG_HOME` inside the instance home and points the
goblin child's `HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH` at it, so
the operator's Herdr sessions are never touched. The seeded
`goblin.json5` carries a `codex` harness (`kind:"codex"`,
`args:["--model","gpt-6-luna"]` — the operator-named test pair; real
codex runs happen, so keep prompts trivial) and copies the operator's
`~/.codex/auth.json` into the throwaway HOME so the pane is signed in.
Open any conversation — no project needed — and send the marker below.

## Driving it with agent-browser

The fake model answers the marker once per user message with a real
tool call — no model needed:

- `[delegate <harness> <cwd> <task>]` → `delegate {action:"start", …}`;
  `<cwd>` must be an existing dir.

```sh
ab fill '[aria-label="Message draft"]' '[delegate codex /tmp/goblin-verify-deleg Reply with exactly the word ok]'
ab click 'button[aria-label="Send"]'
ab wait --text 'delegation: #1'
```

Proof: `goblin.stdout` shows herdr workspace/agent calls, `delegation
started`, and `delegation transition … "to":"done"`; the conversation
gets a `[delegation: #id … done]` notice; `state/goblin.sqlite` has
`delegations.status='done'`; the pane scrollback under
`<home>/herdr-xdg/` shows codex answering `ok`. `bun run try down
<name>` stops goblin, the fake model and the throwaway herdr server and
trashes the home — nothing survives in the operator's Herdr.

## Gotchas

- `answer`/`stop`/`send` are exercised by the unit tests
  (`src/delegation-lifecycle.test.ts` fakes the herdr CLI at the
  process edge); the live leg here is start → watcher → done.
- `[handover]` cannot run here: `responsibility` mounts only in project
  conversations bound to T3 threads. Verify handover with the
  responsibility/t3 tests, not this instance.
- If codex shows a first-run prompt in the pane, the throwaway HOME is
  missing something `~/.codex` normally provides — copy only
  `auth.json` (done by seedHome) and `config.toml` is trust-seeded by
  goblin itself.
- The herdr server is a real process: always `bun run try down <name>`
  — a stray `verify-<name>` server keeps its panes alive.
- Machine targets do not exist: `delegate` has no `on`/`machine`
  parameter; a harness name is the whole target.
