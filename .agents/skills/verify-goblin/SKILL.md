---
name: verify-goblin
description: Run this checkout of goblin on a throwaway instance and drive the real app to prove a change works, or give the operator a link to try it. Use before opening a PR, when reproducing an app bug, or when anyone needs to try a branch. Covers the web app. Never touches the real home, the service or Telegram.
---

# verify-goblin

Prove a change by using the real app, the way the operator would.

## Launch

From the root of the checkout you changed:

```sh
bun run try <name>      # defaults to "default"
```

It installs dependencies and builds the app if needed, boots goblin, waits until the client and API both answer, and prints the URL on stdout. A cold start takes a few seconds. Names are lowercase letters, digits and dashes. Use your branch or issue as the name.

Each instance gets:

- Its own `GOBLIN_HOME` and `HOME` under `/tmp/goblin-verify/<name>`, created empty.
- A free loopback port.
- A scripted fake model that replies `verify-reply: <last user message>`.
- A minimal environment. The checkout's `.env` is not loaded.
- Telegram, TTS, memory, delegation and mail off.

Several instances can run side by side. It does still fetch public model catalogs at boot.

A real model turn needs a real key. Add it under Settings → Accounts & keys in the throwaway instance. Only the operator does this, and only if the change depends on it. Never copy keys or `auth.jsonl` from the real home.

## Doctor

```sh
bun run try status <name>
```

Read-only. It checks both processes are ours, the home isn't the real one, the checkout is still at the commit it booted from, and the app and API answer. Run it first whenever something looks off. A commit failure means the instance is stale: take it down and launch again.

## Drive

Use `agent-browser` with a session named after the instance. It's headless and has its own profile. See the `agent-browser` skill for the full command list.

```sh
URL=$(bun run --silent try <name>)
ab() { agent-browser --session "verify-<name>" "$@"; }
HOME_DIR=/tmp/goblin-verify/<name>
ab set viewport 1280 800
ab open "$URL"
ab fill '[aria-label="Message draft"]' 'hello'
ab click 'button[aria-label="Send"]'
ab wait --text 'verify-reply: hello'
```

Use `aria-label`s and accessible names, not coordinates. `ab snapshot -i` lists what's on the page. Dialogs put a veil over the app, so close them before clicking anything behind them.

[features/README.md](features/README.md) lists how to reach and drive each feature.

The database is at `/tmp/goblin-verify/<name>/state/goblin.sqlite`. Open it with `sqlite3 -readonly`. Logs are `state/goblin.log` and `goblin.stderr` in the same home, and `fake-model.log` lists every request the model got.

## Evidence

Save everything in `~/.cache/goblin-verify/evidence/<name>/`:

```sh
E=~/.cache/goblin-verify/evidence/<name>
ab record start "$E/feature.webm"   # before the first action
ab screenshot "$E/feature.png"      # at the resulting state
ab record stop
```

What counts:

- The real user path, not internal setters or direct API calls that skip the UI being changed.
- The action and the resulting state, not only the final screen.
- Side effects next to what's visible: the row in the database, the file written, the log line.
- The fake model only stands in for the provider. If a change depends on real model behaviour, say the fake can't prove it.
- Say what you didn't check.

For a backend change with no UI, drive the HTTP route the app uses and capture the response plus the side effect.

## Handing it to the operator

The PR says what you ran and what happened, with the evidence. To offer a way to try it, either leave the instance running and give the URL plus `bun run try down <name>`, or give one command:

```sh
bun run try <name>
```

The operator can open the URL directly in a browser on this machine. Tell them what to click first.

## Cleanup

```sh
agent-browser --session "verify-<name>" close
bun run try down <name>
bun run try list        # nothing of yours should still say "running"
```

`down` stops only the processes it started and moves the instance's scratch home to the trash. Evidence stays. Clean up after failed runs too, unless you're leaving the instance for the operator.

If `try` reports stale state, `down` clears it. If boot fails, the error shows the scratch path and stderr.

## Maintaining this

When you change something on a mapped path, update its feature file in the same PR. If a journey can't pass because the seed lacks something, record that under Gotchas. Never weaken a journey to make it pass.
