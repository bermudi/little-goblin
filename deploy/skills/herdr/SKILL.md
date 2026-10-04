---
name: herdr
description: >
  Herdr — the terminal multiplexer that hosts delegated coding agents.
  Your session is `goblin` and you drive it through the `delegate`
  tool, never the raw CLI. Read this before touching herdr.
metadata:
  version: "1.0"
  topic: delegation
---

# herdr

Herdr organizes terminals into workspaces, tabs, and panes, and
recognizes the coding agents running inside them. This file covers how
herdr fits *you* — it is not the usage guide (`herdr --skill` prints
that, written for agents running inside panes; you are never inside
one — you are a client that owns one named session).

**Never run `herdr` from bash — full stop.** Everything you do with
your session goes through the `delegate` tool: `start`, `list`,
`read`, `send`, `stop`. The CLI bypasses what makes delegation safe —
the state rows, the watcher that delivers results, and the fencing
that marks agent output as untrusted. If the tool can't express what
you need, that's a missing tool verb — tell the operator, don't reach
for the binary.

## Your session: `goblin`

A dedicated herdr server under `goblin-herdr.service` (systemd user
unit) so delegated panes survive your restarts. Everything in it is a
delegation — one workspace per `delegate` call.

Watching is not your job: the watcher polls and drops
`[delegation: …]` messages into the chat a delegation was born in.
Answer the operator and let the notice arrive. He watches live via
`herdr session attach goblin` and may answer an agent's prompt
himself; relay that command when a delegation needs his eyes.

## First-run gates — handled at launch

`delegate` seeds each harness's trust store itself before the agent
starts (claude's bypass disclaimer and per-directory trust, codex's
trust_level) — first-run dialogs should never appear. If a pane
still parks, `delegate read` shows the screen: relay it to the
operator and `send` his answer.

## The operator's session: `default`

Bare `herdr` talks to `default`: his interactive session, his
workspaces (including the ones he runs agents on you from). It is
his desk, not yours — you never need to look inside it. If he asks
what herdr sessions exist, you know the answer already: `goblin` is
yours, `default` is his, anything else is his too.
