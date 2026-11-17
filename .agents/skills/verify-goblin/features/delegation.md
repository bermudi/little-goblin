# Delegation on T3 Code

## Sub-features

`delegate start` launches a T3 Code thread, the watcher polls `t3 thread
show` until the row settles, and `responsibility accept` binds that thread
so the observer watches it. No Herdr anywhere — the transport is the `t3`
CLI only.

## How to get to it (user POV)

Launch with `GOBLIN_VERIFY_DELEGATION=1 bun run try <name>` — the seeded
`goblin.json5` then carries a `codex`/`gpt-6-luna` harness (the
operator-named test pair; real codex runs happen, so keep prompts trivial).
Create a project whose `dir` is a throwaway git dir registered with
`t3 project add`, open a conversation in it, and send the markers below.

## Driving it with agent-browser

The fake model answers each marker once per user message with a real tool
call — no model needed:

- `[delegate <harness> <cwd> <task>]` → `delegate {action:"start", …}`;
  `<cwd>` must be an existing dir inside the T3 project.
- `[handover]` → `responsibility {action:"accept", …}` binding the thread
  id found in the newest tool result. Send it in the same project
  conversation after a delegate start.

```sh
ab fill '[aria-label="Message draft"]' '[delegate codex /tmp/goblin-verify-t3 Reply with exactly the word ok]'
ab click 'button[aria-label="Send"]'
ab wait --text 'delegation: #1'
```

Proof: `goblin.stdout` shows `t3 call` lines for `thread start`/`thread
show`/`thread list`, `delegation started`, and `delegation transition …
"to":"done"`; the conversation gets a `[delegation: #id … done] Thread:
<link>` notice; the project page shows the responsibility as `WORKING …
(attached)`; `state/goblin.sqlite` has `delegations.status='done'` and an
attachment with `target.server='t3'`. `rg -i herdr` over the instance's
logs is empty.

## Gotchas

- The T3 project and its threads are real: remove the project
  (`t3 project remove <id>`) and trash the scratch git dir when done.
- `[handover]` needs a project conversation — the `responsibility` tool
  only mounts where `projectId` is set.
- T3 v0.1.9 has no stop verb: a live delegation's `stop` reports
  unavailable by design; let the trivial run finish instead.
