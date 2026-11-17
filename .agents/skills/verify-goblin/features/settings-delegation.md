# Settings: delegation

## Sub-features

The coding-agent table (name, T3 provider instance, T3 model slug), the
per-agent "Ask me first" flag (`askFirst` — goblin asks
before each use), and the role → agent defaults. Driven: add an agent,
set the `default` role, add a `review` role, remove a role, off/on
parking.

The page regression tests cover all four off → save → reload → on
combinations of the Delegation and Capabilities switches. They check the
park marker, both switches staying off after a fresh mount, and restored
provider/model/ask-first/defaults. Their settings
GET/POST responses are fixtures; the route tests cover the parking write.

## How to get to it (user POV)

Sidebar → Settings → Delegation → switch "delegate to coding agents" on.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Settings"]'
ab find role button click --name 'Delegation Coding agents and defaults'
ab click 'button[aria-label="delegation"]'
ab find role button click --name '+ Add a coding agent'
ab fill '[aria-label="Name"]' 'codex'
ab fill '[aria-label="provider for codex"]' 'codex'
ab fill '[aria-label="Model"]' 'gpt-6-luna'
ab click 'button[aria-label="ask first for codex"]'
ab select '[aria-label="agent for role default"]' 'codex'
ab fill '[aria-label="new delegation role"]' 'review'
ab find role button click --name 'Add role'
ab select '[aria-label="agent for role review"]' 'codex'
```

Proof: the savebar says `Saved.`, the block appears in
`$HOME_DIR/goblin.json5` — a ticked "Ask me first" lands as
`askFirst: true` on that harness — and the page shows
`Restart goblin to apply: delegation` (the block is boot-pinned).

## Gotchas

- Turn the master switch on first. With it off the section is a single
  switch and the tables are absent.
- A role left on `— none —` is absent, not invalid — the editor never
  blocks a save on an empty role, and `— none —` clears an existing
  default.
- Turning delegation off parks the block under `parked.delegation`;
  turning it back on writes it to the top level again. An edited block
  must leave no `parked.delegation` behind.
- Machine targets are gone. An old-shape block (`kind`, `args`,
  `machines`) logs a warning naming the rewrite and boots without
  `delegate`.
- Nothing here proves a launch. `delegate` needs a running T3 Code
  server. Launch only into a throwaway git dir registered with
  `t3 project add` (remove it after), on codex `gpt-6-luna`; never
  into the operator's projects or threads.

To check restoration after a page reload, wait for `Saved.` after setup,
then switch delegation off and wait for `Saved.` again. Reload the page.
Both Settings → Delegation and Settings → Capabilities must show it off.
Enable it from Capabilities, wait for `Saved.`, then open Delegation:
the agents, providers, models, ask-first flags and role defaults must be back. Repeat
with the sections swapped. Check `goblin.json5` after each save: off has
only `parked.delegation`; on has only the active `delegation` block.
