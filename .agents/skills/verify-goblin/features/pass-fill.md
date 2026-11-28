# pass_fill

Drive the `pass_fill` tool on a throwaway instance — Goblin fills one
page field from a Pass item; the value never reaches the model.

## Seed

The instance's user home is `/tmp/goblin-verify/<name>/user-home`. Put
two fakes on it:

- `user-home/bin/pass-cli` — `info` prints
  `Personal Access Token [Agent] dev` (drop it to simulate an expired
  session); `item view pass://S/I/urls` prints the loopback page's URL;
  `item view pass://S/I/password` prints `FAKE-pw-123`.
- `user-home/.local/bin/pass-keys` — `login <profile>` restores the
  session marker the fake `info` reads.

Add the pass block to `goblin.json5` in the instance home, then apply it
without a restart — a config write re-reads the file:

```sh
curl -X PATCH "$URL/api/app/config" \
  -H 'content-type: application/json' -d '{"model":"fake/verify-model"}'
```

## Drive

Serve a login page on `http://127.0.0.1:<port>` (an input named `#pw`),
then open it with agent-browser **under the instance's environment** so
the tool reaches the same agent-browser session. agent-browser keeps its
session sockets under `$XDG_RUNTIME_DIR/agent-browser/`, else
`$HOME/.agent-browser/`; the instance has no `XDG_RUNTIME_DIR`, so drop it
too, or the tool talks to a second, empty `pf` session:

```sh
env -u XDG_RUNTIME_DIR HOME=/tmp/goblin-verify/<name>/user-home agent-browser --session pf open http://127.0.0.1:<port>
```

Use the same `env -u XDG_RUNTIME_DIR HOME=…` prefix for every later
`agent-browser` command in this journey.

Chat marker (last user message): `[pass_fill <ref> <target>]` or
`[pass_fill <ref> <target> <session>]` — the fake model calls `pass_fill`
with those args, then replies `verify-reply: pass_fill <tool result>`.
For the page above: `[pass_fill pass://S/I/password #pw pf]`.

## Prove

- The chat shows `{ "filled": true, "field": "password", "host": "127.0.0.1" }` — no value.
- `agent-browser --session pf get value '#pw'` (same HOME) shows the fake value.
- `rg FAKE-pw-123` over the instance's `state/` and `goblin.log` finds nothing.
