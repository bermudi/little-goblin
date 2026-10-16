# Pi Durable approval gate — crash-ambiguous tool calls

Experimental integration, not service code: nothing in `src/` imports this
directory. It exists to answer one question with evidence — **can goblin's
notify-don't-retry policy (DESIGN.md → The authority rule) survive inside
Pi Durable's crash recovery?** It can, and this is the minimal mechanism.

## The gap

The authority rule: *"Boot never auto-retries a half-run turn — tool calls
aren't idempotent… If recovery is ever wanted it is notify-don't-retry:
surface the orphaned turn to the operator, don't replay it."*

Pi Durable 1.0.2 (the exact version `src/subagents.ts` pins) resolves a
crash-interrupted tool call on reopen **without any hook**
(`dist/harness/tool.js`, `execute` phase): an unsafe tool settles as
`interrupted and may have partially run` and the generation **continues on
the next model request**. The model — not the operator — decides what an
unobserved side effect meant. For computer runs that is an interrupted click
being reported to the very agent that then chooses to click again.

## The mechanism

The harness's only recovery-time re-entry point is the replay rule: tools
registered `replay: "safe"` are re-executed on reopen. `gateTool()`
(experimental/pi-approval/gate.ts) uses that deliberately:

- `"safe"` here means **safe to re-enter, never safe to repeat** — re-entry
  lands in the gate; no side effect re-runs without an operator decision.
- A task-scoped lease document (`defineDoc`, scope `"task"`) lives inside
  pi-durable's own commit line, so the ambiguity, the operator's decision,
  and a completed-but-unsettled result all survive further crashes:
  `absent → claimed → (decided →) done`.
  - `claimed` on re-entry = the ambiguity: park, ask, commit the decision
    **before** acting on it.
  - `done` on re-entry = the previous attempt finished; replay its recorded
    result without re-execution (the settle-only crash window).
  - `retry` that itself crashes mid-flight leaves a fresh `claimed` lease
    with a raised attempt count and asks again.
- The decision surface is one host callback (`ApprovalHost`), so the same
  gate serves tests, a Telegram approval message, or the app.

## The evidence

`crash.test.ts` runs a real child process over real SQLite storage,
SIGKILLs it mid-dispatch (a marker file proves the dispatch), then reopens
the storage in the test process and resumes — five scenarios:

| Test | Evidence |
| --- | --- |
| baseline (no gate) | interrupted result auto-committed, model asked again, **zero operator involvement** — the gap, reproduced |
| gate + interrupted | run parks (no model call, no re-execution); decision lands; run continues; the operator's note reaches the model's next request |
| gate + retry | the exact call re-executes exactly once, after approval |
| gate + abort | run ends; no further model request |
| gate + second crash while parked | the undecided question is re-surfaced after another SIGKILL — never acted on |

```bash
bun test experimental/pi-approval/crash.test.ts
```

## If adopted (design/subagents.md scope)

`gateTool` composes into the existing tool-wrap chains in `src/subagents.ts`
(`withRunGuards`/`withTerminalWrap`), gated for input tools, raw for
observation tools — matching the recorded rule that observation is safe to
repeat and input never is. The `ApprovalHost` rides the existing
`needs_input`/wake path; a parked run holding a `maxRuns` slot past a
timeout should convert to a terminated `needs_input` run (the `ask_operator`
shape) — that productization step is not part of this experiment.

Re evaluation of the 2026-10-01 rejection (design/projects.md): the modality
ground still holds at the pin — pi-ai 1.0.2 user content is
`string | (TextContent | ImageContent)[]`, no PDF/file parts, which goblin's
chat engine sends natively (`src/agent/attachments.ts`). The crash-recovery
ground is now bridgeable per-tool, as demonstrated here.
