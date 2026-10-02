---
name: herdr
description: >
  Herdr — the terminal multiplexer that hosts delegated coding agents.
  Your session is `goblin`; bare `herdr` commands hit the operator's
  `default` session, not yours. Read this before running any herdr
  command.
metadata:
  version: "1.0"
  topic: delegation
---

# herdr

Herdr organizes terminals into workspaces, tabs, and panes, and
recognizes the coding agents running inside them. This file covers how
herdr fits *you* — it is not the usage guide. The CLI serves its own:

```bash
herdr --skill    # full command reference via bash
```

One warning about that guide: it's written for agents running *inside*
a herdr pane (its `HERDR_ENV=1` check, "the current session"). You are
never inside herdr — you are a client that owns one named session.

## Your session: `goblin`

A dedicated herdr server run by `goblin-herdr.service` (systemd user
unit) so delegated panes survive your restarts. Every `delegate` call
lands here — one workspace per delegation.

Always qualify when you inspect it — bare `herdr` targets `default`:

```bash
herdr --session goblin api snapshot   # every workspace/pane/agent + state
herdr --session goblin agent list     # agent names and statuses
herdr --session goblin agent read NAME --source recent-unwrapped --lines 80
herdr session list                    # every session on the machine
```

## The operator's session: `default`

Bare `herdr …` — `status`, `api snapshot`, everything — talks to
`default`: his interactive session, his workspaces (including the ones
he runs agents on you from). A bare snapshot describes *his* desk, not
your delegated work — don't report it as yours, and don't go there
unless he asks.

## Boundaries

- **Reads are fine; mutations are the delegate tool's job.** Never
  `agent start`, `workspace create`, `send-keys`, `prompt`, or `close`
  through raw bash — panes the tool didn't create are invisible to its
  lifecycle tracking, and ones it did would go stale behind its back.
- The operator watches via `herdr session attach goblin` and may answer
  an agent's prompt himself — the delegate tool returns that attach
  command; relay it when a delegation needs his eyes.
- Other sessions in `herdr session list` (his side sessions, probes)
  are not yours unless he says so.
