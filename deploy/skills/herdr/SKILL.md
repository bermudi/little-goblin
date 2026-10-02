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

## Your session: `goblin`

A dedicated herdr server under `goblin-herdr.service` (systemd user
unit) so delegated panes survive your restarts. Everything in it is a
delegation — one workspace per `delegate` call.

**Drive it through the `delegate` tool, not the CLI.** `start`,
`list`, `read`, `send`, `stop` cover the whole lifecycle and keep the
delegation rows, the watcher, and output fencing intact. Raw
`herdr --session goblin …` via bash bypasses all three — screens come
back unfenced (agent output is untrusted data), and mutations create
panes the lifecycle can't see. Reserve raw reads (`api snapshot`,
`agent wait`) for diagnostics the tool genuinely can't express.

Watching is not your job: the watcher polls and drops
`[delegation: …]` messages into the chat a delegation was born in.
Don't block in bash waiting — answer the operator and let the notice
arrive. He watches live via `herdr session attach goblin` and may
answer an agent's prompt himself; relay that command when a
delegation needs his eyes.

## First-run gates — seed *before* `delegate`

Harnesses park on first-run dialogs that no-approval flags don't
skip. The dialog appears at launch, so seeding after `delegate` is
too late — do it via bash first. These are the operator's own state
files (panes run his shell): only ever SET flags to true, never
delete keys, and write tmp+mv so a crash can't tear the file.

**claude** — `~/.claude.json`:

- `--dangerously-skip-permissions` parks on a disclaimer until
  `bypassPermissionsModeAccepted` is true — one write, machine-wide.
- Each new cwd parks on a trust prompt until that dir's
  `projects` entry accepts — seed the delegation's resolved cwd:

```bash
D="$(realpath <cwd>)"; jq --arg d "$D" '
  .bypassPermissionsModeAccepted = true
  | .hasCompletedOnboarding = true
  | .projects[$d].hasTrustDialogAccepted = true
  | .projects[$d].hasCompletedProjectOnboarding = true
' ~/.claude.json > /tmp/claude.json && mv /tmp/claude.json ~/.claude.json
```

If a claude instance is running elsewhere it can clobber the write
when it exits — seed right before `delegate`, and if the pane still
parks, `delegate read` shows which dialog it is.

**codex** — `~/.codex/config.toml`, append per new cwd:

```toml
[projects."<abs cwd>"]
trust_level = "trusted"
```

**pi / devin / opencode** — no known first-run gates on this box.
If a pane parks anyway, `delegate read` shows the screen: relay it
to the operator and `send` his answer, or find that harness's trust
store and seed it the same way.

## The operator's session: `default`

Bare `herdr …` — `status`, `api snapshot`, everything — talks to
`default`: his interactive session, his workspaces (including the ones
he runs agents on you from). A bare snapshot describes *his* desk, not
your delegated work — don't report it as yours, and don't go there
unless he asks. `herdr session list` enumerates every session on the
machine; others besides these two are not yours unless he says so.
