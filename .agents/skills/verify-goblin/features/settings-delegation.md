# Settings: delegation

## Sub-features

The coding-agent table (name, herdr kind, native args — the model lives in
the args), the per-agent "Ask me first" flag (`askFirst` — goblin asks
before each use), and the role → agent defaults. Driven: add an agent,
set the `default` role, add a `review` role, remove a role, off/on
parking.

The page regression tests cover all four off → save → reload → on
combinations of the Delegation and Capabilities switches. They check the
park marker, both switches staying off after a fresh mount, restored
args/ask-first/defaults, and machine-side role choices. Their settings
GET/POST responses are fixtures; the route tests cover the parking write.

## How to get to it (user POV)

Sidebar → Settings → Delegation → switch "delegate to coding agents" on.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Settings"]'
ab find role button click --name 'Delegation Coding agents and defaults'
ab click 'button[aria-label="delegation"]'
ab find role button click --name '+ Add a coding agent'
ab fill '[aria-label="Name"]' 'pi'
ab fill '[aria-label="Kind"]' 'pi'
ab fill '[aria-label="Args — native CLI flags, one per line"]' '--model
zai/glm-5.3'
ab click 'button[aria-label="ask first for pi"]'
ab select '[aria-label="agent for role default"]' 'pi'
ab fill '[aria-label="new delegation role"]' 'review'
ab find role button click --name 'Add role'
ab select '[aria-label="agent for role review"]' 'pi'
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
- Machine targets (`delegation.machines`) are file-only. Add one by hand
  to `goblin.json5`, save from the page, and it survives — including a
  park → re-enable round trip. Machine-side harness names are offered in
  the role selects as `<name> (machine)`.
- Nothing here proves a launch. `delegate` needs herdr and a real agent
  binary, which the throwaway instance does not have.

To check restoration after a page reload, wait for `Saved.` after setup,
then switch delegation off and wait for `Saved.` again. Reload the page.
Both Settings → Delegation and Settings → Capabilities must show it off.
Enable it from Capabilities, wait for `Saved.`, then open Delegation:
the agents, args, ask-first flags and role defaults must be back. Repeat
with the sections swapped. Check `goblin.json5` after each save: off has
only `parked.delegation`; on has only the active `delegation` block.
