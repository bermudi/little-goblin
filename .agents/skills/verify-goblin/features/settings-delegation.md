# Settings: delegation

## Sub-features

The coding-agent table (name, herdr kind, native args — the model lives in
the args) and the role → agent defaults. Driven: add an agent, set the
`default` role, add a `review` role, remove a role, off/on parking.

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
ab select '[aria-label="agent for role default"]' 'pi'
ab fill '[aria-label="new delegation role"]' 'review'
ab find role button click --name 'Add role'
ab select '[aria-label="agent for role review"]' 'pi'
```

Proof: the savebar says `Saved.`, the block appears in
`$HOME_DIR/goblin.json5`, and the page shows
`Restart goblin to apply: delegation` (the block is boot-pinned).

## Gotchas

- Turn the master switch on first. With it off the section is a single
  switch and the tables are absent.
- An empty role makes the save refuse with `Role "review" has no coding
  agent.` Fill the select and it saves.
- Turning delegation off parks the block under `parked.delegation`;
  turning it back on writes it to the top level again. An edited block
  must leave no `parked.delegation` behind.
- Machine targets (`delegation.machines`) are file-only. Add one by hand
  to `goblin.json5`, save from the page, and it survives.
- Nothing here proves a launch. `delegate` needs herdr and a real agent
  binary, which the throwaway instance does not have.
