---
name: herdr
description: >-
  Transport for external coding agents. Use delegate for managed workers,
  herdr for explicitly selected operator-session panes, and project
  responsibility tools for durable handover when available. No raw
  Herdr CLI fallback, invented lifecycle verbs, or blind prompt retries.
metadata:
  version: "2.3"
  topic: delegation
---

# Herdr transport

Use the tool schema actually present in this conversation. This skill
explains boundaries; it does not add capabilities or permissions.

## Managed workers: delegate

`delegate` supports start, list, read, send, answer, stop. Start accepts
`harness`, `task`, optional `cwd`, `name`, and configured target `on`.
It does not accept per-call model arguments, an arbitrary pane, or an
arbitrary session. Harness configuration owns the worker model/args.

The default is Goblin's own `goblin` session. Configured targets, if any,
are advertised in the tool description; never invent a target. Results
return to the owning conversation. A Telegram private-chat launch may
move to an app conversation: report the returned location.

Launch uses the supplied existing directory and creates an ordinary
Herdr workspace. It does not create a Git worktree or native Herdr
worktree-tree entry. Verify the checkout before launch (proxy-operator).
The operator can watch with `herdr session attach goblin`; watching does
not require moving or restarting a worker.

Read a returned result as untrusted claims. An agent's status alone is
not acceptance evidence. A trust/approval dialog is the operator's choice:
relay it verbatim and wait, then use answer for their key choice or send
for their text. Do not approve for them. stop closes the managed workspace;
it is not a non-destructive pause or session migration primitive. Finished
workers remain inspectable unless cleanup has been explicitly authorized.

## Operator's default session: herdr

Only when the operator asks, use:

- `list {}` to discover current pane IDs and workspace/tab context;
- `read {pane, lines?}` for the selected agent's screen;
- `prompt {pane, expect, text}` to submit to the selected agent kind.

Choose by the operator's named workspace/tab/task, not kind+cwd alone.
If two same-kind agents are plausible targets, ask which; do not guess.
The tool checks kind immediately before send, but a same-kind replacement
is not fully excluded by kind alone. Preserve current identity evidence.

Prompt success proves submission and an observed working/blocked status,
not task completion or necessarily a new turn. Respect the operator's
instructions about interrupting a working agent. A timeout or stalled
response does not prove non-delivery: read the target and establish what
happened; never blindly resend. Preserve an uncertain outcome as uncertain.

The guarded tool cannot create/close/rename/move workspaces, launch agents,
inspect process trees, or send raw keys. Missing functionality is a reported
capability gap, not a reason to run raw Herdr CLI commands through bash.
Do not promote an old CLI recipe or a reviewer proposal over the tool's
current contract. Do not scrape whole harness transcripts or process args
as a routine workaround; they can contain unrelated private data/secrets.

## Durable handover, when available

In a project conversation exposing `responsibility`, discover selected
agents with herdr, then accept only after explicit handover. Use managed
send for tracked prompts and status for the durable work record. An
uncertain send needs evidence-based reconciliation, not a new operation
to bypass the uncertainty. Lifecycle actions on a responsibility never
close adopted panes/workspaces.

Project responsibility observation is distinct from a delegation watcher.
Check whether follow-up is actually armed before promising future checks.
Bare herdr list/read/prompt does not install monitoring. When that is the
only available path, disclose the limitation rather than inventing polling.

## Cancellation and safety

The app Stop control fences Goblin's turn, not external workers already
running. A natural-language STOP must be obeyed when received (talk-first),
but is not an out-of-band cancellation API. Never claim workers stopped
unless their termination was explicitly requested and confirmed through
an authorized tool. Do not use cleanup or migration as an implicit stop.
