# Settings: model services

## Sub-features

List model services and add one. Storing a key hasn't been driven yet.

## How to get to it (user POV)

Sidebar → Settings → Accounts & keys → + Add model service.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Settings"]'
ab find role button click --name 'Accounts & keys ChatGPT, model services, API keys'
ab find role button click --name '+ Add model service'
ab select '[aria-label="add a service"]' 'OpenRouter'
grep -n openrouter "$HOME_DIR/goblin.json5"
```

Proof: the service appears on the page and in the instance's `goblin.json5`.

## Gotchas

Use a made-up key unless the operator is supplying a real one. A made-up key can't prove a real model turn.
