# Settings: delegation

## Sub-features

The coding-agent table (name, herdr kind, native CLI args), the
per-agent "Ask me first" flag (`askFirst` — goblin asks
before each use). Driven: add an agent, off/on parking.

The page regression tests cover all four off → save → reload → on
combinations of the Delegation and Capabilities switches. They check the
park marker, both switches staying off after a fresh mount, and restored
kind/args/ask-first. Their settings
GET/POST responses are fixtures; the route tests cover the parking write.

## How to get to it (user POV)

Sidebar → Settings → Delegation → switch "delegate to coding agents" on.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Settings"]'
ab find role button click --name 'Delegation Coding agents'
ab click 'button[aria-label="delegation"]'
ab find role button click --name '+ Add a coding agent'
ab fill '[aria-label="Name"]' 'codex'
ab fill '.del-harness .del-grid .frow:nth-of-type(2) input' 'codex'
ab fill 'textarea[id^="del-args-"]' '--model\ngpt-6-luna'
ab click 'button[aria-label="ask first for codex"]'
```

(Name and Kind share `placeholder="pi"` and Field emits no aria-label —
Kind is the second `.frow` inside `.del-grid`.)

Proof: the savebar says `Saved.`, the block appears in
`$HOME_DIR/goblin.json5` as `harnesses.codex = {kind:"codex",
args:["--model","gpt-6-luna"], askFirst:true}` — a ticked "Ask me first"
lands as `askFirst: true` on that harness — and the page shows
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
- Machine targets are gone for good: no `machines` block, no `on`
  parameter. The T3 shape (`provider`/`model`/`options`) is rejected at
  boot with a message naming the `{kind, args}` fix — see config tests.
- Args is one native CLI flag per line; the textarea joins them into
  the harness's `args` array on save.
- Nothing here proves a launch. `delegate` needs a running Herdr
  server — see delegation.md for the throwaway-server drive.

To check restoration after a page reload, wait for `Saved.` after setup,
then switch delegation off and wait for `Saved.` again. Reload the page.
Both Settings → Delegation and Settings → Capabilities must show it off.
Enable it from Capabilities, wait for `Saved.`, then open Delegation:
the agents, kinds, args and ask-first flags must be back. Repeat
with the sections swapped. Check `goblin.json5` after each save: off has
only `parked.delegation`; on has only the active `delegation` block.
