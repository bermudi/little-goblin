# Delegation on hc

## Sub-features

`delegate start` launches the named harness in a terminal on a private,
throwaway hc core. The watcher polls terminal status until the row settles,
and a notice lands in the conversation. Handover and responsibility stay on
T3 Code — they are not exercised here (they need a real T3 project).

## How to get to it (user POV)

Launch with `GOBLIN_VERIFY_DELEGATION=1 bun run try <name>`. Goblin installs
the pinned core under the throwaway instance home and starts a private session
derived from that home. It does not connect to the operator's core or sessions.
The seeded `goblin.json5` carries a `codex` harness
(`kind:"codex"`, `args:["--model","gpt-6-luna"]` — the
operator-named test pair; real Codex runs happen, so keep prompts trivial).
Goblin adds `--no-daemon` to keep the scratch run independent of any other
Codex app server on the host. A throwaway
`CODEX_HOME` contains only an `auth.json` symlink to the operator's file.
Goblin seeds hooks and trust into that temporary home; it never changes
`~/.codex`.

Open any conversation — no project needed — and send the marker below.

## Driving it with agent-browser

The fake model answers the marker once per user message with a real tool call —
no model needed:

- `[delegate <harness> <cwd> <task>]` → `delegate {action:"start", …}`;
  `<cwd>` must be an existing dir.

```sh
ab fill '[aria-label="Message draft"]' '[delegate codex /tmp/goblin-verify-deleg Reply with exactly the word ok]'
ab click 'button[aria-label="Send"]'
ab wait --text 'delegation: #1'
```

Proof: `goblin.stdout` shows hc terminal calls, `delegation started`, and
`delegation transition … "to":"done"`; the conversation gets a
`[delegation: #id … done]` notice; `state/goblin.sqlite` has
`delegations.status='done'`; terminal output shows Codex answering `ok`.
`bun run try down <name>` stops Goblin, the fake model, and the throwaway hc
session, then trashes the instance home.

## Gotchas

- `answer`/`stop`/`send` are exercised by the unit tests
  (`src/delegation-lifecycle.test.ts` uses a fake hc adapter); the live leg
  here is start → watcher → done.
- `[handover]` cannot run here: `responsibility` mounts only in project
  conversations bound to T3 threads. Verify handover with the
  responsibility/T3 tests, not this instance.
- If Codex shows a first-run prompt, confirm the auth symlink exists in the
  throwaway `CODEX_HOME`; Goblin seeds hooks and trust there.
- The hc core outlives Goblin by design. Always run
  `bun run try down <name>` to stop the throwaway session.
- Machine targets do not exist: `delegate` has no `on`/`machine` parameter;
  a harness name is the whole target.
