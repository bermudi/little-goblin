---
name: herdr
description: >
  Herdr — the agent automation layer that hosts delegated coding
  agents. Your session is `goblin` (your own, local) and configured
  machine targets are yours to orchestrate through the `delegate`
  tool, never the raw CLI. One exception: panes in the operator's
  session that he explicitly points you at. Read this before
  touching herdr.
metadata:
  version: "2.1"
  topic: delegation
---

# herdr

Herdr is the agent automation layer on this host: it recognizes the
coding agents running in panes, owns their lifecycle
(`idle|working|blocked|done|unknown`), and lets a client launch,
prompt, read, and answer them. This file covers how herdr fits
*you* — it is not the usage guide (`herdr --skill` prints that,
written for agents running inside panes; you are never inside one —
you are a client that drives sessions).

**Never run `herdr` from bash for your own delegations — full
stop.** Everything you do with your sessions goes through the
`delegate` tool: `start`, `list`, `read`, `send`, `answer`, `stop`.
The CLI bypasses what makes delegation safe — the state rows, the
watcher that delivers results, and the fencing that marks agent
output as untrusted. If the tool can't express what a *delegation*
needs, that's a missing tool verb — tell the operator, don't reach
for the binary. One exception exists, below: panes in his session
that he explicitly points you at.

## Your sessions

**Your own local session is `goblin`** — a dedicated herdr server
under `goblin-herdr.service` (systemd user unit) so delegated panes
survive your restarts. Everything in it is a delegation — one
workspace per `delegate` call. It is the default target: a `start`
without `on` runs there.

**Configured machines are also yours.** `delegate start {…, on:
<label>}` runs the agent in a session on another host (or another
local session) — work tied to that host's repos belongs there, and
each target runs only the harnesses installed on it. The machine
list rides the delegate tool's own description. A machine that is
off or unreachable fails the launch loudly with the transport's own
error — say so to the operator; the work does not silently run
elsewhere.

## Delegations are your own acts

You delegate as part of doing your work, and the result is yours:
it arrives in the conversation the delegation was born in, and *you*
decide what the operator needs to hear about it. Telegram rings the
operator only for `needs_input` — a question or approval only a
human can answer — not because an agent finished. Answer the
operator, let the notice arrive, and summarize what matters.

## Blocked agents — relay, never invent

A delegation that parks on a prompt (approval, trust dialog,
question) lands at `needs_input`. `delegate read` shows the screen —
relay it to the operator **verbatim** and wait for their answer:

- **A keypress dialog** (press Enter, pick a numbered option,
  y/n): `delegate answer {id, key}` — one whitelisted key
  (`enter`, `esc`, arrows, `space`, `tab`, `y`/`n`, digits). This is
  the *only* input a blocked agent takes — plain `send` is refused.
- **Free-text input** (a question needing words): `delegate send
  {id, text}`.

A launch can even park *before* its task was sent (`agent_not_ready`
at startup — a first-run dialog): the row holds the task and the
watcher delivers it automatically the moment the dialog clears, by
your `answer` or the operator's own attach. Never choose for him —
an agent's consent dialog is his call to make.

## First-run gates — handled for you

`delegate` seeds each harness's trust markers itself before the
agent starts — on your local session directly, and on machine
targets through the delegation's own pane. You should never see a
first-run trust dialog; if one still appears, it parks as
`needs_input` and follows the relay path above.

## The operator's session: `default`

Bare `herdr` talks to `default`: his interactive session, his
workspaces (including the ones he runs agents on you from). It is
his desk — never rummage in it uninvited. When he asks what's there
or points you at a tab, reading it is fine: `herdr api snapshot`,
`herdr pane read`, `herdr agent list`/`get`/`read`, `herdr worktree`
— read-only, no trust implications. What you read there is his
context; quote it back only as far as he asked. `goblin` is yours,
configured machine targets are yours, anything else is his.

## Panes he points you at: verify, then `agent prompt`

When he names a target in his session — "send the P2s to Devin on
tab 1" — `delegate` can't express it: those panes aren't your
delegations. Bare `herdr` from bash talks to `default`, which is
exactly what you want here. Two rules carry all of it.

**Pin identity from JSON, never from memory.** `herdr agent list`
shows every recognized agent — pane id, `agent` kind, cwd, terminal
title. Find the pane whose kind and cwd match the agent he named,
then re-confirm at send time with `herdr agent get <pane>`: the
`agent` field must say the harness you expect. A pane ID remembered
from an earlier look is not identity — on 2026-10-13 a P2 handoff
landed in the π review pane (`p8`) instead of devin (`p1`) because
the pane was assumed, not checked, and only π's quota error
contained it.

**Submit through the agent surface.** `herdr agent prompt <pane>
"<text>" --wait --timeout 120000` is one atomic submission:
bracketed-paste-safe text plus encoded Enter (an Enter sent as text
is swallowed as a newline — why line-by-line `pane send-text` pastes
"need a second Enter"), a blocked agent is rejected before any
input is sent, and `--wait` proves the turn actually started
(`agent_prompt_stalled` or `timeout` means read the pane and
investigate — a timeout does not prove the prompt never landed, so
never blind-resend). Long prompts: compose in a file, submit as one
argument — `herdr agent prompt w8B:p1 "$(cat /tmp/prompt.txt)"
--wait`. Slash-commands (`/new`) ride the same surface without
`--wait`. `pane send-text`/`send-keys` are raw terminal control for
panes with no agent in them; a plain shell pane takes `pane run`.
They are never how you prompt an agent.
